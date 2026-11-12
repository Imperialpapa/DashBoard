'use strict';

// 백그라운드 수집기.
//  - 버킷마다 갱신 주기가 다르다(진행 중인 기간은 한 시간, 지난 연도는 7일 등). 주기는 config.js의 collect 범위 안에서만 움직인다.
//  - 요청은 한 번에 하나씩, GitHub 검색 API 한도에 맞춘 간격으로 보낸다.
//  - 우선순위: 사용자가 기다리는 버킷 > 첫 화면용 버킷 > 뜨거운 버킷 갱신 > 과거 구간 채우기 > 과거 구간 갱신
//  - 실패하면 지수 백오프, 한도 초과면 리셋 시각까지 전체 일시정지. 그동안은 기존 데이터를 그대로 보여 준다.

const { EventEmitter } = require('node:events');
const periods = require('./periods');
const { searchRepos } = require('./github');
const { Store } = require('./store');
const { countClean, merge } = require('./spam');

const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Collector extends EventEmitter {
  constructor({ cfg, store, search = searchRepos }) {
    super();
    this.cfg = cfg;
    this.store = store;
    this.search = search;
    this.token = cfg.token;
    this.jobs = new Map();
    this.listing = {};
    this.viewers = 0;
    this.running = null;
    this.pauseUntil = 0;
    this.lastRequestAt = 0;
    this.lastSync = 0;
    this.lastDay = '';
    this.lastError = null;
    this.rate = { limit: this.token ? 30 : 10, remaining: null, reset: null };
    this.timer = null;
  }

  start() {
    this.sync(Date.now());
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** 요청 사이 최소 간격. 한도의 80%만 쓴다. */
  spacing() {
    return Math.ceil((60_000 / Math.max(1, this.rate.limit)) * 1.25);
  }

  /** 오늘 날짜 기준으로 버킷 목록을 다시 만들고 작업 테이블에 맞춘다. */
  sync(now) {
    this.lastSync = now;
    this.lastDay = new Date(now).toISOString().slice(0, 10);
    const eager = new Set();
    for (const type of periods.TYPES) {
      this.listing[type] = periods.list(type, now, this.cfg);
      for (const desc of this.listing[type]) {
        const id = Store.id(desc.type, desc.key);
        const job = this.jobs.get(id) || this.newJob(desc);
        job.desc = desc;
        job.eager = desc.eager;
        if (desc.eager) eager.add(id);
        this.jobs.set(id, job);
      }
    }
    // 목록 밖에서 직접 열었던 버킷은 날짜만 새로 계산해 둔다.
    for (const [id, job] of this.jobs) {
      if (eager.has(id)) continue;
      const desc = periods.describe(job.desc.type, job.desc.key, now, this.cfg.firstYear);
      if (desc) job.desc = { ...job.desc, ...desc };
      job.eager = false;
    }
  }

  newJob(desc) {
    return { desc, eager: false, state: 'idle', boost: 0, failures: 0, notBefore: 0, lastAttemptAt: 0, error: null };
  }

  ensure(type, key) {
    const id = Store.id(type, key);
    let job = this.jobs.get(id);
    if (!job) {
      const desc = periods.describe(type, key, Date.now(), this.cfg.firstYear);
      if (!desc) return null;
      job = this.newJob({ ...desc, eager: false, order: 1e6 });
      this.jobs.set(id, job);
    }
    return job;
  }

  interval(job, now) {
    return periods.interval(job.desc, now, this.cfg);
  }

  /** 이 작업을 실행해도 되는 가장 이른 시각. Infinity면 누가 열 때까지 기다린다. */
  dueAt(job, now) {
    const b = this.store.get(job.desc.type, job.desc.key);
    let due;
    if (job.boost) due = 0;
    else if (!job.eager) due = Infinity;
    else if (!b || b.partial) due = 0; // 없거나, 받다 만 것은 바로 이어 받는다
    else {
      // 보는 사람이 없으면 주기를 늘리되, 진행 중인 기간은 하루 두 번(collect.maxGap)보다 드물어지지 않게 한다.
      let gap = this.interval(job, now) * (this.viewers > 0 ? 1 : this.cfg.idleFactor);
      if (job.desc.kind !== 'closed') gap = Math.min(gap, periods.gaps(this.cfg).max);
      due = b.fetchedAt + gap;
    }
    return Math.max(due, job.notBefore);
  }

  /** 작을수록 먼저 실행한다. */
  score(job, due, now) {
    const b = this.store.get(job.desc.type, job.desc.key);
    const hot = job.desc.kind !== 'closed';
    if (job.boost) return -job.boost; // 가장 최근에 요청된 것부터
    if (!b && job.desc.order < 6) return 1e6 + job.desc.order;
    if (b && hot) return 2e6 - Math.min(9e5, (now - due) / this.interval(job, now));
    if (!b) return 3e6 + job.desc.order;
    return 4e6 - Math.min(9e5, (now - due) / this.interval(job, now));
  }

  tick() {
    const now = Date.now();
    if (now - this.lastSync > 60_000 || new Date(now).toISOString().slice(0, 10) !== this.lastDay) this.sync(now);
    if (this.running || now < this.pauseUntil || now - this.lastRequestAt < this.spacing()) return;

    const best = this.pick(now);
    if (best) this.run(best);
  }

  /** 지금 실행할 수 있는 작업 가운데 가장 급한 것. 없으면 null. */
  pick(now) {
    let best = null;
    let bestScore = Infinity;
    for (const job of this.jobs.values()) {
      const due = this.dueAt(job, now);
      if (due > now) continue;
      const score = this.score(job, due, now);
      if (score < bestScore) {
        best = job;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * 타이머 없이 한 번에 몰아서 수집한다(정적 사이트 빌드용).
   * 받을 때가 된 기간을 급한 순서로 받다가, 더 없거나 deadline이 되면 멈춘다. 못 받은 것은 다음 빌드 몫이다.
   * @returns {{ran: number, failed: number, left: number}}
   */
  async drain(deadline) {
    this.sync(Date.now());
    let ran = 0;
    let failed = 0;
    for (;;) {
      const now = Date.now();
      if (now >= deadline || this.pauseUntil > deadline) break; // 한도가 풀리기를 기다리다 시간을 넘기지 않는다
      const job = this.pick(now);
      if (!job) break;
      await this.run(job);
      ran += 1;
      if (job.error) failed += 1;
    }
    const now = Date.now();
    let left = 0;
    for (const job of this.jobs.values()) if (job.eager && this.dueAt(job, now) <= now) left += 1;
    return { ran, failed, left };
  }

  /** 한도를 지키며 검색 API를 한 번 부른다. */
  async call(q, page = 1) {
    const wait = Math.max(this.pauseUntil, this.lastRequestAt + this.spacing()) - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
    const res = await this.search({ q, page, perPage: this.cfg.perPage, token: this.token });
    this.applyRate(res.rate);
    return res;
  }

  applyRate(rate) {
    if (!rate) return;
    this.rate = rate;
    if (rate.remaining === 0 && rate.reset) this.pauseUntil = Math.max(this.pauseUntil, rate.reset * 1000 + 500);
  }

  /**
   * 한 버킷의 상위 N개를 받아 온다.
   *
   * 범위가 넓은 질의(예: 최근 365일, 대상 수천만 개)는 GitHub 쪽에서 시간 초과가 나
   * incomplete_results=true 와 함께 "일부만 훑은" 순위를 돌려준다. 이때 받은 N번째 스타 수는
   * 진짜 N번째 스타 수보다 클 수 없으므로, 그 값을 하한(stars:>=K)으로 붙여 다시 질의하면
   * 후보가 수백 개로 줄어 완전한 순위를 받을 수 있다. 이후 갱신은 하한을 붙인 질의만 보낸다.
   *
   * 첫 쪽에 스팸 의심이 많아 그것을 빼면 top개가 안 되면, 찰 때까지 다음 쪽을 이어 받는다(최대 maxPages쪽).
   * onFirstPage가 있으면 첫 쪽을 받자마자 먼저 넘겨, 나머지를 받는 동안에도 화면이 비지 않게 한다.
   */
  async fetchBucket(job, now, onFirstPage) {
    const { perPage, top, spam } = this.cfg;
    const base = periods.query(job.desc);
    const b = this.store.get(job.desc.type, job.desc.key);

    // 1) 완전한 순위를 돌려주는 질의를 정하고 첫 쪽을 받는다.
    let query = base;
    let first = null;
    let total;
    let totalAt;
    let approx;

    // 하한을 이미 알고, 전체 개수도 하루 안에 확인했다면 좁힌 질의부터 보낸다.
    const known = b && b.floor && b.from === job.desc.from && now - (b.totalAt || 0) < DAY;
    if (known) {
      // 스타가 조금 빠져도 후보를 놓치지 않게 20% 여유를 둔다.
      const q = `${base} stars:>=${Math.floor(b.floor * 0.8)}`;
      const res = await this.call(q);
      if (res.items.length >= perPage && !res.incomplete) {
        query = q;
        first = res;
        ({ total, totalAt, approx } = b);
      }
      // 후보가 한 쪽에 못 미치면 하한이 너무 높았던 것이므로 넓은 질의부터 다시 한다.
    }
    if (!first) {
      const broad = await this.call(base);
      total = broad.total;
      totalAt = now;
      if (!broad.incomplete || broad.items.length < perPage) {
        first = broad;
        approx = broad.incomplete;
      } else {
        query = `${base} stars:>=${broad.items[perPage - 1].stars}`;
        first = await this.call(query);
        approx = true;
      }
    }

    // 2) 스팸 의심을 빼고도 순위표가 찰 때까지 다음 쪽을 받는다.
    let items = merge(first.items, []);
    let incomplete = first.incomplete;
    let more = first.items.length >= perPage; // 마지막으로 받은 쪽이 꽉 찼으면 다음 쪽이 있을 수 있다
    let pages = 1;
    const result = () => ({
      items,
      total,
      totalAt,
      approx: Boolean(approx),
      incomplete,
      query,
      pages,
      // 좁힌 질의였다면 받은 것 중 가장 낮은 스타 수가 다음번 하한의 기준이 된다.
      floor: query !== base && items.length >= perPage ? items[items.length - 1].stars : 0,
    });
    const short = () => more && pages < spam.maxPages && countClean(items, spam) < top;

    if (short() && onFirstPage) onFirstPage(result());
    while (short()) {
      const res = await this.call(query, pages + 1);
      pages += 1;
      items = merge(items, res.items);
      incomplete = incomplete || res.incomplete;
      more = res.items.length >= perPage;
    }
    return result();
  }

  async run(job) {
    const started = Date.now();
    this.running = job;
    job.state = 'running';
    job.lastAttemptAt = started;
    this.emitBucket(job, false);
    this.emit('collector', this.status());

    try {
      // 처음 받는 기간은 첫 쪽만으로 먼저 화면을 채운다(이미 데이터가 있으면 다 받은 뒤 한 번에 바꾼다).
      const showFirst = this.store.get(job.desc.type, job.desc.key)
        ? null
        : (partial) => {
            const { changed } = this.store.update(job.desc, partial, Date.now(), { partial: true });
            this.emitBucket(job, changed);
          };
      const result = await this.fetchBucket(job, started, showFirst);
      const { changed } = this.store.update(job.desc, result, Date.now());
      job.failures = 0;
      job.error = null;
      job.notBefore = 0;
      job.boost = 0;
      this.lastError = null;
      job.state = 'idle';
      this.running = null;
      this.emitBucket(job, changed);
    } catch (err) {
      this.fail(job, err);
      job.state = 'idle';
      this.running = null;
      this.emitBucket(job, false);
    }
    this.emit('collector', this.status());
  }

  fail(job, err) {
    const now = Date.now();
    job.failures += 1;
    if (job.failures >= 3) job.boost = 0;
    if (err.rate) this.rate = err.rate;

    let message = err.message || String(err);
    let backoff = Math.min(15 * 60_000, 15_000 * 2 ** (job.failures - 1));

    if (err.status === 401 && this.token) {
      // 토큰이 잘못됐으면 인증 없이 계속 수집한다.
      this.token = '';
      this.rate = { limit: 10, remaining: null, reset: null };
      message = 'GITHUB_TOKEN이 유효하지 않아 인증 없이 수집합니다';
      backoff = 0;
    } else if (err.status === 403 || err.status === 429) {
      const reset = err.rate && err.rate.remaining === 0 && err.rate.reset ? err.rate.reset * 1000 + 500 : 0;
      const until = err.retryAfter ? now + err.retryAfter * 1000 : reset || now + 60_000;
      this.pauseUntil = Math.max(this.pauseUntil, until);
      message = 'GitHub API 요청 한도를 넘었습니다';
      backoff = Math.max(0, this.pauseUntil - now);
    } else if (err.status === 422) {
      backoff = 60 * 60_000;
    }

    job.error = message;
    job.notBefore = now + backoff;
    this.lastError = { message, at: now, bucket: Store.id(job.desc.type, job.desc.key) };
    console.warn(`[collector] ${this.lastError.bucket} 실패: ${message}`);
  }

  /** 화면에서 버킷을 열었거나 '지금 갱신'을 눌렀을 때. 오래됐으면 앞줄에 세운다. */
  request(type, key, { force = false } = {}) {
    const job = this.ensure(type, key);
    if (!job) return { ok: false, reason: 'invalid' };
    const now = Date.now();
    const b = this.store.get(type, key);

    const wasQueued = Boolean(job.boost);
    if (force) {
      // 잇달아 누르는 것을 막고, 받은 지 한 시간(collect.minGap)이 안 된 것은 눌러도 다시 받지 않는다.
      const fresh = b && !b.partial ? b.fetchedAt + periods.gaps(this.cfg).min : 0;
      const wait = Math.max(job.lastAttemptAt + this.cfg.manualRefreshCooldown, fresh) - now;
      if (job.state === 'running') return { ok: true, queued: true };
      if (wait > 0) return { ok: false, reason: 'cooldown', retryInMs: wait };
      job.boost = now;
    } else if (!b || b.partial || now - b.fetchedAt > this.interval(job, now)) {
      if (!job.boost) job.boost = now;
    }
    // 상태가 바뀌었을 때만 알린다. 화면은 이 알림을 받으면 순위를 다시 요청하므로,
    // 요청할 때마다 알리면 요청 → 알림 → 요청이 끝없이 이어진다.
    if (job.boost && (force || !wasQueued)) this.emitBucket(job, false);
    return { ok: true, queued: Boolean(job.boost) };
  }

  setViewers(n) {
    if (n === this.viewers) return;
    this.viewers = n;
    this.emit('collector', this.status());
  }

  emitBucket(job, changed) {
    this.emit('bucket', this.bucketStatus(job), changed);
  }

  bucketStatus(job, now = Date.now()) {
    const { type, key } = job.desc;
    const b = this.store.get(type, key);
    const due = this.dueAt(job, now);
    let state = job.state;
    if (state !== 'running' && due <= now) state = 'queued';
    return {
      type,
      key,
      state,
      hasData: Boolean(b),
      version: b ? b.version : 0,
      fetchedAt: b ? b.fetchedAt : null,
      dataAt: b ? b.dataAt : null,
      nextAt: Number.isFinite(due) ? Math.max(due, this.pauseUntil) : null,
      interval: this.interval(job, now),
      error: job.error,
    };
  }

  status(now = Date.now()) {
    let queued = 0;
    let missing = 0;
    let eager = 0;
    for (const job of this.jobs.values()) {
      if (job.eager) {
        eager += 1;
        if (!this.store.get(job.desc.type, job.desc.key)) missing += 1;
      }
      if (job !== this.running && this.dueAt(job, now) <= now) queued += 1;
    }
    return {
      authenticated: Boolean(this.token),
      rate: this.rate,
      pauseUntil: this.pauseUntil > now ? this.pauseUntil : null,
      running: this.running ? Store.id(this.running.desc.type, this.running.desc.key) : null,
      queued,
      eager,
      missing,
      viewers: this.viewers,
      lastError: this.lastError,
    };
  }

  meta(now = Date.now()) {
    // 자정 직후에 물어 와도 어제 목록을 주지 않게 한다.
    if (new Date(now).toISOString().slice(0, 10) !== this.lastDay) this.sync(now);
    const types = {};
    for (const type of periods.TYPES) {
      types[type] = this.listing[type].map((desc) => {
        const job = this.jobs.get(Store.id(desc.type, desc.key));
        const { kind, label, from, to } = desc;
        return { ...this.bucketStatus(job, now), kind, label, from, to };
      });
    }
    const { minStars, maxForkRatio, since } = this.cfg.spam;
    return { now, types, collector: this.status(now), top: this.cfg.top, spam: { minStars, maxForkRatio, since } };
  }
}

module.exports = { Collector };
