'use strict';

// 정적 사이트 빌드.
//
// 서버를 띄워 둘 수 없는 곳(GitHub Pages 등)을 위한 방식이다. 한 번 실행하면
//   1) 지난번에 배포한 사이트에서 수집 상태(순위와 스냅샷 이력)를 내려받아 이어서 시작하고
//   2) 받을 때가 된 기간을 GitHub 검색 API로 받아 온 뒤
//   3) 화면 파일(public/)과 순위 JSON을 한 폴더에 써 낸다.
// 그 폴더를 그대로 정적 호스팅에 올리면 된다. 이것을 일정 간격으로 되풀이한다.
//
// 써 내는 것:
//   <out>/index.html, app.js, …        화면
//   <out>/data/meta.json               기간 목록과 상태 (live: false)
//   <out>/data/<type>.<key>.json       기간별 순위(화면이 읽는다)
//   <out>/data/state/<type>.<key>.json 기간별 수집 상태(다음 빌드가 읽는다)

const fs = require('node:fs');
const path = require('node:path');
const periods = require('./periods');
const { Store } = require('./store');
const { Collector } = require('./collector');

const PUBLIC = path.join(__dirname, '..', 'public');

/**
 * 지난번 배포본에서 수집 상태를 내려받아 캐시 폴더에 채운다.
 * 아직 배포한 적이 없으면(404) 빈 상태로 시작한다. 그 밖의 실패는 던진다:
 * 일시적인 통신 오류 때문에 쌓아 온 이력을 버리고 빈 사이트로 덮어쓰지 않기 위해서다.
 * @returns {number} 내려받은 기간 수
 */
async function seed(baseUrl, cacheDir, { fetchImpl = fetch, log = () => {} } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const get = async (rel) => {
    const res = await fetchImpl(`${base}/${rel}`, { headers: { 'User-Agent': 'github-best-dashboard' }, cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    return res.text();
  };

  const metaText = await get('data/meta.json');
  if (metaText === null) {
    log('이전 배포본이 없어 처음부터 받습니다');
    return 0;
  }
  const meta = JSON.parse(metaText);
  const wanted = [];
  for (const type of periods.TYPES) {
    for (const b of (meta.types && meta.types[type]) || []) {
      if (b.hasData && periods.describe(type, b.key)) wanted.push(`${type}.${b.key}.json`); // describe로 키 형식을 검증한다
    }
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  let done = 0;
  const queue = [...wanted];
  const worker = async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      const text = await get(`data/state/${name}`);
      if (text === null) continue; // 목록에는 있는데 파일이 없으면 그 기간만 새로 받는다
      JSON.parse(text); // 깨진 파일이면 여기서 멈춘다
      fs.writeFileSync(path.join(cacheDir, name), text);
      done += 1;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  log(`이전 배포본에서 ${done}개 기간의 상태를 이어받았습니다`);
  return done;
}

/** 수집 결과와 화면 파일을 out 폴더에 써 낸다. */
function write(out, { cfg, store, collector, now }) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(PUBLIC, out, { recursive: true });
  const dataDir = path.join(out, 'data');
  const stateDir = path.join(dataDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const meta = collector.meta(now);
  let written = 0;
  for (const type of periods.TYPES) {
    for (const entry of meta.types[type]) {
      const b = store.get(type, entry.key);
      if (!b) continue;
      const name = `${type}.${entry.key}.json`;
      fs.writeFileSync(path.join(dataDir, name), b.body);
      fs.copyFileSync(store.file(type, entry.key), path.join(stateDir, name));
      written += 1;
    }
  }
  // live: false → 화면이 실시간 연결 대신 이 파일을 주기적으로 다시 읽는다.
  fs.writeFileSync(path.join(dataDir, 'meta.json'), JSON.stringify({ ...meta, live: false, builtAt: now, every: cfg.static.every }));
  return written;
}

/**
 * @param {object} o
 * @param {object} o.cfg       config.js 내용
 * @param {string} o.out       써 낼 폴더
 * @param {string} [o.seedUrl] 지난번 배포본 주소(없으면 cfg.dataDir의 로컬 캐시만 쓴다)
 * @param {Function} [o.search] 검색 함수(시험용)
 */
async function build({ cfg, out, seedUrl = '', search, fetchImpl, log = console.log }) {
  // 정적 사이트에는 "열 때 받아 오기"가 없으므로 목록에 있는 기간을 모두 미리 받는다.
  const conf = { ...cfg, eager: { weekly: cfg.listed.weekly, monthly: cfg.listed.monthly } };
  const store = new Store(conf);
  if (seedUrl) await seed(seedUrl, store.dir, { fetchImpl, log });
  const loaded = store.load();

  const collector = new Collector(search ? { cfg: conf, store, search } : { cfg: conf, store });
  collector.viewers = 1; // 주기를 늘리지 않는다(빌드 간격이 이미 충분히 길다)
  const started = Date.now();
  const { ran, failed, left } = await collector.drain(started + conf.static.budget);

  const now = Date.now();
  const written = write(out, { cfg: conf, store, collector, now });
  log(`기간 ${written}개를 써 냈습니다 (이어받음 ${loaded}, 이번에 확인 ${ran}, 실패 ${failed}, 다음으로 미룸 ${left}, ${Math.round((now - started) / 1000)}초)`);
  if (collector.lastError) log(`마지막 오류: ${collector.lastError.bucket} ${collector.lastError.message}`);

  // 하나도 없으면 빈 사이트로 덮어쓰지 않도록 실패로 끝낸다.
  if (written === 0) throw new Error('받아 온 순위가 하나도 없습니다');
  return { written, loaded, ran, failed, left };
}

module.exports = { build, seed, write };
