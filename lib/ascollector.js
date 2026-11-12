'use strict';

// App Store 수집기.
//
// 애플은 "이 기간에 나온 앱 전체를 인기순으로" 주는 목록을 제공하지 않는다. 대신 인기 차트(무료·유료·최고 매출)를
// 종합과 카테고리별로 100위까지 준다. 그래서 여기서는 차트 순위를 그대로 싣고, 순위 변동과 새로 진입한 앱은
// 앞서 수집한 스냅샷과 비교해 보여 준다(lib/store.js). 화면에서는 출시 시기로 걸러 새 앱만 볼 수 있다.
//
// 한 번 훑을 때: 모든 차트 피드를 받고 → 거기 나온 앱의 평가 수·별점을 묶어서 조회해 → 차트마다 저장한다.
// 저장소에서 stars 자리에는 평가 수가, rank 자리에는 차트 순위가 들어간다.
// 언제 훑을지, 실패 처리, 상태 알림은 공통 뼈대(lib/sweep.js)에 있다.

const appstore = require('./appstore');
const { Store } = require('./store');
const { SweepCollector, storeConfig: sweepStoreConfig, sleep } = require('./sweep');

/** App Store용 저장소 설정(data/as/cache). */
const storeConfig = (cfg) => sweepStoreConfig(cfg, 'as');

// 애플 쪽이 아예 응답하지 않을 때 요청마다 시간 초과를 기다리다 빌드 전체가 늦어지지 않도록,
// 이만큼 잇달아 실패하면 남은 요청은 보내지 않는다.
const FEED_GIVE_UP = 8;
const LOOKUP_GIVE_UP = 3;

class AsCollector extends SweepCollector {
  constructor({ cfg, store, fetchChart = appstore.fetchChart, lookup = appstore.lookup }) {
    // 애플은 한도를 넘으면 403을 돌려주기도 한다.
    super({ cfg, store, label: 'App Store', refresh: cfg.as.refresh, limitStatuses: [403, 429] });
    this.fetchChart = fetchChart;
    this.lookup = lookup;
    // 차트 목록: 종류(무료·유료·매출)마다 [종합, 카테고리…]. 날짜와 상관없이 늘 같다.
    this.types = {};
    for (const kind of cfg.as.kinds) {
      this.types[kind] = cfg.as.genres.map(([key, label]) => ({ type: kind, key: String(key), kind: 'chart', label }));
    }
  }

  listing() {
    return this.types;
  }

  extra() {
    return { country: this.cfg.as.country };
  }

  /**
   * 모든 차트를 새로 받는다. 일부 차트만 실패하면 그 차트는 이전 순위를 그대로 두고 표시만 남긴다.
   * 차트를 하나도 못 받았으면 던진다.
   * @returns {{pages: number, buckets: number, changed: Set<string>, failed: number, apps: number, unrated: number}}
   */
  async walk() {
    const A = this.cfg.as;
    const descs = this.descs();
    let pages = 0; // 보낸 요청 수(피드 + 조회)
    const tick = () => {
      pages += 1;
      this.progress = { pages };
      this.emit('collector', this.status());
    };

    // 1) 차트 피드: 몇 개씩 동시에 받는다.
    const charts = new Map(); // id → 항목 배열 또는 Error
    const queue = [...descs];
    let streak = 0; // 잇달아 실패한 피드 수
    let lastError = null;
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        const id = Store.id(d.type, d.key);
        if (streak >= FEED_GIVE_UP) {
          charts.set(id, lastError); // 보내 봐야 실패할 것이므로 건너뛴다
          continue;
        }
        try {
          charts.set(id, await this.fetchChart({ country: A.country, kind: d.type, genre: d.key, limit: this.cfg.top }));
          streak = 0;
        } catch (err) {
          charts.set(id, err);
          streak += 1;
          lastError = err;
        }
        tick();
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, A.concurrency) }, worker));
    const errors = [...charts.values()].filter((v) => v instanceof Error);
    if (errors.length === descs.length) throw errors[0];

    // 2) 평가 수와 별점: 차트에 나온 앱을 묶어서 조회한다.
    const ids = new Set();
    for (const v of charts.values()) if (Array.isArray(v)) for (const a of v) ids.add(a.id);
    const rated = new Map();
    const all = [...ids];
    let lookupError = null;
    let lookupStreak = 0;
    for (let i = 0; i < all.length; i += A.lookupBatch) {
      const started = Date.now();
      try {
        for (const a of await this.lookup({ country: A.country, ids: all.slice(i, i + A.lookupBatch) })) rated.set(a.id, a);
        lookupStreak = 0;
      } catch (err) {
        lookupError = err;
        lookupStreak += 1;
        // 한도에 걸렸거나 잇달아 실패하면 더 부르지 않는다. 나머지는 지난번 값을 그대로 쓴다.
        if (this.limitStatuses.includes(err.status) || lookupStreak >= LOOKUP_GIVE_UP) break;
      }
      tick();
      const wait = started + A.lookupSpacing - Date.now();
      if (wait > 0 && i + A.lookupBatch < all.length) await sleep(wait);
    }
    if (lookupError) console.warn(`[App Store] 평가 수 조회 일부 실패: ${lookupError.message}`);

    // 조회하지 못한 앱은 지난번에 알던 값을 이어 쓴다(평가 수가 0으로 떨어져 "감소"로 보이지 않게).
    const known = new Map();
    for (const b of this.store.buckets.values()) for (const it of b.items) known.set(it.id, it);

    // 3) 차트마다 저장한다. 순서는 받은 그대로(차트 순위)다.
    const now = Date.now();
    const changed = new Set();
    let unrated = 0;
    for (const d of descs) {
      const id = Store.id(d.type, d.key);
      const got = charts.get(id);
      if (!Array.isArray(got)) {
        this.bucketErrors.set(id, got.message || String(got));
        continue;
      }
      this.bucketErrors.delete(id);
      const items = got.map((a) => {
        const r = rated.get(a.id) || known.get(a.id);
        if (!r) unrated += 1;
        return { ...a, stars: r ? r.stars : 0, rating: r ? r.rating : null };
      });
      if (this.store.update(d, { items, total: null, totalAt: now, pages: 1 }, now).changed) changed.add(id);
    }
    return { pages, buckets: descs.length, changed, failed: errors.length, apps: all.length, unrated };
  }
}

module.exports = { AsCollector, storeConfig };
