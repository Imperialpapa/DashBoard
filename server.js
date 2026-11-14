'use strict';

// 로컬 서버 방식: 백그라운드 수집기를 돌리면서 화면에 실시간으로 밀어 준다.
// 화면이 읽는 주소(data/meta.json, data/<type>.<key>.json, data/<출처>/<type>.<key>.json)는 정적 사이트 빌드
// (lib/build.js)가 써 내는 파일과 같아서, 같은 화면 코드가 두 방식 모두에서 돈다. 서버 방식에만 있는 것은
// 실시간 스트림(api/events)과 수동 갱신(api/refresh)이다.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const registry = require('./lib/sources');

const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  // 홈 화면에 추가: 이름·아이콘 목록과 아이콘들
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/icon-maskable-512.png': ['icon-maskable-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};
// data/<종류>.<키>.json (GitHub), data/<출처>/<종류>.<키>.json (hf, hn, as …). 종류와 키가 실제로 있는지는 수집기가 판단한다.
const CHART_PATH = new RegExp(`^/data/(?:(${registry.NAMES.join('|')})/)?([a-z]+)\\.([\\w-]+)\\.json$`);

/**
 * HTTP 서버를 만든다(아직 듣지는 않는다).
 * @param {object} o
 * @param {object} o.store, o.collector GitHub 쪽 저장소와 수집기
 * @param {Object<string, {store: object, collector: object}>} [o.extra] 덧붙는 출처(lib/sources.js의 이름 → 저장소와 수집기).
 *   여기에 없는 출처는 그 탭 없이 돈다
 */
function createApp({ store, collector, extra = {} }) {
  // 출처별 저장소와 수집기. 화면은 GitHub을 'gh'로, 나머지는 lib/sources.js의 이름(hf, hn, as)으로 부른다.
  const sources = { gh: { store, collector }, ...extra };

  // ── 실시간 푸시(SSE) ─────────────────────────────────────────────
  const clients = new Set();

  function push(event, data) {
    if (clients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  // GitHub 것은 바로 아래에, 나머지 출처는 그 이름 아래에 싣는다(정적 사이트의 meta.json과 같은 모양).
  const meta = () => {
    const m = { ...collector.meta(), live: true };
    for (const [src, s] of Object.entries(sources)) if (src !== 'gh') m[src] = s.collector.meta();
    return m;
  };

  for (const [src, s] of Object.entries(sources)) {
    s.collector.on('bucket', (status, changed) => push('bucket', { ...status, changed, src }));

    // 수집기 상태는 자주 바뀌므로 0.5초에 한 번만 내보낸다.
    let statusTimer = null;
    s.collector.on('collector', () => {
      if (statusTimer) return;
      statusTimer = setTimeout(() => {
        statusTimer = null;
        push('collector', { ...s.collector.status(), src });
      }, 500);
      statusTimer.unref();
    });
  }

  const setViewers = (n) => {
    for (const s of Object.values(sources)) s.collector.setViewers(n);
  };

  const pinger = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 20_000);
  pinger.unref();

  function openStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\nevent: hello\ndata: ${JSON.stringify(meta())}\n\n`);
    clients.add(res);
    setViewers(clients.size);
    req.on('close', () => {
      clients.delete(res);
      setViewers(clients.size);
    });
  }

  // ── 응답 도우미 ──────────────────────────────────────────────────
  const wantsGzip = (req) => /\bgzip\b/.test(req.headers['accept-encoding'] || '');

  function sendJson(req, res, status, obj) {
    let body = Buffer.from(JSON.stringify(obj));
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (body.length > 1024 && wantsGzip(req)) {
      body = zlib.gzipSync(body);
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(status, headers);
    res.end(body);
  }

  function sendChart(req, res, source, type, key) {
    const touched = source.collector.request(type, key); // 오래됐으면 뒤에서 갱신을 건다(화면은 기다리지 않는다)
    if (!touched.ok) return sendJson(req, res, 404, { error: '없는 기간입니다' });

    const b = source.store.get(type, key);
    if (!b) return sendJson(req, res, 202, { pending: true });

    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      ETag: b.etag,
      Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === b.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const gz = wantsGzip(req);
    if (gz) headers['Content-Encoding'] = 'gzip';
    const body = gz ? b.gz : b.body;
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(body);
  }

  function sendStatic(req, res, pathname) {
    const entry = STATIC[pathname];
    if (!entry) return sendJson(req, res, 404, { error: 'not found' });
    const file = path.join(PUBLIC, entry[0]);
    fs.stat(file, (err, st) => {
      if (err) return sendJson(req, res, 404, { error: 'not found' });
      const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
      const headers = { 'Content-Type': entry[1], 'Cache-Control': 'no-cache', ETag: etag, Vary: 'Accept-Encoding' };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      fs.readFile(file, (readErr, raw) => {
        if (readErr) return sendJson(req, res, 500, { error: 'read failed' });
        let body = raw;
        if (wantsGzip(req) && !entry[1].startsWith('image/')) {
          body = zlib.gzipSync(raw);
          headers['Content-Encoding'] = 'gzip';
        }
        headers['Content-Length'] = body.length;
        res.writeHead(200, headers);
        res.end(body);
      });
    });
  }

  // ── 라우팅 ───────────────────────────────────────────────────────
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(req, res, 400, { error: 'bad request' });
    }
    const { pathname } = url;

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (pathname === '/api/events' && req.method === 'GET') return openStream(req, res);
      if (pathname === '/data/meta.json') return sendJson(req, res, 200, meta());
      const chart = CHART_PATH.exec(pathname);
      if (chart) {
        const source = sources[chart[1] || 'gh'];
        if (!source) return sendJson(req, res, 404, { error: 'not found' });
        return sendChart(req, res, source, chart[2], chart[3]);
      }
      return sendStatic(req, res, pathname);
    }

    if (req.method === 'POST' && pathname === '/api/refresh') {
      // 다른 사이트의 페이지가 이 로컬 서버를 대신 호출하지 못하게 한다.
      if (!sameOrigin(req)) return sendJson(req, res, 403, { error: 'forbidden' });
      const type = url.searchParams.get('type') || '';
      const key = url.searchParams.get('key') || '';
      const source = sources[url.searchParams.get('src') || 'gh'];
      const result = source ? source.collector.request(type, key, { force: true }) : { ok: false, reason: 'invalid' };
      return sendJson(req, res, result.ok ? 202 : result.reason === 'invalid' ? 404 : 429, result);
    }

    sendJson(req, res, 405, { error: 'method not allowed' });
  });

  const close = () => {
    clearInterval(pinger);
    for (const res of clients) res.end();
    server.close();
  };
  return { server, close };
}

function main() {
  const cfg = require('./config');
  const { Store } = require('./lib/store');
  const { Collector } = require('./lib/collector');

  const store = new Store(cfg);
  const cached = store.load();
  const collector = new Collector({ cfg, store });

  // 덧붙는 출처(설정에서 켜 둔 것만): 캐시를 불러온 뒤 수집기를 만든다.
  const extra = {};
  for (const [name, s] of Object.entries(registry.create(cfg))) {
    s.store.load();
    extra[name] = { store: s.store, collector: s.make() };
  }
  const { server, close } = createApp({ store, collector, extra });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`포트 ${cfg.port}을(를) 이미 다른 프로그램이 쓰고 있습니다. PORT 환경 변수로 다른 포트를 지정하세요.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });

  server.listen(cfg.port, cfg.host, () => {
    collector.start();
    for (const x of Object.values(extra)) x.collector.start();
    const s = collector.status();
    console.log(`GitHub 베스트 대시보드  http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
    console.log(`  캐시에서 불러온 기간 ${cached}개, 새로 받을 기간 ${s.missing}개`);
    console.log(`  GitHub 인증: ${s.authenticated ? '토큰 사용(검색 분당 30회)' : '없음(검색 분당 10회)'}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      collector.stop();
      for (const x of Object.values(extra)) x.collector.stop();
      close();
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
}

if (require.main === module) main();

module.exports = { createApp };
