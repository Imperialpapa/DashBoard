'use strict';

// GitHub 말고 덧붙는 출처의 목록.
//
// 이름이 곧 화면 주소의 앞머리(#hn/weekly/rolling), data/ 아래 폴더(data/hn/), meta.json의 키(meta.hn)다.
// 서버(server.js)와 정적 사이트 빌드(lib/build.js)가 이 목록으로 저장소와 수집기를 만든다.
// 새 출처를 더하려면 수집기를 만들고 여기에 한 줄 넣은 뒤, 화면(public/app.js의 SOURCES)에 낱말을 적는다.

const periods = require('./periods');
const { Store } = require('./store');
const { storeConfig } = require('./sweep');
const { HfCollector } = require('./hfcollector');
const { HnCollector } = require('./hncollector');
const { AsCollector } = require('./ascollector');

// 배포본의 목록에 적힌 이름을 파일 이름으로 쓰기 전에 형식을 검증하는 규칙.
const periodKey = (type, key) => Boolean(periods.describe(type, key, Date.now(), 1970)); // weekly/2026-W05 같은 기간
const chartKey = (type, key) => /^[a-z]+$/.test(type) && /^[\w-]+$/.test(key); // free/6014 같은 차트

//   on(cfg)              설정에서 켜져 있는지
//   make(cfg, store, api) 수집기를 만든다. api는 바깥 API를 부르는 함수를 바꿔 끼울 때 쓴다(시험용)
//   validKey(type, key)   이 출처의 종류·키로 올 수 있는 형식인지
const SOURCES = {
  hf: {
    on: (cfg) => Boolean(cfg.hf),
    make: (cfg, store, api) => new HfCollector({ cfg, store, ...(api ? { list: api } : {}) }),
    validKey: periodKey,
  },
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

/**
 * 설정에서 켜 둔 출처마다 저장소를 만들고, 수집기를 만드는 함수를 붙여 돌려준다.
 * 수집기는 저장소를 채운 뒤(load) 만들어야 해서 바로 만들지 않는다.
 * @param {object} cfg
 * @param {object} [api] 출처 이름 → 바꿔 끼울 호출 함수(시험용)
 * @returns {Object<string, {store: Store, make: () => object}>}
 */
function create(cfg, api = {}) {
  const out = {};
  for (const name of NAMES) {
    const def = SOURCES[name];
    if (!def.on(cfg)) continue;
    const store = new Store(storeConfig(cfg, name));
    out[name] = { store, make: () => def.make(cfg, store, api[name]) };
  }
  return out;
}

/** 그 출처의 종류·키로 올 수 있는 형식인지('gh'는 GitHub). */
function validKey(name, type, key) {
  if (name === 'gh') return periodKey(type, key);
  return Boolean(SOURCES[name]) && SOURCES[name].validKey(type, key);
}

module.exports = { NAMES, create, validKey };
