'use strict';

// Hacker News 수집기.
//
// 검색 API가 올라온 시각으로 범위를 걸고 점수순으로 돌려주므로, GitHub처럼 기간마다 한 번씩 부르면 된다.
// GitHub과 달리 한도가 넉넉해(차례를 세워 아껴 쓸 필요가 없다) 받을 때가 된 기간을 한꺼번에 몇 개씩 동시에 받는다.
// 지난 기간의 점수는 거의 변하지 않으므로, 끝난 기간은 GitHub과 같은 주기(lib/periods.js의 interval)로만 다시 확인한다.
//
// 분야별 순위(lib/categories.js)는 분야마다 이 수집기를 하나씩 더 둔다. 그 분야의 낱말(terms)마다 따로 검색해
// 합친 뒤 점수순으로 다시 세운다: 낱말마다 받은 것이 그 낱말의 상위 top개이므로, 합친 것의 상위 top개가 곧 분야의 상위 top개다.
//
// 언제 훑을지, 실패 처리, 상태 알림은 공통 뼈대(lib/sweep.js)에 있다.

const periods = require('./periods');
const { searchStories } = require('./hn');
const { Store } = require('./store');
const { merge } = require('./spam');
const { SweepCollector, storeConfig: sweepStoreConfig, fetchAll, sleep } = require('./sweep');

/** Hacker News용 저장소 설정(data/hn/cache). */
const storeConfig = (cfg) => sweepStoreConfig(cfg, 'hn');

class HnCollector extends SweepCollector {
  /**
   * @param {object} o
   * @param {Function} [o.search] 검색 함수(시험용)
   * @param {string[]} [o.terms]  제목에 이 낱말이 든 글만 다룬다(분야별 순위). 없으면 모든 글
   * @param {string} [o.label]    기록과 오류 문구에 쓰는 이름
   * @param {object} [o.category] 어느 분야인지(meta에 싣는다)
   */
  constructor({ cfg, store, search = searchStories, terms = null, label = 'Hacker News', category = null }) {
    super({ cfg, store, label, refresh: cfg.hn.refresh });
    this.search = search;
    this.terms = terms && terms.length ? terms : null;
    this.category = category;
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
   * 받을 때가 된 기간을 모두 새로 받는다. 일부만 실패하면 한 번 더 받아 보고, 그래도 안 되면 그 기간은 이전 순위를
   * 그대로 두고 표시만 남긴다. 하나도 못 받았으면 던진다.
   * @returns {{pages: number, buckets: number, changed: Set<string>, failed: number, skipped: number}}
   */
  async walk() {
    const started = Date.now();
    const all = this.descs(started);
    const due = all.filter((d) => this.due(d, started));
    const { top } = this.cfg;
    const per = this.terms ? this.terms.length : 1; // 기간 하나에 보내는 검색 수
    let pages = 0;

    // 검색 한 번(성공이든 실패든 보낸 수에 넣는다).
    const ask = async (d, query) => {
      try {
        return await this.search({ from: d.from, to: d.to, limit: top, ...(query ? { query } : {}) });
      } finally {
        pages += 1;
        this.progress = { pages, of: due.length * per };
        this.emit('collector', this.status());
      }
    };
    // 한 기간의 순위. 분야별이면 낱말마다 받아 합친다(하나라도 실패하면 그 기간은 이번에 바꾸지 않는다).
    const one = async (d) => {
      if (!this.terms) return ask(d);
      const parts = [];
      for (const term of this.terms) parts.push(await ask(d, term));
      return {
        items: merge(parts.flatMap((p) => p.items), []).slice(0, top),
        total: parts.length === 1 ? parts[0].total : null, // 낱말이 여럿이면 겹치는 글이 있어 더할 수 없다
      };
    };

    const got = await fetchAll(due, one, { concurrency: this.cfg.hn.concurrency });
    // 일부만 실패했으면(검색 서버는 답하고 있다) 잠깐 쉬었다가 실패한 기간만 한 번 더 받아 본다:
    // 요청이 몰리면 한순간 몇 건이 거절당하는 일이 있고, 그대로 두면 그 기간은 다음 수집 때까지 비어 있게 된다.
    // 한도를 넘어 거절당한 것이면 다시 보내지 않는다.
    const again = due.map((_, i) => i).filter((i) => got[i] instanceof Error);
    if (again.length && again.length < due.length && !again.some((i) => this.limitStatuses.includes(got[i].status))) {
      await sleep(this.retryWait);
      const second = await fetchAll(again.map((i) => due[i]), one, { concurrency: this.cfg.hn.concurrency });
      again.forEach((i, j) => {
        got[i] = second[j];
      });
    }
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

  extra() {
    return this.category ? { category: this.category } : {};
  }
}

module.exports = { HnCollector, storeConfig };
