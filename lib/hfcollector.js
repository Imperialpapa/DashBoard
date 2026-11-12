'use strict';

// Hugging Face 수집기.
//
// GitHub 수집기(lib/collector.js)는 기간마다 따로 검색하지만, Hugging Face에는 만든 날짜로 거르는
// 검색 조건이 없다. 그래서 모델 목록을 좋아요 내림차순으로 한 번 훑어 내려가며, 각 모델을 만든 날짜가
// 속한 기간들에 나눠 담는다. 목록이 좋아요순이므로 기간마다 먼저 담긴 top개가 곧 그 기간의 상위 top개다.
// 모든 기간이 차거나 maxPages쪽에 이르면 멈춘다. 한 번 훑으면 주간·월간·연간이 모두 갱신된다.
//
// 서버(server.js)와 빌드(lib/build.js)가 쓰는 부분은 GitHub 수집기와 같은 모양이다:
// meta(), status(), request(), setViewers(), start()/stop(), drain(), 'bucket'·'collector' 이벤트.

const path = require('node:path');
const { EventEmitter } = require('node:events');
const periods = require('./periods');
const { listModels } = require('./hf');
const { Store } = require('./store');

const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Hugging Face용 저장소 설정: 캐시 폴더를 따로 쓰고, 스팸 의심 규칙(스타 대비 포크)은 적용하지 않는다. */
const storeConfig = (cfg) => ({ ...cfg, dataDir: path.join(cfg.dataDir, 'hf'), spam: null });

class HfCollector extends EventEmitter {
  constructor({ cfg, store, list = listModels }) {
    super();
    this.cfg = cfg;
    this.store = store;
    this.list = list;
    this.token = cfg.hf.token || '';
    // 기간 목록은 GitHub과 같은 규칙으로 만들되 길이와 시작 연도만 다르다. 목록에 있는 기간은 모두 받는다.
    this.periodCfg = { listed: cfg.hf.listed, eager: cfg.hf.listed, firstYear: cfg.hf.firstYear };
    this.listing = {};
    this.lastDay = '';
    this.viewers = 0;
    this.running = false;
    this.progress = null; // 훑는 중이면 {pages, open}
    this.boost = 0;
    this.failures = 0;
    this.notBefore = 0;
    this.pauseUntil = 0;
    this.lastAttemptAt = 0;
    this.lastWalkAt = 0;
    this.error = null;
    this.lastError = null;
    this.rate = { limit: null, window: null, remaining: null, resetAt: null };
    this.timer = null;
  }

  start() {
    this.restore();
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** 캐시에서 불러온 것이 있으면 그 시각을 마지막으로 훑은 때로 본다(재시작하자마자 다시 훑지 않게). */
  restore() {
    if (this.lastWalkAt) return;
    for (const b of this.store.buckets.values()) this.lastWalkAt = Math.max(this.lastWalkAt, b.fetchedAt || 0);
  }

  sync(now) {
    this.lastDay = new Date(now).toISOString().slice(0, 10);
    for (const type of periods.TYPES) this.listing[type] = periods.list(type, now, this.periodCfg);
  }

  /** 오늘 기준 기간 목록(전 종류). */
  descs(now = Date.now()) {
    if (new Date(now).toISOString().slice(0, 10) !== this.lastDay) this.sync(now);
    return periods.TYPES.flatMap((type) => this.listing[type]);
  }

  find(type, key) {
    return this.descs().find((d) => d.type === type && d.key === key) || null;
  }

  /** 다시 훑어도 되는 가장 이른 시각. */
  dueAt() {
    let due;
    if (this.boost || !this.lastWalkAt) due = 0;
    else due = this.lastWalkAt + this.cfg.hf.refresh * (this.viewers > 0 ? 1 : this.cfg.idleFactor);
    return Math.max(due, this.notBefore);
  }

  tick() {
    const now = Date.now();
    if (this.running || now < this.pauseUntil || this.dueAt() > now) return;
    this.run();
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
    this.lastWalkAt = now;
    return { pages, buckets: targets.length, changed, lowest, exhausted };
  }

  /** 한 번 훑는다. 성공하면 walk()의 결과를, 실패하면 null을 돌려준다(오류는 상태에 남긴다). */
  async run() {
    if (this.running) return null;
    this.running = true;
    this.lastAttemptAt = Date.now();
    this.progress = { pages: 0, open: null };
    this.emitAll();

    let result = null;
    try {
      result = await this.walk();
      this.failures = 0;
      this.error = null;
      this.lastError = null;
      this.notBefore = 0;
      this.boost = 0;
    } catch (err) {
      this.fail(err);
    }
    this.running = false;
    this.progress = null;
    this.emitAll(result ? result.changed : undefined);
    return result;
  }

  fail(err) {
    const now = Date.now();
    this.failures += 1;
    if (this.failures >= 3) this.boost = 0;
    if (err.rate) this.rate = err.rate;

    let message = err.message || String(err);
    let backoff = Math.min(15 * 60_000, 15_000 * 2 ** (this.failures - 1));
    if (err.status === 401 && this.token) {
      // 토큰이 잘못됐으면 인증 없이 계속 수집한다.
      this.token = '';
      message = 'HF_TOKEN이 유효하지 않아 인증 없이 수집합니다';
      backoff = 0;
    } else if (err.status === 429) {
      const reset = err.rate && err.rate.resetAt ? err.rate.resetAt + 500 : 0;
      const until = err.retryAfter ? now + err.retryAfter * 1000 : reset || now + 60_000;
      this.pauseUntil = Math.max(this.pauseUntil, until);
      message = 'Hugging Face API 요청 한도를 넘었습니다';
      backoff = Math.max(0, this.pauseUntil - now);
    }

    this.error = message;
    this.notBefore = now + backoff;
    this.lastError = { message, at: now, bucket: 'hf' };
    console.warn(`[hf] 수집 실패: ${message}`);
  }

  /**
   * 타이머 없이 한 번 훑는다(정적 사이트 빌드용). 실패하면 deadline 안에서 몇 번 다시 해 본다.
   * @returns {{ran: number, failed: number, left: number}} ran은 받은 쪽 수
   */
  async drain(deadline) {
    this.restore();
    let failed = 0;
    for (;;) {
      // 한도가 풀리거나 다시 해 볼 때가 되기를 기다리다 시간을 넘기지 않는다.
      const wait = Math.max(0, Math.max(this.notBefore, this.pauseUntil) - Date.now());
      if (failed >= 3 || Date.now() + wait >= deadline) return { ran: 0, failed, left: 1 };
      if (wait > 0) await sleep(wait);
      const result = await this.run();
      if (result) return { ran: result.pages, failed, left: 0 };
      failed += 1;
    }
  }

  /** 화면에서 기간을 열었거나 '지금 갱신'을 눌렀을 때. 오래됐으면 다시 훑는다. */
  request(type, key, { force = false } = {}) {
    const desc = this.find(type, key);
    if (!desc) return { ok: false, reason: 'invalid' }; // 목록 밖의 기간은 받아 올 방법이 없다
    this.restore();
    const now = Date.now();
    const wasQueued = Boolean(this.boost);
    if (force) {
      if (this.running) return { ok: true, queued: true };
      const wait = this.lastAttemptAt + this.cfg.manualRefreshCooldown - now;
      if (wait > 0) return { ok: false, reason: 'cooldown', retryInMs: wait };
      this.boost = now;
    } else if (!this.lastWalkAt || now - this.lastWalkAt > this.cfg.hf.refresh) {
      if (!this.boost) this.boost = now;
    }
    // 상태가 바뀌었을 때만 알린다(GitHub 수집기의 request와 같은 이유).
    if (this.boost && (force || !wasQueued)) this.emit('bucket', this.bucketStatus(desc), false);
    return { ok: true, queued: Boolean(this.boost) };
  }

  setViewers(n) {
    if (n === this.viewers) return;
    this.viewers = n;
    this.emit('collector', this.status());
  }

  /** 모든 기간의 상태를 알린다. changed에 든 기간은 순위가 바뀐 것으로 알린다. */
  emitAll(changed) {
    for (const desc of this.descs()) {
      this.emit('bucket', this.bucketStatus(desc), Boolean(changed && changed.has(Store.id(desc.type, desc.key))));
    }
    this.emit('collector', this.status());
  }

  bucketStatus(desc, now = Date.now()) {
    const b = this.store.get(desc.type, desc.key);
    const due = this.dueAt();
    return {
      type: desc.type,
      key: desc.key,
      state: this.running ? 'running' : due <= now ? 'queued' : 'idle',
      hasData: Boolean(b),
      version: b ? b.version : 0,
      fetchedAt: b ? b.fetchedAt : null,
      dataAt: b ? b.dataAt : null,
      nextAt: Math.max(due, this.pauseUntil),
      interval: this.cfg.hf.refresh,
      error: this.error,
    };
  }

  status(now = Date.now()) {
    const descs = this.descs(now);
    let missing = 0;
    for (const d of descs) if (!this.store.get(d.type, d.key)) missing += 1;
    return {
      authenticated: Boolean(this.token),
      rate: this.rate,
      pauseUntil: this.pauseUntil > now ? this.pauseUntil : null,
      running: this.running,
      progress: this.progress,
      eager: descs.length,
      missing,
      viewers: this.viewers,
      lastError: this.lastError,
    };
  }

  meta(now = Date.now()) {
    this.restore();
    if (new Date(now).toISOString().slice(0, 10) !== this.lastDay) this.sync(now);
    const types = {};
    for (const type of periods.TYPES) {
      types[type] = this.listing[type].map((desc) => {
        const { kind, label, from, to } = desc;
        return { ...this.bucketStatus(desc, now), kind, label, from, to };
      });
    }
    return { now, types, collector: this.status(now), top: this.cfg.top };
  }
}

module.exports = { HfCollector, storeConfig };
