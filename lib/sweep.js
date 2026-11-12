'use strict';

// "한 번 훑어 전부를 함께 갱신하는" 수집기의 공통 뼈대(Hugging Face, App Store).
//
// GitHub 수집기(lib/collector.js)는 기간마다 따로 검색해 차례를 세우지만, 이쪽은 한 번의 훑기(walk)로
// 모든 기간·차트가 함께 갱신된다. 언제 훑을지, 실패하면 얼마나 쉴지, 상태를 어떻게 알릴지는 같아서 여기에 둔다.
//
// 하위 클래스가 채우는 것:
//   listing(now) → { 종류: [desc, …] }  desc에는 type, key, label이 있다(kind, from, to는 있으면 화면에 넘긴다)
//   walk()       → { pages, changed: Set<id>, … }  저장소를 갱신하고 결과를 돌려준다. 통째로 실패하면 던진다
//   extra()      → meta()에 덧붙일 값(선택)
//
// 서버(server.js)와 빌드(lib/build.js)가 쓰는 부분은 GitHub 수집기와 같은 모양이다:
// meta(), status(), request(), setViewers(), start()/stop(), drain(), 'bucket'·'collector' 이벤트.

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Store } = require('./store');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 출처별 저장소 설정: 캐시 폴더를 따로 쓰고(data/<name>/cache), 스팸 의심 규칙(스타 대비 포크)은 적용하지 않는다. */
const storeConfig = (cfg, name) => ({ ...cfg, dataDir: path.join(cfg.dataDir, name), spam: null });

class SweepCollector extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.label     오류 문구에 쓰는 이름(예: 'Hugging Face')
   * @param {number} o.refresh   로컬 서버가 다시 훑는 간격(ms)
   * @param {string} [o.token], [o.tokenName] 인증 토큰과 그 환경 변수 이름
   * @param {number[]} [o.limitStatuses] 요청 한도 초과로 볼 HTTP 상태
   */
  constructor({ cfg, store, label, refresh, token = '', tokenName = '', limitStatuses = [429] }) {
    super();
    this.cfg = cfg;
    this.store = store;
    this.label = label;
    this.refresh = refresh;
    this.token = token;
    this.tokenName = tokenName;
    this.limitStatuses = limitStatuses;
    this.viewers = 0;
    this.running = false;
    this.progress = null; // 훑는 중이면 {pages, …}
    this.boost = 0;
    this.failures = 0;
    this.notBefore = 0;
    this.pauseUntil = 0;
    this.lastAttemptAt = 0;
    this.lastWalkAt = 0;
    this.error = null; // 훑기가 통째로 실패했을 때
    this.bucketErrors = new Map(); // 일부만 실패했을 때: id → 문구
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

  /** 지금 목록에 있는 모든 기간·차트. */
  descs(now = Date.now()) {
    return Object.values(this.listing(now)).flat();
  }

  find(type, key) {
    return this.descs().find((d) => d.type === type && d.key === key) || null;
  }

  /** 다시 훑어도 되는 가장 이른 시각. */
  dueAt() {
    let due;
    if (this.boost || !this.lastWalkAt) due = 0;
    else due = this.lastWalkAt + this.refresh * (this.viewers > 0 ? 1 : this.cfg.idleFactor);
    return Math.max(due, this.notBefore);
  }

  tick() {
    const now = Date.now();
    if (this.running || now < this.pauseUntil || this.dueAt() > now) return;
    this.run();
  }

  /** 한 번 훑는다. 성공하면 walk()의 결과를, 실패하면 null을 돌려준다(오류는 상태에 남긴다). */
  async run() {
    if (this.running) return null;
    this.running = true;
    this.lastAttemptAt = Date.now();
    this.progress = { pages: 0 };
    this.emitAll();

    let result = null;
    try {
      result = await this.walk();
      this.lastWalkAt = Date.now();
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
      message = `${this.tokenName}이 유효하지 않아 인증 없이 수집합니다`;
      backoff = 0;
    } else if (this.limitStatuses.includes(err.status)) {
      const reset = err.rate && err.rate.resetAt ? err.rate.resetAt + 500 : 0;
      const until = err.retryAfter ? now + err.retryAfter * 1000 : reset || now + 60_000;
      this.pauseUntil = Math.max(this.pauseUntil, until);
      message = `${this.label} API 요청 한도를 넘었습니다`;
      backoff = Math.max(0, this.pauseUntil - now);
    }

    this.error = message;
    this.notBefore = now + backoff;
    this.lastError = { message, at: now, bucket: this.label };
    console.warn(`[${this.label}] 수집 실패: ${message}`);
  }

  /**
   * 타이머 없이 한 번 훑는다(정적 사이트 빌드용). 실패하면 deadline 안에서 몇 번 다시 해 본다.
   * @returns {{ran: number, failed: number, left: number}} ran은 보낸 요청 수
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

  /** 화면에서 기간·차트를 열었거나 '지금 갱신'을 눌렀을 때. 오래됐으면 다시 훑는다. */
  request(type, key, { force = false } = {}) {
    const desc = this.find(type, key);
    if (!desc) return { ok: false, reason: 'invalid' }; // 목록 밖의 것은 받아 올 방법이 없다
    this.restore();
    const now = Date.now();
    const wasQueued = Boolean(this.boost);
    if (force) {
      if (this.running) return { ok: true, queued: true };
      const wait = this.lastAttemptAt + this.cfg.manualRefreshCooldown - now;
      if (wait > 0) return { ok: false, reason: 'cooldown', retryInMs: wait };
      this.boost = now;
    } else if (!this.lastWalkAt || now - this.lastWalkAt > this.refresh) {
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

  /** 모든 기간·차트의 상태를 알린다. changed에 든 것은 순위가 바뀐 것으로 알린다. */
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
      interval: this.refresh,
      error: this.bucketErrors.get(Store.id(desc.type, desc.key)) || this.error,
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

  /** meta()에 덧붙일 값. */
  extra() {
    return {};
  }

  meta(now = Date.now()) {
    this.restore();
    const types = {};
    for (const [type, list] of Object.entries(this.listing(now))) {
      types[type] = list.map((desc) => {
        const { kind = null, label, from = null, to = null } = desc;
        return { ...this.bucketStatus(desc, now), kind, label, from, to };
      });
    }
    return { now, types, collector: this.status(now), top: this.cfg.top, ...this.extra() };
  }
}

module.exports = { SweepCollector, storeConfig, sleep };
