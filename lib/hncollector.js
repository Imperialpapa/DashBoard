'use strict';

// Hacker News 수집기.
//
// 검색 API가 올라온 시각으로 범위를 걸고 점수순으로 돌려주므로, GitHub처럼 기간마다 한 번씩 부르면 된다.
// GitHub과 달리 한도가 넉넉해(차례를 세워 아껴 쓸 필요가 없다) 받을 때가 된 기간을 한꺼번에 몇 개씩 동시에 받는다.
// 지난 기간의 점수는 거의 변하지 않으므로, 끝난 기간은 GitHub과 같은 주기(lib/periods.js의 interval)로만 다시 확인한다.
//
// 언제 훑을지, 실패 처리, 상태 알림은 공통 뼈대(lib/sweep.js)에 있다.

const periods = require('./periods');
const { searchStories } = require('./hn');
const { Store } = require('./store');
const { SweepCollector, storeConfig: sweepStoreConfig, fetchAll } = require('./sweep');

/** Hacker News용 저장소 설정(data/hn/cache). */
const storeConfig = (cfg) => sweepStoreConfig(cfg, 'hn');

class HnCollector extends SweepCollector {
  constructor({ cfg, store, search = searchStories }) {
    super({ cfg, store, label: 'Hacker News', refresh: cfg.hn.refresh });
    this.search = search;
    // 기간 목록은 GitHub과 같은 규칙으로 만들되 길이와 시작 연도만 다르다. 목록에 있는 기간은 모두 받는다.
    this.periodCfg = { listed: cfg.hn.listed, eager: cfg.hn.listed, firstYear: cfg.hn.firstYear };
    this.types = {};
    this.lastDay = '';
  }

  /** 오늘 기준 기간 목록: { weekly: […], monthly: […], yearly: […] } */
  listing(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.lastDay) {
      this.lastDay = day;
      for (const type of periods.TYPES) this.types[type] = periods.list(type, now, this.periodCfg);
    }
    return this.types;
  }

  /** 이 기간을 지금 다시 받을지: 아직 없거나, 진행 중인 기간이거나, 끝난 기간인데 다시 확인할 때가 됐으면. */
  due(desc, now) {
    const b = this.store.get(desc.type, desc.key);
    if (!b || desc.kind !== 'closed') return true;
    return now - b.fetchedAt >= periods.interval(desc, now, this.cfg);
  }

  /**
   * 받을 때가 된 기간을 모두 새로 받는다. 일부만 실패하면 그 기간은 이전 순위를 그대로 두고 표시만 남긴다.
   * 하나도 못 받았으면 던진다.
   * @returns {{pages: number, buckets: number, changed: Set<string>, failed: number, skipped: number}}
   */
  async walk() {
    const started = Date.now();
    const all = this.descs(started);
    const due = all.filter((d) => this.due(d, started));
    let pages = 0;

    const got = await fetchAll(due, (d) => this.search({ from: d.from, to: d.to, limit: this.cfg.top }), {
      concurrency: this.cfg.hn.concurrency,
      onDone: () => {
        pages += 1;
        this.progress = { pages, of: due.length };
        this.emit('collector', this.status());
      },
    });
    const errors = got.filter((v) => v instanceof Error);
    if (due.length && errors.length === due.length) throw errors[0];

    const now = Date.now();
    const changed = new Set();
    due.forEach((d, i) => {
      const id = Store.id(d.type, d.key);
      const r = got[i];
      if (r instanceof Error) {
        this.bucketErrors.set(id, r.message || String(r));
        return;
      }
      this.bucketErrors.delete(id);
      if (this.store.update(d, { items: r.items, total: r.total, totalAt: now, pages: 1 }, now).changed) changed.add(id);
    });
    return { pages, buckets: due.length, changed, failed: errors.length, skipped: all.length - due.length };
  }
}

module.exports = { HnCollector, storeConfig };
