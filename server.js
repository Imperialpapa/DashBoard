'use strict';

// 로컬 서버 방식: 백그라운드 수집기를 돌리면서 화면에 실시간으로 밀어 준다.
// 화면이 읽는 주소(data/meta.json, data/<type>.<key>.json)는 정적 사이트 빌드(lib/build.js)가
// 써 내는 파일과 같아서, 같은 화면 코드가 두 방식 모두에서 돈다. 서버 방식에만 있는 것은
// 실시간 스트림(api/events)과 수동 갱신(api/refresh)이다.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const periods = require('./lib/periods');

const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const CHART_PATH = new RegExp(`^/data/(${periods.TYPES.join('|')})\\.([\\w-]+)\\.json$`);

/** HTTP 서버를 만든다(아직 듣지는 않는다). */
function createApp({ store, collector }) {
  // ── 실시간 푸시(SSE) ─────────────────────────────────────────────
  const clients = new Set();

  function push(event, data) {
    if (clients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  const meta = () => ({ ...collector.meta(), live: true });

  collector.on('bucket', (status, changed) => push('bucket', { ...status, changed }));

  // 수집기 상태는 자주 바뀌므로 0.5초에 한 번만 내보낸다.
  let statusTimer = null;
  collector.on('collector', () => {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      push('collector', collector.status());
    }, 500);
    statusTimer.unref();
  });

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
    collector.setViewers(clients.size);
    req.on('close', () => {
      clients.delete(res);
      collector.setViewers(clients.size);
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

  function sendChart(req, res, type, key) {
    const touched = collector.request(type, key); // 오래됐으면 뒤에서 갱신을 건다(화면은 기다리지 않는다)
    if (!touched.ok) return sendJson(req, res, 404, { error: '없는 기간입니다' });

    const b = store.get(type, key);
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
        if (wantsGzip(req) && entry[1] !== 'image/svg+xml') {
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
      if (chart) return sendChart(req, res, chart[1], chart[2]);
      return sendStatic(req, res, pathname);
    }

    if (req.method === 'POST' && pathname === '/api/refresh') {
      // 다른 사이트의 페이지가 이 로컬 서버를 대신 호출하지 못하게 한다.
      if (!sameOrigin(req)) return sendJson(req, res, 403, { error: 'forbidden' });
      const type = url.searchParams.get('type') || '';
      const key = url.searchParams.get('key') || '';
      const result = collector.request(type, key, { force: true });
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
  const { server, close } = createApp({ store, collector });

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
    const s = collector.status();
    console.log(`GitHub 베스트 대시보드  http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
    console.log(`  캐시에서 불러온 기간 ${cached}개, 새로 받을 기간 ${s.missing}개`);
    console.log(`  GitHub 인증: ${s.authenticated ? '토큰 사용(검색 분당 30회)' : '없음(검색 분당 10회)'}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      collector.stop();
      close();
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
}

if (require.main === module) main();

module.exports = { createApp };
