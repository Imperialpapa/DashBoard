'use strict';

// Hugging Face 수집기.
//
// GitHub 수집기(lib/collector.js)는 기간마다 따로 검색하지만, Hugging Face에는 만든 날짜로 거르는
// 검색 조건이 없다. 그래서 모델 목록을 좋아요 내림차순으로 한 번 훑어 내려가며, 각 모델을 만든 날짜가
// 속한 기간들에 나눠 담는다. 목록이 좋아요순이므로 기간마다 먼저 담긴 top개가 곧 그 기간의 상위 top개다.
// 모든 기간이 차거나 maxPages쪽에 이르면 멈춘다. 한 번 훑으면 주간·월간·연간이 모두 갱신된다.
//
// 언제 훑을지, 실패 처리, 상태 알림은 공통 뼈대(lib/sweep.js)에 있다.

const periods = require('./periods');
const { listModels } = require('./hf');
const { Store } = require('./store');
const { SweepCollector, storeConfig: sweepStoreConfig, sleep } = require('./sweep');

const DAY = 86_400_000;

/** Hugging Face용 저장소 설정(data/hf/cache). */
const storeConfig = (cfg) => sweepStoreConfig(cfg, 'hf');

class HfCollector extends SweepCollector {
  constructor({ cfg, store, list = listModels }) {
    super({ cfg, store, label: 'Hugging Face', refresh: cfg.hf.refresh, token: cfg.hf.token || '', tokenName: 'HF_TOKEN' });
    this.list = list;
    // 기간 목록은 GitHub과 같은 규칙으로 만들되 길이와 시작 연도만 다르다. 목록에 있는 기간은 모두 받는다.
    this.periodCfg = { listed: cfg.hf.listed, eager: cfg.hf.listed, firstYear: cfg.hf.firstYear };
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

  async call(cursor) {
    const wait = this.pauseUntil - Date.now();
    if (wait > 0) await sleep(wait);
    const res = await this.list({ cursor, limit: this.cfg.hf.pageSize, token: this.token });
    if (res.rate) {
      this.rate = res.rate;
      if (res.rate.remaining === 0 && res.rate.resetAt) this.pauseUntil = Math.max(this.pauseUntil, res.rate.resetAt + 500);
    }
    return res;
  }

  /**
   * 좋아요순 목록을 훑어 모든 기간의 순위를 새로 만든다. 중간에 실패하면 아무것도 바꾸지 않고 던진다
   * (덜 훑은 채로 반영하면 아직 차지 않은 기간의 순위가 틀리게 된다).
   * @returns {{pages: number, buckets: number, changed: Set<string>, lowest: number, exhausted: boolean}}
   */
  async walk() {
    const { top } = this.cfg;
    const { maxPages } = this.cfg.hf;
    const targets = this.descs().map((desc) => ({
      desc,
      from: Date.parse(desc.from),
      to: desc.to ? Date.parse(desc.to) + DAY : Infinity, // to는 그날 끝까지
      items: [],
    }));

    let open = targets.length; // 아직 top개가 차지 않은 기간 수
    let cursor = null;
    let pages = 0;
    let lowest = 0; // 지금까지 훑은 가장 낮은 좋아요 수
    let exhausted = false; // 목록 끝까지 봤는지
    const seen = new Set();

    while (open > 0 && pages < maxPages) {
      const res = await this.call(cursor);
      pages += 1;
      for (const m of res.items) {
        if (seen.has(m.id)) continue; // 쪽을 받는 사이에 순서가 바뀌어 겹친 것
        seen.add(m.id);
        const at = Date.parse(m.created);
        for (const t of targets) {
          if (t.items.length < top && at >= t.from && at < t.to) {
            t.items.push(m);
            if (t.items.length === top) open -= 1;
          }
        }
      }
      if (res.items.length) lowest = res.items[res.items.length - 1].stars;
      this.progress = { pages, open };
      this.emit('collector', this.status());
      cursor = res.next;
      if (!cursor) {
        exhausted = true;
        break;
      }
    }

    const now = Date.now();
    const changed = new Set();
    for (const t of targets) {
      const full = t.items.length >= top;
      const result = {
        items: t.items.sort((a, b) => b.stars - a.stars), // 안정 정렬: 좋아요가 같으면 받은 순서
        total: null, // 그 기간에 만들어진 모델 수는 알 수 없다
        totalAt: now,
        pages,
        // 다 차지 않았는데 목록을 끝까지 보지도 못했다면, 좋아요가 이 수에 못 미치는 모델은 아직 보지 못한 것이다.
        cut: full || exhausted ? 0 : lowest,
      };
      if (this.store.update(t.desc, result, now).changed) changed.add(Store.id(t.desc.type, t.desc.key));
    }
    return { pages, buckets: targets.length, changed, lowest, exhausted };
  }
}

module.exports = { HfCollector, storeConfig };
