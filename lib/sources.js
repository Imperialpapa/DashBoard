'use strict';

// GitHub 말고 덧붙는 출처의 목록.
//
// 이름이 곧 화면 주소의 앞머리(#hn/weekly/rolling), data/ 아래 폴더(data/hn/), meta.json의 키(meta.hn)다.
//   hf  Hugging Face 모델    hfs  Hugging Face Space    hfd  Hugging Face 데이터셋
//   hn  Hacker News          as   App Store
// 서버(server.js)와 정적 사이트 빌드(lib/build.js)가 이 목록으로 저장소와 수집기를 만든다.
// 새 출처를 더하려면 수집기를 만들고 여기에 한 줄 넣은 뒤, 화면(public/app.js의 SOURCES)에 낱말을 적는다.
//
// 분야별 순위(lib/categories.js)도 여기서 만든다. 분야 × 출처마다 출처가 하나씩 더 생기고, 이름은 "<출처>_<분야>"다
// (gh_robotics, hf_agents, hn_agents …). GitHub의 분야별 순위(gh_…)도 여기에 든다.

const path = require('node:path');
const periods = require('./periods');
const categories = require('./categories');
const { Store } = require('./store');
const { storeConfig } = require('./sweep');
const { Collector, Gate } = require('./collector');
const { HfCollector, LABELS: HF_LABELS } = require('./hfcollector');
const { HnCollector } = require('./hncollector');
const { AsCollector } = require('./ascollector');

// 배포본의 목록에 적힌 이름을 파일 이름으로 쓰기 전에 형식을 검증하는 규칙.
const periodKey = (type, key) => Boolean(periods.describe(type, key, Date.now(), 1970)); // weekly/2026-W05 같은 기간
const chartKey = (type, key) => /^[a-z]+$/.test(type) && /^[\w-]+$/.test(key); // free/6014 같은 차트

// Hugging Face는 종류마다 출처가 하나씩이다(모델 hf, Space hfs, 데이터셋 hfd). 설정의 hf.kinds에 든 것만 켠다.
const hugging = (kind) => ({
  on: (cfg) => Boolean(cfg.hf) && (cfg.hf.kinds || ['models']).includes(kind),
  make: (cfg, store, api) => new HfCollector({ cfg, store, kind, ...(api ? { list: api } : {}) }),
  validKey: periodKey,
  group: 'hf',
});

//   on(cfg)              설정에서 켜져 있는지
//   make(cfg, store, api) 수집기를 만든다. api는 바깥 API를 부르는 함수를 바꿔 끼울 때 쓴다(시험용)
//   validKey(type, key)   이 출처의 종류·키로 올 수 있는 형식인지
//   group                 같은 서비스의 요청 한도를 나눠 쓰는 출처끼리 같은 이름(빌드가 이들을 동시에 받지 않고 차례로 받는다)
const SOURCES = {
  hf: hugging('models'),
  hfs: hugging('spaces'),
  hfd: hugging('datasets'),
  hn: {
    on: (cfg) => Boolean(cfg.hn),
    make: (cfg, store, api) => new HnCollector({ cfg, store, ...(api ? { search: api } : {}) }),
    validKey: periodKey,
  },
  as: {
    on: (cfg) => Boolean(cfg.as),
    make: (cfg, store, api) => new AsCollector({ cfg, store, ...(api || {}) }),
    validKey: chartKey,
  },
};

const NAMES = Object.keys(SOURCES);

// Hugging Face의 분야별 순위: 태그마다, 이름에 든 글자마다 목록을 따로 훑는다.
const huggingBy = (base, kind) => ({
  on: (cfg) => SOURCES[base].on(cfg),
  terms: (cat) => [...cat.hf.tags.map((filter) => ({ filter })), ...cat.hf.search.map((search) => ({ search }))],
  info: (cat) => ({ tags: cat.hf.tags, terms: cat.hf.search }),
  store: (cfg, name) => new Store(storeConfig(cfg, name)),
  make: ({ cfg, store, api, terms, cat, category }) =>
    new HfCollector({ cfg, store, kind, terms, category, label: `${HF_LABELS[kind]}(${cat.label})`, ...(api ? { list: api } : {}) }),
  group: 'hf',
});

// 분야를 둘 수 있는 출처(기간으로 나누는 출처 모두)와, 그 분야 × 출처의 수집기를 만드는 법.
//   on(cfg)     그 출처가 켜져 있는지             terms(cat) 이 출처에서 그 분야를 가리는 조건들. 비어 있으면 이 출처에는 그 분야가 없다
//   info(cat)   화면에 알려 줄 낱말(meta의 category에 싣는다)
//   store(cfg, name), make({…})  저장소와 수집기   group  요청 한도를 나눠 쓰는 묶음
// 수집기는 그 출처의 것을 그대로 쓰고, 분야의 조건만 넘긴다. api는 그 출처에 바꿔 끼운 호출 함수를 함께 쓴다(시험용).
const BY_CATEGORY = {
  gh: {
    on: () => true,
    terms: (cat) => cat.github,
    info: (cat) => ({ terms: cat.github }),
    store: (cfg, name) => new Store({ ...cfg, dataDir: path.join(cfg.dataDir, name) }), // GitHub 저장소이므로 스팸 의심 규칙도 그대로 쓴다
    make: ({ cfg, store, api, terms, cat, category, gate }) =>
      new Collector({ cfg, store, gate, match: categories.githubQuery(terms), label: `GitHub(${cat.label})`, extra: { category }, ...(api ? { search: api } : {}) }),
    group: 'gh',
  },
  hf: huggingBy('hf', 'models'),
  hfs: huggingBy('hfs', 'spaces'),
  hfd: huggingBy('hfd', 'datasets'),
  hn: {
    on: (cfg) => Boolean(cfg.hn),
    terms: (cat) => cat.hn,
    info: (cat) => ({ terms: cat.hn }),
    store: (cfg, name) => new Store(storeConfig(cfg, name)),
    make: ({ cfg, store, api, terms, cat, category }) =>
      new HnCollector({ cfg, store, terms, category, label: `Hacker News(${cat.label})`, ...(api ? { search: api } : {}) }),
    group: 'hn',
  },
};

/**
 * 설정에서 켜 둔 출처마다 저장소를 만들고, 수집기를 만드는 함수를 붙여 돌려준다.
 * 수집기는 저장소를 채운 뒤(load) 만들어야 해서 바로 만들지 않는다.
 * 분야별 순위(config.js의 categories)가 있으면 분야 × 출처마다 하나씩 뒤에 덧붙는다.
 * @param {object} cfg
 * @param {object} [api] 출처 이름 → 바꿔 끼울 호출 함수(시험용). 분야별 수집기는 그 출처의 것을 함께 쓴다(GitHub은 api.gh)
 * @param {object} [o]
 * @param {Gate} [o.gate] GitHub 검색 한도를 함께 볼 것. 분야별 GitHub 수집기가 GitHub 수집기와 한도를 나눠 쓰도록 같은 것을 넘긴다
 * @returns {Object<string, {store: Store, make: () => object, group: string}>} group이 'gh'인 것은 GitHub 수집기와 함께 받는다
 */
function create(cfg, api = {}, { gate = null } = {}) {
  const out = {};
  // 같은 묶음(group)의 수집기는 한 번에 하나만 훑는다(lib/sweep.js의 lane). GitHub 쪽은 Gate가 그 일을 한다.
  const lanes = {};
  const inLane = (group, make) => () => {
    const collector = make();
    if (group !== 'gh') collector.lane = lanes[group] || (lanes[group] = { busy: null });
    return collector;
  };
  for (const name of NAMES) {
    const def = SOURCES[name];
    if (!def.on(cfg)) continue;
    const store = new Store(storeConfig(cfg, name));
    const group = def.group || name;
    out[name] = { store, make: inLane(group, () => def.make(cfg, store, api[name])), group };
  }

  const cats = categories.all(cfg);
  if (!cats.length) return out;
  const conf = categories.config(cfg);
  const shared = gate || new Gate(cfg.token);
  for (const cat of cats) {
    for (const [base, def] of Object.entries(BY_CATEGORY)) {
      const terms = def.terms(cat);
      if (!def.on(cfg) || !terms.length) continue;
      const name = categories.name(base, cat.id);
      const store = def.store(conf, name);
      const category = { id: cat.id, label: cat.label, ...def.info(cat) };
      out[name] = { store, make: inLane(def.group, () => def.make({ cfg: conf, store, api: api[base], terms, cat, category, gate: shared })), group: def.group };
    }
  }
  return out;
}

/** 그 출처의 종류·키로 올 수 있는 형식인지('gh'는 GitHub). 분야별 순위(gh_robotics …)는 그 출처의 규칙을 따른다. */
function validKey(name, type, key) {
  const { base, cat } = categories.split(name);
  if (cat && (!BY_CATEGORY[base] || !categories.ID.test(cat))) return false;
  if (base === 'gh') return periodKey(type, key);
  return Boolean(SOURCES[base]) && SOURCES[base].validKey(type, key);
}

module.exports = { NAMES, create, validKey };
