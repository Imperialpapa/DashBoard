'use strict';

// Hugging Face 수집기.
//
// GitHub 수집기(lib/collector.js)는 기간마다 따로 검색하지만, Hugging Face에는 만든 날짜로 거르는
// 검색 조건이 없다. 그래서 목록(모델, Space, 데이터셋 가운데 하나)을 좋아요 내림차순으로 한 번 훑어 내려가며,
// 각 항목을 만든 날짜가 속한 기간들에 나눠 담는다. 목록이 좋아요순이므로 기간마다 먼저 담긴 top개가 곧 그 기간의 상위 top개다.
// 모든 기간이 차거나 maxPages쪽에 이르면 멈춘다. 한 번 훑으면 주간·월간·연간이 모두 갱신된다.
// 수집기 하나가 한 종류를 맡는다(종류마다 저장소와 화면 주소가 따로다: hf, hfs, hfd).
//
// 분야별 순위(lib/categories.js)는 분야 × 종류마다 이 수집기를 하나씩 더 둔다. 전체 목록 대신 그 분야의 조건(terms:
// 이 태그가 붙은 것, 이름에 이 글자가 든 것)마다 목록을 훑어 합친 다음, 똑같이 만든 날짜로 기간에 나눠 담는다(walkTerms).
//
// 언제 훑을지, 실패 처리, 상태 알림은 공통 뼈대(lib/sweep.js)에 있다.

const periods = require('./periods');
const { listRepos } = require('./hf');
const { Store } = require('./store');
const { SweepCollector, storeConfig: sweepStoreConfig, sleep } = require('./sweep');

const DAY = 86_400_000;
const LABELS = { models: 'Hugging Face', spaces: 'Hugging Face Spaces', datasets: 'Hugging Face 데이터셋' };

/** Hugging Face용 저장소 설정(data/<name>/cache). name은 모델 hf, Space hfs, 데이터셋 hfd. */
const storeConfig = (cfg, name = 'hf') => sweepStoreConfig(cfg, name);

class HfCollector extends SweepCollector {
  /**
   * @param {object} o
   * @param {'models'|'spaces'|'datasets'} [o.kind] 무엇의 목록을 훑을지
   * @param {Function} [o.list] 목록을 한 쪽 받는 함수(시험용)
   * @param {{filter?: string, search?: string}[]} [o.terms] 이 조건에 맞는 것만 다룬다(분야별 순위). 없으면 전체 목록
   * @param {string} [o.label]    기록과 오류 문구에 쓰는 이름
   * @param {object} [o.category] 어느 분야인지(meta에 싣는다)
   */
  constructor({ cfg, store, kind = 'models', list = listRepos, terms = null, label = '', category = null }) {
    super({ cfg, store, label: label || LABELS[kind] || 'Hugging Face', refresh: cfg.hf.refresh, token: cfg.hf.token || '', tokenName: 'HF_TOKEN' });
    this.kind = kind;
    this.list = list;
    this.terms = terms && terms.length ? terms : null;
    this.category = category;
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

  /** 목록을 한 쪽 받는다. term은 분야의 조건 하나({filter} 또는 {search}). */
  async call(cursor, term = null) {
    const wait = this.pauseUntil - Date.now();
    if (wait > 0) await sleep(wait);
    const res = await this.list({ kind: this.kind, cursor, limit: this.cfg.hf.pageSize, token: this.token, ...(term || {}) });
    if (res.rate) {
      this.rate = res.rate;
      if (res.rate.remaining === 0 && res.rate.resetAt) this.pauseUntil = Math.max(this.pauseUntil, res.rate.resetAt + 500);
    }
    return res;
  }

  /**
   * 분야의 조건으로 한 쪽 받되, 잠깐의 실패면 조금 쉬었다가 한 번 더 받아 본다: 조건을 건 목록은 처음 부를 때
   * Hugging Face가 "오래 걸린다"며 거절하는 일이 있고, 다시 부르면 된다. 한 번의 거절로 그 분야가 통째로 비지 않게 한다.
   * 인증 오류와 한도 초과는 다시 해도 같으므로 그대로 던진다.
   */
  async callTerm(cursor, term) {
    try {
      return await this.call(cursor, term);
    } catch (err) {
      if (err.status === 401 || this.limitStatuses.includes(err.status)) throw err;
      await sleep(this.retryWait);
      return this.call(cursor, term);
    }
  }

  /**
   * 좋아요순 목록을 훑어 모든 기간의 순위를 새로 만든다. 중간에 실패하면 아무것도 바꾸지 않고 던진다
   * (덜 훑은 채로 반영하면 아직 차지 않은 기간의 순위가 틀리게 된다).
   * @returns {{pages: number, buckets: number, changed: Set<string>, lowest: number, exhausted: boolean}}
   */
  async walk() {
    if (this.terms) return this.walkTerms();
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
        total: null, // 그 기간에 만들어진 전체 개수는 알 수 없다
        totalAt: now,
        pages,
        // 다 차지 않았는데 목록을 끝까지 보지도 못했다면, 좋아요가 이 수에 못 미치는 것은 아직 보지 못한 것이다.
        cut: full || exhausted ? 0 : lowest,
      };
      if (this.store.update(t.desc, result, now).changed) changed.add(Store.id(t.desc.type, t.desc.key));
    }
    return { pages, buckets: targets.length, changed, lowest, exhausted };
  }

  /**
   * 분야별 순위: 조건(태그, 이름)마다 좋아요순 목록을 훑어 합친 뒤, 만든 날짜로 기간에 나눠 담는다.
   * 조건 하나는 목록 끝에 이르거나, 좋아요가 없는 것까지 내려가거나, maxPages쪽을 받으면 멈춘다. 좋아요가 없는 것은 싣지 않는다.
   *
   * 쪽 수 상한에서 멈춘 조건이 있으면, 그 조건에는 거기서 본 가장 낮은 좋아요 수 이하인 것이 아직 남아 있다.
   * 그런 것을 빼놓고 줄을 세우면 틀린 순위가 되므로, 모든 조건에서 빠짐없이 본 좋아요 수(cut) 이상인 것만 순위에 넣고
   * 덜 찬 기간에는 "여기까지만 훑었다"는 표시(cut)를 남긴다.
   * 전체 목록을 훑을 때처럼, 중간에 실패하면(한 번 더 받아 봐도 안 되면) 아무것도 바꾸지 않고 던진다.
   * @returns {{pages: number, buckets: number, changed: Set<string>, lowest: number, exhausted: boolean}}
   */
  async walkTerms() {
    const { top } = this.cfg;
    const { maxPages } = this.cfg.hf;
    const found = new Map(); // id → 항목(여러 조건에 걸린 것은 한 번만)
    let pages = 0;
    let cut = 0;

    for (const term of this.terms) {
      let cursor = null;
      for (let n = 1; ; n += 1) {
        const res = await this.callTerm(cursor, term);
        pages += 1;
        for (const m of res.items) if (m.stars > 0 && !found.has(m.id)) found.set(m.id, m);
        this.progress = { pages };
        this.emit('collector', this.status());
        const last = res.items.length ? res.items[res.items.length - 1].stars : 0;
        cursor = res.next;
        if (!cursor || last < 1) break; // 끝까지 봤거나, 좋아요가 있는 것은 다 봤다
        if (n >= maxPages) {
          cut = Math.max(cut, last + 1); // 좋아요가 last인 것은 일부만 봤을 수 있다
          break;
        }
      }
    }

    const pool = [...found.values()].filter((m) => m.stars >= cut).sort((a, b) => b.stars - a.stars); // 안정 정렬: 좋아요가 같으면 받은 순서
    const now = Date.now();
    const changed = new Set();
    const descs = this.descs();
    for (const desc of descs) {
      const from = Date.parse(desc.from);
      const to = desc.to ? Date.parse(desc.to) + DAY : Infinity; // to는 그날 끝까지
      const items = [];
      for (const m of pool) {
        const at = Date.parse(m.created);
        if (at < from || at >= to) continue;
        items.push(m);
        if (items.length >= top) break;
      }
      const result = { items, total: null, totalAt: now, pages, cut: items.length >= top ? 0 : cut };
      if (this.store.update(desc, result, now).changed) changed.add(Store.id(desc.type, desc.key));
    }
    return { pages, buckets: descs.length, changed, lowest: cut, exhausted: !cut };
  }

  extra() {
    return this.category ? { category: this.category } : {};
  }
}

module.exports = { HfCollector, storeConfig, LABELS };
