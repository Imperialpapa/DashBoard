'use strict';

// 정적 사이트 빌드.
//
// 서버를 띄워 둘 수 없는 곳(GitHub Pages 등)을 위한 방식이다. 한 번 실행하면
//   1) 지난번에 배포한 사이트에서 수집 상태(순위와 스냅샷 이력)를 내려받아 이어서 시작하고
//   2) 받을 때가 된 기간을 GitHub 검색 API로 받고, Hugging Face 모델 목록과 App Store 차트를 한 번씩 훑은 뒤
//   3) 화면 파일(public/)과 순위 JSON을 한 폴더에 써 낸다.
// 그 폴더를 그대로 정적 호스팅에 올리면 된다. 이것을 일정 간격으로 되풀이한다.
//
// 써 내는 것:
//   <out>/index.html, app.js, …           화면
//   <out>/data/meta.json                  기간 목록과 상태 (live: false). 덧붙는 출처의 것은 hf, as 아래에 든다
//   <out>/data/<type>.<key>.json          GitHub 기간별 순위(화면이 읽는다)
//   <out>/data/state/<type>.<key>.json    GitHub 기간별 수집 상태(다음 빌드가 읽는다)
//   <out>/data/hf/…, <out>/data/as/…      Hugging Face 기간별 순위, App Store 차트(같은 구조: 순위 파일 + state/)

const fs = require('node:fs');
const path = require('node:path');
const periods = require('./periods');
const { Store } = require('./store');
const { Collector } = require('./collector');
const { HfCollector, storeConfig: hfStoreConfig } = require('./hfcollector');
const { AsCollector, storeConfig: asStoreConfig } = require('./ascollector');

const PUBLIC = path.join(__dirname, '..', 'public');

// GitHub 말고 덧붙는 출처. 화면과 주소에서 쓰는 이름(hf, as)이 곧 data/ 아래 폴더 이름이다.
const EXTRA = ['hf', 'as'];

// 배포본의 목록에 적힌 이름을 파일 이름으로 쓰기 전에 형식을 검증한다.
const validKey = {
  gh: (type, key) => Boolean(periods.describe(type, key)),
  hf: (type, key) => Boolean(periods.describe(type, key)),
  as: (type, key) => /^[a-z]+$/.test(type) && /^[\w-]+$/.test(key),
};

/**
 * 지난번 배포본에서 수집 상태를 내려받아 캐시 폴더에 채운다.
 * 아직 배포한 적이 없으면(404) 빈 상태로 시작한다. 그 밖의 실패는 던진다:
 * 일시적인 통신 오류 때문에 쌓아 온 이력을 버리고 빈 사이트로 덮어쓰지 않기 위해서다.
 * @param {{gh: string, hf?: string, as?: string}} dirs 출처별 캐시 폴더
 * @returns {{gh: number, hf: number, as: number}} 내려받은 기간(차트) 수
 */
async function seed(baseUrl, dirs, { fetchImpl = fetch, log = () => {} } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const get = async (rel) => {
    const res = await fetchImpl(`${base}/${rel}`, { headers: { 'User-Agent': 'github-best-dashboard' }, cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    return res.text();
  };

  const done = { gh: 0, hf: 0, as: 0 };
  const metaText = await get('data/meta.json');
  if (metaText === null) {
    log('이전 배포본이 없어 처음부터 받습니다');
    return done;
  }
  const meta = JSON.parse(metaText);

  const queue = [];
  const want = (src, types, remote, dir) => {
    if (!dir || !types) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const type of Object.keys(types)) {
      for (const b of Array.isArray(types[type]) ? types[type] : []) {
        if (!b.hasData || typeof b.key !== 'string' || !validKey[src](type, b.key)) continue;
        const name = `${type}.${b.key}.json`;
        queue.push({ src, rel: `${remote}/${name}`, file: path.join(dir, name) });
      }
    }
  };
  want('gh', meta.types, 'data/state', dirs.gh);
  for (const src of EXTRA) want(src, meta[src] && meta[src].types, `data/${src}/state`, dirs[src]);

  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const text = await get(job.rel);
      if (text === null) continue; // 목록에는 있는데 파일이 없으면 그것만 새로 받는다
      JSON.parse(text); // 깨진 파일이면 여기서 멈춘다
      fs.writeFileSync(job.file, text);
      done[job.src] += 1;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  log(`이전 배포본에서 ${done.gh + done.hf + done.as}개 기간의 상태를 이어받았습니다`);
  return done;
}

/**
 * now 다음에 오는 예약 실행 시각. 화면이 "다음 수집"을 보여 주고, 그때까지는 새 판을 묻지 않는 데 쓴다.
 * 푸시나 수동 실행으로 예약 시각 사이에 빌드해도 다음 예약 시각을 가리킨다.
 * 예약 시각(at)을 모르면 간격(every)만큼 뒤로 잡는다.
 */
function nextRun(now, { every, at }) {
  if (!at || !at.hours || !at.hours.length) return now + every;
  const d = new Date(now);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const times = [];
  for (const add of [0, 86_400_000]) {
    for (const h of at.hours) times.push(day + add + h * 3_600_000 + (at.minute || 0) * 60_000);
  }
  return Math.min(...times.filter((t) => t > now));
}

/** 한 출처의 순위 파일과 수집 상태 파일을 dir 아래에 쓴다. */
function writeCharts(dir, store, meta) {
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  let written = 0;
  for (const type of Object.keys(meta.types)) {
    for (const entry of meta.types[type]) {
      const b = store.get(type, entry.key);
      if (!b) continue;
      const name = `${type}.${entry.key}.json`;
      fs.writeFileSync(path.join(dir, name), b.body);
      fs.copyFileSync(store.file(type, entry.key), path.join(stateDir, name));
      written += 1;
    }
  }
  return written;
}

/**
 * 수집 결과와 화면 파일을 out 폴더에 써 낸다.
 * @param {object} o
 * @param {object} [o.extra] 덧붙는 출처: { hf: {store, collector}, as: {store, collector} }
 * @returns {{written: number, extra: object}} extra는 출처별로 써 낸 개수
 */
function write(out, { cfg, store, collector, extra = {}, now }) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(PUBLIC, out, { recursive: true });
  const dataDir = path.join(out, 'data');

  const meta = collector.meta(now);
  const written = writeCharts(dataDir, store, meta);

  // 덧붙는 출처는 순위가 하나도 없으면(첫 수집부터 실패) meta에 넣지 않는다: 화면에 탭이 나타나지 않는다.
  const extraMeta = {};
  const extraWritten = {};
  for (const [src, s] of Object.entries(extra)) {
    const m = s.collector.meta(now);
    extraWritten[src] = writeCharts(path.join(dataDir, src), s.store, m);
    if (extraWritten[src]) extraMeta[src] = m;
  }

  // live: false → 화면이 실시간 연결 대신, 다음 수집 시각(nextAt)이 지난 뒤에 이 파일을 다시 읽는다.
  const info = { live: false, builtAt: now, every: cfg.static.every, nextAt: nextRun(now, cfg.static) };
  fs.writeFileSync(path.join(dataDir, 'meta.json'), JSON.stringify({ ...meta, ...info, ...extraMeta }));
  return { written, extra: extraWritten };
}

/**
 * @param {object} o
 * @param {object} o.cfg       config.js 내용
 * @param {string} o.out       써 낼 폴더
 * @param {string} [o.seedUrl] 지난번 배포본 주소(없으면 cfg.dataDir의 로컬 캐시만 쓴다)
 * @param {Function} [o.search] GitHub 검색 함수(시험용)
 * @param {Function} [o.hfList] Hugging Face 목록 함수(시험용)
 * @param {{fetchChart: Function, lookup: Function}} [o.asApi] App Store 호출 함수(시험용)
 */
async function build({ cfg, out, seedUrl = '', search, hfList, asApi, fetchImpl, log = console.log }) {
  const conf = {
    ...cfg,
    // 정적 사이트에는 "열 때 받아 오기"가 없으므로 목록에 있는 기간을 모두 미리 받는다.
    eager: { weekly: cfg.listed.weekly, monthly: cfg.listed.monthly },
    // 증가·순위 변동은 두 번 전 빌드(약 하루 전)와 비교한다. 예약 실행이 몇 시간 늦어도 그 스냅샷이 남아 있게 한다.
    history: { ...cfg.history, window: Math.max(cfg.history.window, 2 * cfg.static.every + 6 * 3_600_000) },
  };
  const store = new Store(conf);

  // 덧붙는 출처(설정에 있는 것만): 저장소와, 수집기를 만드는 함수
  const extra = {};
  if (conf.hf) {
    const st = new Store(hfStoreConfig(conf));
    extra.hf = { store: st, make: () => new HfCollector(hfList ? { cfg: conf, store: st, list: hfList } : { cfg: conf, store: st }) };
  }
  if (conf.as) {
    const st = new Store(asStoreConfig(conf));
    extra.as = { store: st, make: () => new AsCollector({ cfg: conf, store: st, ...(asApi || {}) }) };
  }

  const dirs = { gh: store.dir };
  for (const [src, s] of Object.entries(extra)) dirs[src] = s.store.dir;
  if (seedUrl) await seed(seedUrl, dirs, { fetchImpl, log });
  const loaded = store.load();
  for (const s of Object.values(extra)) {
    s.loaded = s.store.load();
    s.collector = s.make();
  }

  const collector = new Collector(search ? { cfg: conf, store, search } : { cfg: conf, store });
  collector.viewers = 1; // 주기를 늘리지 않는다(빌드 간격이 이미 충분히 길다)

  // 출처마다 서로 다른 API라 동시에 받는다. 덧붙는 출처가 실패해도 빌드는 계속한다:
  // GitHub 순위는 그대로 내고, 실패한 출처는 지난 배포본에서 이어받은 것이 있으면 그것을 다시 싣는다.
  const started = Date.now();
  const deadline = started + conf.static.budget;
  const drains = Object.values(extra).map((s) =>
    s.collector.drain(deadline).catch((err) => {
      log(`${s.collector.label} 수집 중 오류: ${err.message}`);
      return { ran: 0, failed: 1, left: 1 };
    }),
  );
  const [{ ran, failed, left }, ...runs] = await Promise.all([collector.drain(deadline), ...drains]);

  const now = Date.now();
  const { written, extra: extraWritten } = write(out, { cfg: conf, store, collector, extra, now });
  log(`기간 ${written}개를 써 냈습니다 (이어받음 ${loaded}, 이번에 확인 ${ran}, 실패 ${failed}, 다음으로 미룸 ${left}, ${Math.round((now - started) / 1000)}초)`);
  if (collector.lastError) log(`마지막 오류: ${collector.lastError.bucket} ${collector.lastError.message}`);

  const result = { written, loaded, ran, failed, left, hf: null, as: null };
  Object.keys(extra).forEach((src, i) => {
    const s = extra[src];
    result[src] = { written: extraWritten[src], loaded: s.loaded, ...runs[i] };
    log(`${s.collector.label}: ${extraWritten[src]}개를 써 냈습니다 (이어받음 ${s.loaded}, 요청 ${runs[i].ran}회, 실패 ${runs[i].failed})`);
    if (s.collector.lastError) log(`${s.collector.label} 마지막 오류: ${s.collector.lastError.message}`);
  });

  // 하나도 없으면 빈 사이트로 덮어쓰지 않도록 실패로 끝낸다.
  if (written === 0) throw new Error('받아 온 순위가 하나도 없습니다');
  return result;
}

module.exports = { build, seed, write, nextRun };
