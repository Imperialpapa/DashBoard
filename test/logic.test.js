'use strict';
// 기간 계산, 수집기, 저장소, 스팸 판정 로직 시험. GitHub를 부르지 않고 가짜 검색 함수로 돌린다.
// 사용: npm test
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'github-best-test-')); // 시험용 캐시는 프로젝트 밖에 둔다
const periods = require(path.join(root, 'lib/periods'));
const { Store } = require(path.join(root, 'lib/store'));
const { Collector } = require(path.join(root, 'lib/collector'));
const { GitHubError } = require(path.join(root, 'lib/github'));
const fullCfg = require(path.join(root, 'config'));
// 덧붙는 출처는 시험마다 필요한 것만 켠다(켜 두면 build()가 실제 API를 부른다). Hacker News는 15번에서 따로 켠다.
const baseCfg = { ...fullCfg, hn: null, hf: { ...fullCfg.hf, kinds: ['models'] } }; // Hugging Face는 모델만(Space·데이터셋은 16번에서)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ok  ${name}`);
};

// ── periods ────────────────────────────────────────────────────
{
  const at = (s) => Date.parse(s);
  const d = (type, key, now) => periods.describe(type, key, at(now));

  assert.deepEqual(
    (({ from, to, kind }) => ({ from, to, kind }))(d('weekly', '2026-W01', '2026-11-12T03:00:00Z')),
    { from: '2025-12-29', to: '2026-01-04', kind: 'closed' },
  );
  assert.equal(d('weekly', '2026-W46', '2026-11-12T03:00:00Z').kind, 'current');
  assert.equal(d('weekly', '2026-W46', '2026-11-15T23:59:00Z').kind, 'current'); // 일요일까지 진행 중
  assert.equal(d('weekly', '2026-W46', '2026-11-16T00:00:00Z').kind, 'closed');
  assert.equal(d('weekly', '2026-W47', '2026-11-12T03:00:00Z'), null); // 아직 오지 않은 주
  assert.equal(d('weekly', '2025-W53', '2026-11-12T03:00:00Z'), null); // 2025년은 52주
  assert.equal(d('weekly', '2026-W53', '2027-02-01T00:00:00Z').from, '2026-12-28'); // 2026년은 53주
  assert.equal(d('weekly', '2026-W00', '2026-11-12T03:00:00Z'), null);
  assert.equal(d('monthly', '2024-02', '2026-11-12T03:00:00Z').to, '2024-02-29');
  assert.equal(d('monthly', '2026-13', '2026-11-12T03:00:00Z'), null);
  assert.equal(d('monthly', '2007-12', '2026-11-12T03:00:00Z'), null); // firstYear 이전
  assert.equal(d('yearly', '2026', '2026-11-12T03:00:00Z').kind, 'current');
  assert.equal(d('yearly', '2027', '2026-11-12T03:00:00Z'), null);
  assert.equal(d('weekly', 'rolling', '2026-11-12T03:00:00Z').from, '2026-11-05');
  assert.equal(d('weekly', '../x', '2026-11-12T03:00:00Z'), null);
  ok('describe: 경계와 잘못된 키');

  // 연초: 1월 1일(금)은 ISO로 전년도 53주차
  const now = at('2027-01-01T05:00:00Z');
  const w = periods.list('weekly', now, baseCfg);
  assert.deepEqual(w.slice(0, 4).map((x) => `${x.key}:${x.kind}`), ['rolling:rolling', '2026-W53:current', '2026-W52:closed', '2026-W51:closed']);
  assert.equal(w.length, 2 + baseCfg.listed.weekly);
  assert.equal(new Set(w.map((x) => x.key)).size, w.length);
  assert.equal(w.filter((x) => x.eager).length, 2 + baseCfg.eager.weekly);
  const m = periods.list('monthly', now, baseCfg);
  assert.deepEqual(m.slice(0, 3).map((x) => x.key), ['rolling', '2027-01', '2026-12']);
  const y = periods.list('yearly', now, baseCfg);
  assert.deepEqual([y[1].key, y[y.length - 1].key], ['2027', '2008']);
  ok('list: 연초 경계, 중복 없음, eager 개수');

  const closed = d('monthly', '2026-10', '2026-11-12T03:00:00Z');
  assert.equal(periods.interval(closed, at('2026-11-12T03:00:00Z'), baseCfg), baseCfg.refresh.recentClosed);
  assert.equal(periods.interval(d('monthly', '2026-03', '2026-11-12T03:00:00Z'), at('2026-11-12T03:00:00Z'), baseCfg), baseCfg.refresh.closed);
  assert.equal(periods.interval(d('yearly', '2012', '2026-11-12T03:00:00Z'), at('2026-11-12T03:00:00Z'), baseCfg), baseCfg.refresh.archive);
  assert.equal(periods.query(closed), 'created:2026-10-01..2026-10-31');
  ok('interval / query');
}

// ── collector ──────────────────────────────────────────────────
const FAST = { limit: 60000, remaining: 100, reset: 0 }; // 간격 1~2ms로 돌린다
const repo = (id, stars, forks = Math.round(stars * 0.1)) => ({ id, name: `o/r${id}`, owner: 'o', avatar: '', url: `https://github.com/o/r${id}`, desc: '', lang: 'Go', stars, forks, created: '2026-11-10T00:00:00Z', pushed: '2026-11-11T00:00:00Z' });
const page = (n, topStars) => Array.from({ length: n }, (_, i) => repo(i + 1, topStars - i * 10));

function setup(name, search, over = {}) {
  const dataDir = path.join(TMP, name);
  fs.rmSync(dataDir, { recursive: true, force: true });
  const cfg = { ...baseCfg, dataDir, token: '', ...over };
  const store = new Store(cfg);
  store.load();
  const calls = [];
  const collector = new Collector({ cfg, store, search: async (args) => { calls.push(args.q); return search(args, calls.length); } });
  collector.rate = { ...FAST };
  collector.sync(Date.now());
  return { cfg, store, collector, calls };
}
const job = (c, type, key) => c.jobs.get(Store.id(type, key));

(async () => {
  // 1) 좁은 질의: 넓은 질의가 incomplete → 하한을 붙여 다시 → 이후에는 하한 질의 한 번
  {
    const { store, collector, calls } = setup('narrow', async ({ q }) => {
      if (!q.includes('stars:')) return { total: 76_000_000, incomplete: true, items: page(100, 5000), rate: FAST };
      return { total: 140, incomplete: false, items: page(100, 9000), rate: FAST };
    });
    const j = job(collector, 'yearly', 'rolling');
    await collector.run(j);
    const b = store.get('yearly', 'rolling');
    assert.equal(calls.length, 2);
    assert.match(calls[1], /^created:>=\d{4}-\d\d-\d\d stars:>=4010$/);
    assert.equal(b.total, 76_000_000);
    assert.equal(b.approx, true);
    assert.equal(b.incomplete, false);
    assert.equal(b.items[0].stars, 9000);
    assert.equal(b.floor, 8010);
    await collector.run(j);
    assert.equal(calls.length, 3);
    assert.ok(calls[2].endsWith(`stars:>=${Math.floor(8010 * 0.8)}`));
    assert.equal(store.get('yearly', 'rolling').version, 1); // 내용이 같으면 버전은 그대로
    ok('fetchBucket: incomplete → 하한 질의, 재사용, 변화 없으면 버전 유지');
  }

  // 2) 하한이 너무 높아 후보가 모자라면 넓은 질의부터 다시
  {
    let phase = 0;
    const { store, collector, calls } = setup('refloor', async ({ q }) => {
      if (!q.includes('stars:')) return { total: 5_000_000, incomplete: true, items: page(100, 3000), rate: FAST };
      if (phase === 1) return { total: 60, incomplete: false, items: page(60, 3000), rate: FAST };
      return { total: 130, incomplete: false, items: page(100, 3000), rate: FAST };
    });
    const j = job(collector, 'yearly', 'rolling');
    await collector.run(j);
    phase = 1;
    calls.length = 0;
    await collector.run(j);
    assert.equal(calls.length, 3); // 하한 질의(모자람) → 넓은 질의 → 새 하한 질의
    assert.equal(store.get('yearly', 'rolling').items.length, 60);
    ok('fetchBucket: 후보가 모자라면 넓은 질의로 되돌아감');
  }

  // 3) 증가·순위 변동: 기준 스냅샷과 비교
  {
    let stars = [900, 800, 700];
    const { store, collector, cfg } = setup('gain', async () => ({ total: 3, incomplete: false, items: stars.map((s, i) => repo(i + 1, s)).sort((a, b) => b.stars - a.stars), rate: FAST }));
    const j = job(collector, 'weekly', 'rolling');
    await collector.run(j);
    let b = store.get('weekly', 'rolling');
    assert.equal(b.items[0].gain, null);
    assert.equal(b.span, null);
    b.history[0].t -= 20 * 60_000; // 20분 전에 찍은 것으로 만든다
    stars = [905, 800, 950];
    await collector.run(j);
    b = store.get('weekly', 'rolling');
    assert.deepEqual(b.items.map((r) => [r.id, r.rank, r.gain, r.move]), [[3, 1, 250, 2], [1, 2, 5, -1], [2, 3, 0, -1]]);
    assert.ok(b.span >= 20 * 60_000 && b.span < 21 * 60_000);
    assert.equal(b.version, 2);
    assert.equal(b.history.length, 1); // 30분 간격이 안 됐으니 새 점은 없다
    // 디스크에서 다시 읽어도 같은 내용
    const again = new Store(cfg);
    assert.equal(again.load(), 1);
    assert.equal(again.get('weekly', 'rolling').etag, b.etag);
    assert.deepEqual(JSON.parse(again.get('weekly', 'rolling').body).items, b.items);
    ok('store: 증가·순위 변동, 스냅샷 간격, 디스크 복원');
  }

  // 4) 한도 초과: 리셋 시각까지 전체 일시정지, 기존 데이터 유지
  {
    let mode = 'ok';
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const { store, collector, calls } = setup('limit', async () => {
      if (mode === 'limit') throw new GitHubError('API rate limit exceeded', { status: 403, rate: { limit: 60000, remaining: 0, reset } });
      return { total: 100, incomplete: false, items: page(100, 3000), rate: FAST };
    });
    const j = job(collector, 'weekly', 'rolling');
    await collector.run(j);
    mode = 'limit';
    const warn = console.warn;
    console.warn = () => {};
    await collector.run(j);
    console.warn = warn;
    assert.equal(collector.pauseUntil, reset * 1000 + 500);
    assert.equal(j.error, 'GitHub API 요청 한도를 넘었습니다');
    assert.ok(store.get('weekly', 'rolling'));
    assert.equal(collector.status().pauseUntil, reset * 1000 + 500);
    const before = calls.length;
    for (let i = 0; i < 5; i++) collector.tick();
    await sleep(30);
    assert.equal(calls.length, before); // 정지 중에는 아무것도 보내지 않는다
    const st = collector.bucketStatus(j);
    assert.equal(st.nextAt, reset * 1000 + 500);
    ok('rate limit: 리셋까지 정지, 기존 데이터 유지');
  }

  // 5) 일시 오류: 지수 백오프, 성공하면 초기화. 잘못된 토큰은 인증 없이 계속.
  {
    let mode = 'net';
    const { collector, calls } = setup('backoff', async ({ token }) => {
      if (mode === 'net') throw new GitHubError('GitHub에 연결하지 못했습니다 (ENOTFOUND)');
      if (mode === 'auth' && token) throw new GitHubError('Bad credentials', { status: 401 });
      return { total: 100, incomplete: false, items: page(100, 3000), rate: FAST };
    });
    const warn = console.warn;
    console.warn = () => {};
    const j = job(collector, 'weekly', 'rolling');
    const t0 = Date.now();
    await collector.run(j);
    assert.ok(j.notBefore - t0 >= 15_000 && j.notBefore - t0 < 16_000);
    await collector.run(j);
    assert.ok(j.notBefore - t0 >= 30_000 && j.notBefore - t0 < 31_000);
    assert.equal(collector.dueAt(j, Date.now()), j.notBefore);
    mode = 'ok';
    await collector.run(j);
    assert.equal(j.failures, 0);
    assert.equal(j.error, null);
    assert.equal(j.notBefore, 0);

    mode = 'auth';
    collector.token = 'bad';
    await collector.run(j);
    assert.equal(collector.token, '');
    assert.equal(collector.status().authenticated, false);
    assert.equal(collector.rate.limit, 10);
    console.warn = warn;
    void calls;
    ok('backoff: 15초 → 30초, 성공 시 초기화, 잘못된 토큰은 버림');
  }

  // 6) 스케줄러: 우선순위와 수동 갱신 쿨다운
  {
    const { collector, calls } = setup('sched', async () => ({ total: 100, incomplete: false, items: page(100, 3000), rate: FAST }));
    // 처음에는 세 종류의 rolling·진행 중 구간(첫 화면용)을 먼저 받는다.
    const order = [];
    collector.on('bucket', (st) => { if (st.state === 'running') order.push(`${st.type}/${st.key}`); });
    collector.start();
    await sleep(8000); // tick이 1초 간격이므로 몇 개만 본다
    collector.stop();
    assert.deepEqual(order.slice(0, 3), ['weekly/rolling', 'monthly/rolling', 'yearly/rolling']);
    assert.ok(order.length >= 6, `ran ${order.length}`);
    assert.ok(order.slice(3, 6).every((id) => !id.endsWith('rolling')));

    // 사용자가 연 과거 구간은 맨 앞에 선다.
    const r = collector.request('monthly', '2015-07');
    assert.deepEqual(r, { ok: true, queued: true });
    const now = Date.now();
    let best = null;
    let bestScore = Infinity;
    for (const j of collector.jobs.values()) {
      const due = collector.dueAt(j, now);
      if (due > now) continue;
      const s = collector.score(j, due, now);
      if (s < bestScore) { best = j; bestScore = s; }
    }
    assert.equal(best.desc.key, '2015-07');
    assert.deepEqual(collector.request('monthly', '2099-01'), { ok: false, reason: 'invalid' });

    // 같은 기간을 거듭 요청해도 알림은 줄을 설 때 한 번만 나간다(화면의 요청 → 알림 → 요청 되풀이 방지).
    let notified = 0;
    const count = () => { notified += 1; };
    collector.on('bucket', count);
    for (let i = 0; i < 4; i++) assert.deepEqual(collector.request('monthly', '2014-03'), { ok: true, queued: true });
    assert.equal(notified, 1);
    const fresh = job(collector, 'weekly', 'rolling');
    fresh.boost = 0;
    notified = 0;
    for (let i = 0; i < 3; i++) collector.request('weekly', 'rolling'); // 방금 받은 기간은 줄을 세우지 않는다
    assert.equal(notified, 0);
    collector.off('bucket', count);

    const cool = collector.request('weekly', 'rolling', { force: true });
    assert.equal(cool.ok, false);
    assert.equal(cool.reason, 'cooldown');
    job(collector, 'weekly', 'rolling').lastAttemptAt -= 60_000;
    assert.deepEqual(collector.request('weekly', 'rolling', { force: true }), { ok: true, queued: true });

    // 보는 사람이 없으면 주기를 늘린다.
    const j = job(collector, 'monthly', 'rolling');
    j.boost = 0;
    const b = collector.store.get('monthly', 'rolling');
    collector.viewers = 0;
    assert.equal(collector.dueAt(j, now) - b.fetchedAt, 5 * 60_000 * 5);
    collector.viewers = 1;
    assert.equal(collector.dueAt(j, now) - b.fetchedAt, 5 * 60_000);
    void calls;
    ok('scheduler: 첫 화면 우선, 사용자가 연 구간 우선, 쿨다운, 유휴 시 주기 연장');
  }

  // 7) 스팸 판정 규칙
  {
    const { isSpam, rankAll, merge } = require(path.join(root, 'lib/spam'));
    const rule = baseCfg.spam;
    const r = (stars, forks, created = '2026-11-10T00:00:00Z') => ({ stars, forks, created });
    assert.equal(isSpam(r(99, 0), rule), false); // 스타가 적으면 판단하지 않는다
    assert.equal(isSpam(r(100, 0), rule), true);
    assert.equal(isSpam(r(100, 1), rule), false);
    assert.equal(isSpam(r(1200, 0), rule), true);
    assert.equal(isSpam(r(1200, 5), rule), true); // 0.42%
    assert.equal(isSpam(r(1200, 6), rule), false); // 0.5%
    assert.equal(isSpam(r(41776, 56, '2012-10-01T00:00:00Z'), rule), false); // 오래된 정상 라이브러리
    assert.equal(isSpam(r(41776, 56, '2020-01-01T00:00:00Z'), rule), true);
    const ranked = rankAll([repo(1, 900, 0), repo(2, 800), repo(3, 700, 0), repo(4, 600), repo(5, 500)], rule, 2);
    assert.deepEqual(ranked.map((x) => [x.id, x.rank, x.spam, x.crank]), [[1, 1, true, null], [2, 2, false, 1], [4, 4, false, 2]]);
    assert.deepEqual(merge([repo(1, 10), repo(2, 5)], [repo(2, 6), repo(3, 8)]).map((x) => x.id), [1, 3, 2]);
    ok('spam: 판정 경계, 두 가지 순위, 쪽 합치기');
  }

  // 8) 스팸을 빼고 100개가 찰 때까지 다음 쪽을 받는다
  {
    // 쪽마다 100개. 1쪽은 정상 20개, 2쪽 50개, 3쪽 60개(→ 3쪽에서 100개가 찬다).
    const cleanPer = { 1: 20, 2: 50, 3: 60, 4: 100, 5: 100 };
    const bump = new Map();
    const pageOf = (p) => Array.from({ length: 100 }, (_, i) => {
      const id = (p - 1) * 100 + i + 1;
      const stars = 10_000 - id * 10 + (bump.get(id) || 0);
      return repo(id, stars, i < cleanPer[p] ? Math.round(stars * 0.1) : 0);
    });
    let failPage = 0;
    const { store, collector, calls, cfg } = setup('paging', async ({ page }) => {
      if (page === failPage) throw new GitHubError('GitHub에 연결하지 못했습니다 (ECONNRESET)');
      return { total: 2_000_000, incomplete: false, items: pageOf(page), rate: FAST };
    });
    const j = job(collector, 'weekly', 'rolling');
    const events = [];
    collector.on('bucket', (st, changed) => events.push([st.state, st.version, changed]));
    const warn = console.warn;
    console.warn = () => {};

    // 처음 받다가 2쪽에서 실패: 첫 쪽만으로 화면을 채우고, "받다 만 것"으로 남아 곧바로 다시 시도한다.
    failPage = 2;
    await collector.run(j);
    let b = store.get('weekly', 'rolling');
    assert.equal(b.partial, true);
    assert.equal(b.version, 1);
    assert.equal(b.items.filter((x) => !x.spam).length, 20);
    assert.equal(b.history.length, 0); // 중간 결과는 비교 기준으로 남기지 않는다
    assert.equal(JSON.parse(b.body).partial, true);
    assert.deepEqual(events.find((e) => e[2]), ['running', 1, true]);
    assert.equal(collector.dueAt(j, Date.now()), j.notBefore); // 갱신 주기를 기다리지 않는다
    assert.deepEqual(collector.request('weekly', 'rolling'), { ok: true, queued: true });

    // 다시: 이미 (중간) 데이터가 있으므로 다 받은 뒤 한 번에 바꾼다.
    failPage = 0;
    calls.length = 0;
    events.length = 0;
    await collector.run(j);
    console.warn = warn;
    b = store.get('weekly', 'rolling');
    assert.equal(calls.length, 3);
    assert.equal(b.pages, 3);
    assert.equal(b.partial, false);
    assert.equal(b.version, 2);
    assert.equal(events.filter((e) => e[2]).length, 1);
    const clean = b.items.filter((x) => !x.spam);
    assert.deepEqual(clean.map((x) => x.crank), Array.from({ length: 100 }, (_, i) => i + 1));
    assert.equal(clean[99].rank, 230); // 정상 100번째는 3쪽의 30번째
    assert.equal(b.skipped, 130); // 그 위에 있던 스팸 의심 130개(순위표 밖의 것까지)
    assert.equal(JSON.parse(b.body).skipped, 130);
    assert.equal(b.items.filter((x) => x.rank <= 100).length, 100); // 받은 그대로의 상위 100개도 함께
    assert.equal(b.items.length, 100 + 80); // 1쪽 100개 + 2·3쪽의 정상 80개
    assert.equal(b.history.length, 1);
    assert.equal(b.history[0].c, 1);
    assert.deepEqual(b.history[0].s[1], [9990, 1, 1]);
    assert.deepEqual(b.history[0].s[21], [9790, 21, 0]); // 스팸 의심은 스팸을 뺀 순위가 없다

    // 순위 변동: 정상 3위가 1위로, 스팸이던 21번이 포크가 생겨 정상으로, 그 바람에 정상 100위가 밀려난다.
    b.history[0].t -= 20 * 60_000;
    bump.set(3, 500);
    cleanPer[1] = 21;
    await collector.run(j);
    b = store.get('weekly', 'rolling');
    const by = new Map(b.items.map((x) => [x.id, x]));
    assert.deepEqual([by.get(3).rank, by.get(3).crank, by.get(3).move, by.get(3).cmove, by.get(3).gain], [1, 1, 2, 2, 500]);
    assert.deepEqual([by.get(1).crank, by.get(1).cmove], [2, -1]);
    assert.deepEqual([by.get(21).spam, by.get(21).crank, by.get(21).cmove], [false, 21, 'new']);
    assert.equal(by.get(230), undefined); // 정상 101위가 되어 빠졌다
    assert.equal(by.get(229).crank, 100);
    assert.equal(by.get(229).cmove, -1);

    // 끝까지 스팸뿐이면 maxPages에서 멈춘다.
    for (const p of [1, 2, 3, 4, 5]) cleanPer[p] = 3;
    calls.length = 0;
    await collector.run(j);
    b = store.get('weekly', 'rolling');
    assert.equal(calls.length, cfg.spam.maxPages);
    assert.equal(b.items.filter((x) => !x.spam).length, 15);
    assert.equal(b.partial, false);
    ok('paging: 100개가 찰 때까지, 첫 쪽 먼저 표시, 받다 만 것 재시도, 스팸을 뺀 순위 변동, 쪽 상한');
  }

  // 9) 예전 형식 캐시 올리기
  {
    const dataDir = path.join(TMP, 'upgrade');
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dataDir, 'cache'), { recursive: true });
    const legacy = (key, spamN) => ({
      type: 'weekly', key, version: 4, sig: 'abc', from: '2026-11-02', to: '2026-11-08', total: 5, approx: false, incomplete: false, floor: 0,
      fetchedAt: Date.now(), dataAt: Date.now(), span: 600000,
      history: [{ t: Date.now() - 3600_000, s: { 1: [9000, 1] } }],
      items: Array.from({ length: 100 }, (_, i) => ({ ...repo(i + 1, 9000 - i * 10, i < spamN ? 0 : 900), rank: i + 1, gain: 3, move: 0 })),
    });
    fs.writeFileSync(path.join(dataDir, 'cache', 'weekly.2026-W45.json'), JSON.stringify(legacy('2026-W45', 75)));
    fs.writeFileSync(path.join(dataDir, 'cache', 'weekly.2026-W44.json'), JSON.stringify(legacy('2026-W44', 0)));
    const cfg = { ...baseCfg, dataDir, token: '' };
    const store = new Store(cfg);
    assert.equal(store.load(), 2);
    const dirty = store.get('weekly', '2026-W45');
    assert.equal(dirty.partial, true); // 스팸을 빼면 25개뿐 → 이어 받아야 한다
    assert.equal(dirty.version, 5);
    assert.notEqual(dirty.etag, '"4-abc"');
    assert.deepEqual([dirty.items[0].spam, dirty.items[0].crank, dirty.items[75].spam, dirty.items[75].crank, dirty.items[75].gain], [true, null, false, 1, 3]);
    const fine = store.get('weekly', '2026-W44');
    assert.equal(fine.partial, false);
    assert.equal(fine.items[99].crank, 100);
    // 예전 스냅샷과 비교할 때: 스타 증가는 그대로, 스팸을 뺀 순위 변동은 비워 둔다.
    const collector = new Collector({ cfg, store, search: async () => ({ total: 5, incomplete: false, items: Array.from({ length: 100 }, (_, i) => repo(i + 1, 9000 - i * 10 + 7)), rate: FAST }) });
    collector.rate = { ...FAST };
    collector.sync(Date.now());
    await collector.run(collector.ensure('weekly', '2026-W44'));
    const after = store.get('weekly', '2026-W44');
    assert.deepEqual([after.items[0].gain, after.items[0].move, after.items[0].cmove], [7, 0, null]);
    assert.equal(after.schema, 2);
    ok('upgrade: 예전 캐시에 스팸 표시, 모자란 기간은 이어 받기, 브라우저 캐시 무효화');
  }

  // 10) 서버 주소: 화면이 읽는 주소는 정적 사이트의 파일 경로와 같다
  {
    const { createApp } = require(path.join(root, 'server'));
    const { store, collector } = setup('routes', async () => ({ total: 100, incomplete: false, items: page(100, 3000), rate: FAST }));
    await collector.run(job(collector, 'weekly', 'rolling'));
    const { server, close } = createApp({ store, collector });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (p, opt) => fetch(base + p, opt);

    let r = await get('/data/meta.json');
    const meta = await r.json();
    assert.equal(meta.live, true);
    assert.equal(meta.types.weekly[0].hasData, true);
    assert.equal(meta.top, 100);

    r = await get('/data/weekly.rolling.json?v=1');
    assert.equal(r.status, 200);
    const etag = r.headers.get('etag');
    assert.equal((await r.json()).items.length, 100);
    r = await get('/data/weekly.rolling.json', { headers: { 'If-None-Match': etag } });
    assert.equal(r.status, 304);
    assert.equal((await get('/data/monthly.rolling.json')).status, 202); // 아직 받지 않은 기간
    assert.equal((await get('/data/weekly.2099-W01.json')).status, 404);
    assert.equal((await get('/data/bogus.rolling.json')).status, 404);
    assert.equal((await get('/data/state/weekly.rolling.json')).status, 404);
    assert.equal((await get('/data/hf/weekly.rolling.json')).status, 404); // Hugging Face 없이 띄운 서버
    assert.equal(meta.hf, undefined);
    assert.equal((await get('/config.js')).status, 404); // 화면 파일 말고는 내보내지 않는다

    r = await get('/');
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.ok(!/(?:src|href)="\/(?!\/)/.test(html), '화면 파일 주소는 상대 경로여야 한다(하위 경로 배포)');

    r = await get('/api/refresh?type=weekly&key=rolling', { method: 'POST', headers: { Origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    r = await get('/api/refresh?type=weekly&key=rolling', { method: 'POST' });
    assert.equal(r.status, 429); // 방금 받았으므로 쿨다운
    assert.equal((await get('/api/refresh?type=weekly&key=nope', { method: 'POST' })).status, 404);

    const ac = new AbortController();
    r = await get('/api/events', { signal: ac.signal });
    const first = new TextDecoder().decode((await r.body.getReader().read()).value);
    assert.match(first, /event: hello\ndata: \{/);
    assert.equal(collector.viewers, 1);
    ac.abort();

    close();
    server.closeAllConnections();
    ok('server: data/ 주소, ETag, 대기·없는 기간, 수동 갱신 보호, 실시간 스트림');
  }

  // 11) 정적 사이트 빌드: 써 내는 파일, 지난 배포본에서 이어받기
  {
    const { build } = require(path.join(root, 'lib/build'));
    let extra = 0;
    const search = async () => ({ total: 1000, incomplete: false, items: page(100, 5000).map((x) => ({ ...x, stars: x.stars + extra })), rate: FAST });
    const quiet = { log: () => {} };
    // hf, as: null → GitHub 쪽만 본다(Hugging Face는 12·13번, App Store는 14번에서 따로).
    const cfgA = { ...baseCfg, hf: null, as: null, token: '', dataDir: path.join(TMP, 'buildA'), listed: { weekly: 2, monthly: 2 }, firstYear: new Date().getUTCFullYear() - 1, static: { every: 15 * 60_000, budget: 60_000 } };
    const out1 = path.join(TMP, 'site1');
    const r1 = await build({ cfg: cfgA, out: out1, search, ...quiet });
    // 주간 4(최근 7일·이번 주·지난 2주) + 월간 4 + 연간 3(최근 365일·올해·작년)
    assert.deepEqual([r1.written, r1.ran, r1.failed, r1.left, r1.loaded], [11, 11, 0, 0, 0]);
    for (const f of ['index.html', 'app.js', 'styles.css', 'favicon.svg', 'data/meta.json', 'data/weekly.rolling.json', 'data/state/weekly.rolling.json']) {
      assert.ok(fs.existsSync(path.join(out1, f)), f);
    }
    const meta1 = JSON.parse(fs.readFileSync(path.join(out1, 'data/meta.json'), 'utf8'));
    assert.equal(meta1.live, false);
    assert.equal(meta1.every, 15 * 60_000);
    assert.ok(Math.abs(meta1.builtAt - Date.now()) < 5000);
    assert.equal(meta1.nextAt, meta1.builtAt + 15 * 60_000); // 예약 시각을 모르면 간격만큼 뒤

    // 다음 예약 실행 시각: UTC 0:07과 12:07(한국 시간 9시·21시 무렵)
    const { nextRun } = require(path.join(root, 'lib/build'));
    const sched = { every: 12 * 3_600_000, at: { hours: [0, 12], minute: 7 } };
    const next = (iso) => new Date(nextRun(Date.parse(iso), sched)).toISOString();
    assert.equal(next('2026-11-12T00:06:59Z'), '2026-11-12T00:07:00.000Z');
    assert.equal(next('2026-11-12T00:07:00Z'), '2026-11-12T12:07:00.000Z'); // 정각에 끝났으면 그다음 회차
    assert.equal(next('2026-11-12T05:30:00Z'), '2026-11-12T12:07:00.000Z'); // 푸시로 중간에 빌드해도 다음 예약 시각
    assert.equal(next('2026-12-31T12:07:01Z'), '2027-01-01T00:07:00.000Z');
    assert.deepEqual(require(path.join(root, 'config')).static.at, sched.at); // 워크플로 cron '7 0,12 * * *'과 같아야 한다
    assert.ok(periods.TYPES.every((t) => meta1.types[t].every((b) => b.hasData && b.version === 1)));
    const chart1 = JSON.parse(fs.readFileSync(path.join(out1, 'data/weekly.rolling.json'), 'utf8'));
    assert.deepEqual([chart1.version, chart1.items.length, chart1.items[0].gain], [1, 100, null]);

    // 한 시간 뒤, 캐시가 없는 새 기계에서 다시 빌드: 배포본에서 상태를 이어받아 최근 구간만 다시 받는다.
    for (const name of fs.readdirSync(path.join(out1, 'data/state'))) {
      const f = path.join(out1, 'data/state', name);
      const st = JSON.parse(fs.readFileSync(f, 'utf8'));
      st.fetchedAt -= 3_600_000;
      for (const p of st.history) p.t -= 3_600_000;
      fs.writeFileSync(f, JSON.stringify(st));
    }
    const served = (dir) => async (url) => {
      const f = path.join(dir, url.replace('https://example.test/site/', ''));
      const found = fs.existsSync(f);
      return { status: found ? 200 : 404, ok: found, text: async () => fs.readFileSync(f, 'utf8') };
    };
    extra = 7;
    const cfgB = { ...cfgA, dataDir: path.join(TMP, 'buildB') };
    const out2 = path.join(TMP, 'site2');
    const r2 = await build({ cfg: cfgB, out: out2, seedUrl: 'https://example.test/site/', search, fetchImpl: served(out1), ...quiet });
    assert.deepEqual([r2.loaded, r2.ran, r2.written], [11, 6, 11]); // 최근·진행 중 6개만 다시 확인
    const chart2 = JSON.parse(fs.readFileSync(path.join(out2, 'data/weekly.rolling.json'), 'utf8'));
    assert.deepEqual([chart2.version, chart2.items[0].gain, chart2.items[0].move, chart2.items[0].cmove], [2, 7, 0, 0]);
    const meta2 = JSON.parse(fs.readFileSync(path.join(out2, 'data/meta.json'), 'utf8'));
    const closed = meta2.types.weekly.find((b) => b.kind === 'closed');
    assert.equal(closed.version, 1); // 지난 주는 그대로 다시 실린다
    assert.ok(fs.existsSync(path.join(out2, `data/weekly.${closed.key}.json`)));

    // 배포본을 읽다가 오류가 나면(404가 아닌 실패) 쌓아 온 이력을 버리지 않도록 빌드를 멈춘다.
    const broken = async () => ({ status: 503, ok: false, text: async () => '' });
    const out3 = path.join(TMP, 'site3');
    await assert.rejects(build({ cfg: { ...cfgA, dataDir: path.join(TMP, 'buildC') }, out: out3, seedUrl: 'https://example.test/site/', search, fetchImpl: broken, ...quiet }), /HTTP 503/);
    assert.equal(fs.existsSync(out3), false);

    // 아무것도 못 받았으면 빈 사이트를 내지 않는다.
    const warn = console.warn;
    console.warn = () => {};
    const down = async () => { throw new GitHubError('GitHub에 연결하지 못했습니다 (ENOTFOUND)'); };
    await assert.rejects(build({ cfg: { ...cfgA, dataDir: path.join(TMP, 'buildD') }, out: path.join(TMP, 'site4'), search: down, ...quiet }), /하나도 없습니다/);
    console.warn = warn;
    ok('build: 써 내는 파일, 배포본에서 이어받기, 최근 구간만 재확인, 실패 시 덮어쓰지 않음');
  }

  // 12) Hugging Face: 좋아요순 목록을 훑어 기간에 나눠 담기
  {
    const { HfCollector, storeConfig } = require(path.join(root, 'lib/hfcollector'));
    const { HfError, readRate, slim } = require(path.join(root, 'lib/hf'));
    const DAYMS = 86_400_000;
    const today = periods.startOfDay(Date.now()).getTime();

    // API 응답 다루기
    const rate = readRate(new Headers({ ratelimit: '"api";r=499;t=229', 'ratelimit-policy': '"fixed window";"api";q=500;w=300' }), 1_000_000);
    assert.deepEqual(rate, { limit: 500, window: 300, remaining: 499, resetAt: 1_229_000 });
    assert.equal(readRate(new Headers({})), null);
    assert.deepEqual(
      slim({ _id: 'abc', id: 'Qwen/Q', likes: 5, downloads: 7, tags: ['transformers', 'license:mit'], pipeline_tag: 'text-generation', library_name: 'transformers', createdAt: '2026-01-01T00:00:00.000Z' }),
      { id: 'abc', name: 'Qwen/Q', owner: 'Qwen', avatar: '', url: 'https://huggingface.co/Qwen/Q', desc: '', lang: 'text-generation', stars: 5, downloads: 7, lib: 'transformers', license: 'mit', created: '2026-01-01T00:00:00.000Z' },
    );

    // 좋아요 내림차순 모델 2,500개. i번째 모델은 (i % 400)일 전에 만들어져, 어느 기간에든 드문드문 섞여 있다.
    const model = (i, created) => ({ id: `m${i}`, name: `org/model-${i}`, owner: 'org', avatar: '', url: `https://huggingface.co/org/model-${i}`, desc: '', lang: 'text-generation', stars: 5000 - i, downloads: 10, lib: 'transformers', license: 'mit', created });
    const models = Array.from({ length: 2500 }, (_, i) => model(i, new Date(today - (i % 400) * DAYMS + 3_600_000).toISOString()));
    let calls = 0;
    let bump = 0;
    const lister = (source) => async ({ cursor, limit }) => {
      calls += 1;
      const start = cursor ? Number(cursor) : 0;
      const items = source.slice(start, start + limit).map((m) => ({ ...m, stars: m.stars + bump }));
      return { items, next: start + limit < source.length ? String(start + limit) : null, rate: { limit: 500, window: 300, remaining: 400, resetAt: Date.now() + 1000 } };
    };
    const hfSetup = (name, list, hfOver = {}) => {
      const cfg = { ...baseCfg, dataDir: path.join(TMP, name), hf: { ...baseCfg.hf, token: '', pageSize: 500, maxPages: 10, ...hfOver } };
      const store = new Store(storeConfig(cfg));
      store.load();
      return { cfg, store, collector: new HfCollector({ cfg, store, list }) };
    };
    // 기간에 들어야 할 모델: 만든 날짜가 [from 0시, to 다음 날 0시) 안에 있는 것을 좋아요순으로 100개
    const expected = (desc, source) => {
      const from = Date.parse(desc.from);
      const to = desc.to ? Date.parse(desc.to) + DAYMS : Infinity;
      return source.filter((m) => Date.parse(m.created) >= from && Date.parse(m.created) < to).slice(0, 100).map((m) => m.id);
    };

    // 끝까지 훑는 경우: 모든 기간이 "만든 날짜로 거른 좋아요 상위 100개"와 같다.
    const a = hfSetup('hfA', lister(models));
    const r1 = await a.collector.run();
    assert.deepEqual([r1.pages, r1.exhausted, calls], [5, true, 5]);
    const descs = a.collector.descs();
    assert.equal(r1.buckets, descs.length);
    assert.equal(descs.filter((d) => d.type === 'yearly').pop().key, String(baseCfg.hf.firstYear));
    for (const d of descs) {
      assert.deepEqual(a.store.get(d.type, d.key).items.map((x) => x.id), expected(d, models), `${d.type}.${d.key}`);
    }
    const wk = a.store.get('weekly', 'rolling');
    assert.equal(wk.items.length, 56); // 최근 7일에 든 것은 56개뿐: 끝까지 훑었으므로 이것이 전부다
    assert.deepEqual([wk.items[0].name, wk.items[8].name, wk.items[8].rank, wk.items[8].crank, wk.items[8].spam], ['org/model-0', 'org/model-400', 9, 9, false]);
    assert.deepEqual([wk.cut, wk.total, JSON.parse(wk.body).cut], [0, null, undefined]);
    assert.equal(a.store.get('yearly', 'rolling').items[99].name, 'org/model-99');
    assert.ok(a.store.dir.endsWith(path.join('hfA', 'hf', 'cache'))); // GitHub 캐시와 섞이지 않는다

    // 다시 훑으면 지난 스냅샷과 비교한 증가가 나온다.
    for (const b of a.store.buckets.values()) for (const p of b.history) p.t -= 3_600_000;
    bump = 3;
    const r2 = await a.collector.run();
    assert.equal(r2.changed.size, descs.filter((d) => expected(d, models).length > 0).length); // 빈 기간(400일보다 오래된 구간)은 그대로
    const wk2 = a.store.get('weekly', 'rolling');
    assert.deepEqual([wk2.version, wk2.items[0].gain, wk2.items[0].move], [2, 3, 0]);
    bump = 0;

    // 쪽 수 상한에서 멈추는 경우: 덜 찬 기간에는 "여기까지만 훑었다"는 표시(cut)가 남는다.
    calls = 0;
    const b2 = hfSetup('hfB', lister(models), { maxPages: 2 });
    const r3 = await b2.collector.run();
    assert.deepEqual([r3.pages, r3.exhausted, r3.lowest, calls], [2, false, 4001, 2]);
    const cutWk = b2.store.get('weekly', 'rolling');
    assert.deepEqual([cutWk.items.length, cutWk.cut, JSON.parse(cutWk.body).cut], [24, 4001, 4001]);
    assert.equal(b2.store.get('yearly', 'rolling').cut, 0); // 100개가 찬 기간에는 표시하지 않는다

    // 모든 기간이 차면 더 받지 않는다.
    calls = 0;
    const fresh = Array.from({ length: 2500 }, (_, i) => model(i, new Date(today).toISOString()));
    const c3 = hfSetup('hfC', lister(fresh), { listed: { weekly: 0, monthly: 0 }, firstYear: new Date(today).getUTCFullYear() });
    const r4 = await c3.collector.run();
    assert.deepEqual([r4.pages, r4.buckets, calls], [1, 5, 1]); // 최근 7일·이번 주·최근 30일·이번 달·올해(최근 365일은 시작 연도 이전에 걸쳐 빠진다)

    // 실패하면 아무것도 바꾸지 않고, 한도 초과면 풀릴 때까지 쉰다. 빌드에서는 기다리다 시간을 넘기지 않는다.
    const warn = console.warn;
    console.warn = () => {};
    let n = 0;
    const flaky = async (args) => {
      n += 1;
      if (n === 2) throw new HfError('Too Many Requests', { status: 429, retryAfter: 120 });
      return lister(models)(args);
    };
    const d4 = hfSetup('hfD', flaky);
    assert.equal(await d4.collector.run(), null);
    assert.equal(d4.store.buckets.size, 0);
    assert.ok(d4.collector.pauseUntil - Date.now() > 100_000);
    assert.equal(d4.collector.bucketStatus(d4.collector.find('weekly', 'rolling')).error, 'Hugging Face API 요청 한도를 넘었습니다');
    assert.deepEqual(await d4.collector.drain(Date.now() + 1000), { ran: 0, failed: 0, left: 1 }); // 2분을 기다리지 않고 바로 돌아온다
    assert.equal(n, 2); // 쉬는 동안에는 부르지 않는다
    console.warn = warn;

    // 서버: data/hf/ 주소, meta.hf, 수동 갱신
    const { createApp } = require(path.join(root, 'server'));
    const gh = setup('hfRoutes', async () => ({ total: 100, incomplete: false, items: page(100, 3000), rate: FAST }));
    const { server, close } = createApp({ store: gh.store, collector: gh.collector, extra: { hf: { store: a.store, collector: a.collector } } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const meta = await (await fetch(`${base}/data/meta.json`)).json();
    assert.equal(meta.hf.types.weekly[0].hasData, true);
    assert.equal(meta.hf.types.yearly.length, 2 + new Date(today).getUTCFullYear() - baseCfg.hf.firstYear);
    let res = await fetch(`${base}/data/hf/weekly.rolling.json?v=2`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).items[0].name, 'org/model-0');
    assert.equal((await fetch(`${base}/data/hf/weekly.2099-W01.json`)).status, 404);
    assert.equal((await fetch(`${base}/data/hf/yearly.2020.json`)).status, 404); // 목록(2023년부터) 밖
    res = await fetch(`${base}/api/refresh?src=hf&type=weekly&key=rolling`, { method: 'POST' });
    assert.equal(res.status, 429); // 방금 훑었으므로 쿨다운
    assert.equal((await fetch(`${base}/api/refresh?src=nope&type=weekly&key=rolling`, { method: 'POST' })).status, 404);
    close();
    server.closeAllConnections();
    ok('hugging face: 기간에 나눠 담기, 증가, 쪽 상한 표시, 일찍 멈춤, 실패 처리, 서버 주소');
  }

  // 13) 정적 사이트 빌드에 Hugging Face 싣기
  {
    const { build } = require(path.join(root, 'lib/build'));
    const { HfError } = require(path.join(root, 'lib/hf'));
    const today = periods.startOfDay(Date.now()).getTime();
    const search = async () => ({ total: 1000, incomplete: false, items: page(100, 5000), rate: FAST });
    let bump = 0;
    const models = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, name: `org/model-${i}`, owner: 'org', avatar: '', url: `https://huggingface.co/org/model-${i}`, desc: '', lang: 'text-to-image', stars: 900 - i, downloads: 1, lib: '', license: '', created: new Date(today).toISOString() }));
    const hfList = async () => ({ items: models.map((m) => ({ ...m, stars: m.stars + bump })), next: null, rate: null });
    const quiet = { log: () => {} };
    const year = new Date(today).getUTCFullYear();
    const cfgH = {
      ...baseCfg, as: null, token: '', dataDir: path.join(TMP, 'buildH'), listed: { weekly: 0, monthly: 0 }, firstYear: year,
      static: { every: 15 * 60_000, budget: 2000 },
      hf: { ...baseCfg.hf, token: '', listed: { weekly: 0, monthly: 0 }, firstYear: year },
    };
    const out1 = path.join(TMP, 'siteH1');
    const r1 = await build({ cfg: cfgH, out: out1, search, api: { hf: hfList }, ...quiet });
    assert.deepEqual([r1.written, r1.hf.written, r1.hf.loaded, r1.hf.ran, r1.hf.failed], [5, 5, 0, 1, 0]);
    for (const f of ['data/weekly.rolling.json', 'data/hf/weekly.rolling.json', 'data/hf/state/weekly.rolling.json', `data/hf/yearly.${year}.json`]) {
      assert.ok(fs.existsSync(path.join(out1, f)), f);
    }
    const meta1 = JSON.parse(fs.readFileSync(path.join(out1, 'data/meta.json'), 'utf8'));
    assert.equal(meta1.types.weekly[0].hasData, true); // GitHub 쪽은 그대로 meta 바로 아래
    assert.ok(periods.TYPES.every((t) => meta1.hf.types[t].every((b) => b.hasData && b.version === 1 && !b.error)));
    assert.equal(meta1.hf.top, 100);
    const hfChart = JSON.parse(fs.readFileSync(path.join(out1, 'data/hf/weekly.rolling.json'), 'utf8'));
    assert.deepEqual([hfChart.items.length, hfChart.items[0].name, hfChart.items[0].stars, hfChart.items[0].spam, hfChart.skipped], [100, 'org/model-0', 900, false, 0]);
    const ghChart = JSON.parse(fs.readFileSync(path.join(out1, 'data/weekly.rolling.json'), 'utf8'));
    assert.equal(ghChart.items[0].name, 'o/r1'); // 두 출처의 순위가 섞이지 않는다

    // 새 기계에서 다시 빌드: Hugging Face 상태도 배포본에서 이어받아 증가를 계산한다.
    for (const dir of ['data/state', 'data/hf/state']) {
      for (const name of fs.readdirSync(path.join(out1, dir))) {
        const f = path.join(out1, dir, name);
        const st = JSON.parse(fs.readFileSync(f, 'utf8'));
        st.fetchedAt -= 3_600_000;
        for (const p of st.history) p.t -= 3_600_000;
        fs.writeFileSync(f, JSON.stringify(st));
      }
    }
    const served = (dir) => async (url) => {
      const f = path.join(dir, url.replace('https://example.test/site/', ''));
      const found = fs.existsSync(f);
      return { status: found ? 200 : 404, ok: found, text: async () => fs.readFileSync(f, 'utf8') };
    };
    bump = 5;
    const out2 = path.join(TMP, 'siteH2');
    const r2 = await build({ cfg: { ...cfgH, dataDir: path.join(TMP, 'buildH2') }, out: out2, seedUrl: 'https://example.test/site/', search, api: { hf: hfList }, fetchImpl: served(out1), ...quiet });
    assert.deepEqual([r2.loaded, r2.hf.loaded, r2.hf.written], [5, 5, 5]);
    const hfChart2 = JSON.parse(fs.readFileSync(path.join(out2, 'data/hf/weekly.rolling.json'), 'utf8'));
    assert.deepEqual([hfChart2.version, hfChart2.items[0].gain, hfChart2.items[0].move], [2, 5, 0]);

    // Hugging Face가 실패해도 빌드는 끝난다: 이어받은 순위를 그대로 다시 싣고, 실패했다는 표시를 남긴다.
    const warn = console.warn;
    console.warn = () => {};
    const down = async () => { throw new HfError('Hugging Face에 연결하지 못했습니다 (ENOTFOUND)'); };
    const out3 = path.join(TMP, 'siteH3');
    const r3 = await build({ cfg: { ...cfgH, dataDir: path.join(TMP, 'buildH3') }, out: out3, seedUrl: 'https://example.test/site/', search, api: { hf: down }, fetchImpl: served(out2), ...quiet });
    assert.deepEqual([r3.written, r3.hf.written, r3.hf.loaded, r3.hf.ran, r3.hf.failed], [5, 5, 5, 0, 1]);
    const meta3 = JSON.parse(fs.readFileSync(path.join(out3, 'data/meta.json'), 'utf8'));
    assert.match(meta3.hf.types.weekly[0].error, /연결하지 못했습니다/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out3, 'data/hf/weekly.rolling.json'), 'utf8')).version, 2);

    // 이어받은 것도 없이 실패하면 Hugging Face 탭 없이 낸다.
    const out4 = path.join(TMP, 'siteH4');
    const r4 = await build({ cfg: { ...cfgH, dataDir: path.join(TMP, 'buildH4') }, out: out4, search, api: { hf: down }, ...quiet });
    assert.deepEqual([r4.written, r4.hf.written], [5, 0]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out4, 'data/meta.json'), 'utf8')).hf, undefined);
    console.warn = warn;
    ok('build + hugging face: data/hf/ 파일, 배포본에서 이어받기, 실패해도 GitHub 순위는 낸다');
  }

  // 14) App Store: 차트 순위를 그대로 싣고, 평가 수는 묶어서 조회한다
  {
    const { AsCollector, storeConfig } = require(path.join(root, 'lib/ascollector'));
    const { AppStoreError, slim } = require(path.join(root, 'lib/appstore'));
    const { build } = require(path.join(root, 'lib/build'));

    // 피드 항목 다루기: 가장 큰 아이콘, 앱 페이지 주소, 유료일 때만 가격, 출시일은 UTC로
    const entry = {
      'im:name': { label: '디노몬' },
      'im:image': [{ label: 'https://x.test/53.png' }, { label: 'https://x.test/100.png' }],
      'im:price': { label: '￦400', attributes: { amount: '400', currency: 'KRW' } },
      link: [{ attributes: { rel: 'alternate', href: 'https://apps.apple.com/kr/app/x/id1?uo=2' } }, { attributes: { rel: 'enclosure', href: 'https://x.test/preview.png' } }],
      id: { label: 'https://apps.apple.com/kr/app/x/id1?uo=2', attributes: { 'im:id': '1' } },
      'im:artist': { label: 'SOTHAM KIM' },
      category: { attributes: { 'im:id': '6014', label: '게임' } },
      'im:releaseDate': { label: '2026-10-29T00:00:00-07:00' },
    };
    assert.deepEqual(slim(entry), { id: '1', name: '디노몬', owner: 'SOTHAM KIM', avatar: 'https://x.test/100.png', url: 'https://apps.apple.com/kr/app/x/id1?uo=2', desc: '', lang: '게임', price: '￦400', created: '2026-10-29T07:00:00.000Z' });
    const freeApp = slim({ ...entry, 'im:price': { label: '무료', attributes: { amount: '0' } }, link: { attributes: { rel: 'alternate', href: 'javascript:alert(1)' } }, 'im:image': undefined });
    assert.deepEqual([freeApp.price, freeApp.url, freeApp.avatar], ['', '', '']); // https가 아닌 주소는 버린다

    // 가짜 스토어: 차트 6개(종류 3 × 종합·게임)가 서로 겹치는 앱 270개를 담고 있다.
    const app = (n) => ({ id: String(n), name: `App ${n}`, owner: `Dev ${n % 7}`, avatar: '', url: `https://apps.apple.com/kr/app/x/id${n}`, desc: '', lang: n % 2 ? '게임' : '금융', price: '', created: '2026-01-01T00:00:00.000Z' });
    const world = { shuffled: false, bump: 0, failing: new Set(), lookupStatus: 0, feeds: 0, lookups: [] };
    const fetchChart = async ({ country, kind, genre, limit }) => {
      world.feeds += 1;
      assert.equal(country, 'kr');
      if (world.failing.has(`${kind}/${genre}`) || world.failing.has('*')) throw new AppStoreError('HTTP 503', { status: 503 });
      const base = { free: 0, paid: 1000, grossing: 50 }[kind] + (genre === 'all' ? 0 : 10);
      const ids = Array.from({ length: limit }, (_, i) => base + i);
      if (world.shuffled) {
        [ids[0], ids[1]] = [ids[1], ids[0]]; // 1·2위가 자리를 바꾸고
        ids[limit - 1] = base + 5000; // 100위에 새 앱이 들어온다
      }
      return ids.map(app);
    };
    const lookup = async ({ ids }) => {
      world.lookups.push(ids.length);
      if (world.lookupStatus) throw new AppStoreError(`HTTP ${world.lookupStatus}`, { status: world.lookupStatus });
      // 끝자리가 9인 앱은 조회되지 않는다(스토어에서 내려간 앱 등).
      return ids.filter((id) => Number(id) % 10 !== 9).map((id) => ({ id, stars: Number(id) * 2 + world.bump, rating: 4.5 }));
    };
    const asCfg = (name, over = {}) => ({
      ...baseCfg, hf: null, token: '', dataDir: path.join(TMP, name),
      as: { ...baseCfg.as, genres: [['all', '종합'], ['6014', '게임']], concurrency: 2, lookupBatch: 150, lookupSpacing: 0, ...over },
    });
    const asSetup = (name) => {
      const cfg = asCfg(name);
      const store = new Store(storeConfig(cfg));
      store.load();
      return { cfg, store, collector: new AsCollector({ cfg, store, fetchChart, lookup }) };
    };

    const a = asSetup('asA');
    const meta0 = a.collector.meta();
    assert.deepEqual(Object.keys(meta0.types), ['free', 'paid', 'grossing']);
    assert.deepEqual(meta0.types.paid.map((b) => `${b.key}:${b.label}:${b.kind}:${b.hasData}`), ['all:종합:chart:false', '6014:게임:chart:false']);
    assert.equal(meta0.country, 'kr');

    const r1 = await a.collector.run();
    // 피드 6번 + 조회 2번(고유 앱 270개를 150개씩). 조회되지 않은 앱은 차트마다 10개씩.
    assert.deepEqual([r1.pages, r1.buckets, r1.failed, r1.apps, r1.unrated, world.feeds], [8, 6, 0, 270, 60, 6]);
    assert.deepEqual(world.lookups, [150, 120]);
    const free = a.store.get('free', 'all');
    assert.equal(free.items.length, 100);
    // 평가 수가 적은 앱이 위에 있어도 차트 순서 그대로다.
    assert.deepEqual(free.items.slice(0, 3).map((x) => [x.rank, x.id, x.stars, x.rating]), [[1, '0', 0, 4.5], [2, '1', 2, 4.5], [3, '2', 4, 4.5]]);
    assert.deepEqual([free.items[9].id, free.items[9].stars, free.items[9].rating], ['9', 0, null]); // 조회되지 않은 앱
    assert.deepEqual([free.items[0].spam, free.items[0].crank, free.total], [false, 1, null]);
    assert.equal(a.store.get('paid', '6014').items[0].id, '1010');
    assert.ok(a.store.dir.endsWith(path.join('asA', 'as', 'cache')));

    // 다시 받으면 순위 변동, 새로 진입한 앱, 평가 증가가 나온다.
    for (const b of a.store.buckets.values()) for (const p of b.history) p.t -= 3_600_000;
    world.shuffled = true;
    world.bump = 5;
    const r2 = await a.collector.run();
    assert.equal(r2.changed.size, 6);
    const free2 = a.store.get('free', 'all');
    assert.deepEqual(free2.items.slice(0, 2).map((x) => [x.id, x.rank, x.move, x.gain]), [['1', 1, 1, 5], ['0', 2, -1, 5]]);
    assert.deepEqual([free2.items[99].id, free2.items[99].move, free2.items[99].gain], ['5000', 'new', null]);

    // 평가 수 조회가 한도에 걸리면 더 부르지 않고 지난번 값을 이어 쓴다(평가가 0으로 떨어져 보이지 않게). 순위는 새로 싣는다.
    const warn = console.warn;
    console.warn = () => {};
    world.lookups = [];
    world.lookupStatus = 403;
    world.shuffled = false;
    const r3 = await a.collector.run();
    assert.deepEqual([world.lookups.length, r3.failed], [1, 0]);
    const free3 = a.store.get('free', 'all');
    assert.deepEqual([free3.items[0].id, free3.items[0].stars, free3.items[0].gain, free3.items[1].stars], ['0', 5, 5, 7]);
    // 한도가 아닌 오류라도 세 번 잇달아 실패하면 그만둔다(응답 없는 서버를 끝까지 기다리지 않는다).
    world.lookups = [];
    world.lookupStatus = 500;
    a.cfg.as.lookupBatch = 30; // 270개 → 9묶음
    const r3b = await a.collector.run();
    assert.deepEqual([world.lookups.length, r3b.failed, a.store.get('free', 'all').items[1].stars], [3, 0, 7]);
    a.cfg.as.lookupBatch = 150;
    world.lookupStatus = 0;

    // 차트 하나만 실패하면 그 차트만 이전 것을 두고 표시를 남긴다.
    world.failing.add('paid/6014');
    const before = a.store.get('paid', '6014').version;
    const r4 = await a.collector.run();
    assert.equal(r4.failed, 1);
    assert.equal(a.store.get('paid', '6014').version, before);
    assert.equal(a.collector.bucketStatus(a.collector.find('paid', '6014')).error, 'HTTP 503');
    assert.equal(a.collector.bucketStatus(a.collector.find('paid', 'all')).error, null);
    world.failing.clear();
    await a.collector.run();
    assert.equal(a.collector.bucketStatus(a.collector.find('paid', '6014')).error, null);

    // 전부 실패하면 아무것도 바꾸지 않는다.
    world.failing.add('*');
    const versions = () => [...a.store.buckets.values()].map((b) => b.version).join(',');
    const v0 = versions();
    assert.equal(await a.collector.run(), null);
    assert.equal(versions(), v0);
    assert.equal(a.collector.bucketStatus(a.collector.find('free', 'all')).error, 'HTTP 503');

    // 차트가 많아도 잇달아 8번 실패하면 남은 것은 보내지 않는다.
    const many = asCfg('asMany', { genres: Array.from({ length: 12 }, (_, i) => [String(7000 + i), `분류 ${i}`]) });
    const manyStore = new Store(storeConfig(many));
    manyStore.load();
    world.feeds = 0;
    assert.equal(await new AsCollector({ cfg: many, store: manyStore, fetchChart, lookup }).run(), null);
    assert.ok(world.feeds >= 8 && world.feeds <= 9, `피드 요청 ${world.feeds}번`);
    world.failing.clear();
    console.warn = warn;

    // 서버: data/as/ 주소와 meta.as
    const { createApp } = require(path.join(root, 'server'));
    const gh = setup('asRoutes', async () => ({ total: 100, incomplete: false, items: page(100, 3000), rate: FAST }));
    const { server, close } = createApp({ store: gh.store, collector: gh.collector, extra: { as: { store: a.store, collector: a.collector } } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const meta = await (await fetch(`${base}/data/meta.json`)).json();
    assert.deepEqual([meta.as.country, meta.as.types.grossing[1].label, meta.as.types.free[0].hasData, meta.hf], ['kr', '게임', true, undefined]);
    let res = await fetch(`${base}/data/as/free.all.json`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).items[0].name, 'App 0');
    assert.equal((await fetch(`${base}/data/as/free.9999.json`)).status, 404); // 받지 않는 카테고리
    assert.equal((await fetch(`${base}/data/as/weekly.rolling.json`)).status, 404);
    assert.equal((await fetch(`${base}/data/free.all.json`)).status, 404); // GitHub 쪽에는 없는 종류
    assert.equal((await fetch(`${base}/api/refresh?src=as&type=free&key=all`, { method: 'POST' })).status, 429);
    close();
    server.closeAllConnections();

    // 빌드: data/as/ 아래에 쓰고, 다음 빌드가 배포본에서 이어받는다.
    const year = new Date().getUTCFullYear();
    const search = async () => ({ total: 1000, incomplete: false, items: page(100, 5000), rate: FAST });
    const quiet = { log: () => {} };
    const cfgS = { ...asCfg('buildS'), listed: { weekly: 0, monthly: 0 }, firstYear: year, static: { every: 15 * 60_000, budget: 5000 } };
    world.bump = 0;
    const out1 = path.join(TMP, 'siteS1');
    const b1 = await build({ cfg: cfgS, out: out1, search, api: { as: { fetchChart, lookup } }, ...quiet });
    assert.deepEqual([b1.written, b1.hf, b1.as.written, b1.as.loaded, b1.as.ran, b1.as.failed], [5, null, 6, 0, 8, 0]);
    for (const f of ['data/as/free.all.json', 'data/as/grossing.6014.json', 'data/as/state/paid.all.json']) assert.ok(fs.existsSync(path.join(out1, f)), f);
    const metaS = JSON.parse(fs.readFileSync(path.join(out1, 'data/meta.json'), 'utf8'));
    assert.deepEqual([metaS.as.country, metaS.as.types.free.length, metaS.as.types.free[1].version, metaS.hf], ['kr', 2, 1, undefined]);
    for (const name of fs.readdirSync(path.join(out1, 'data/as/state'))) {
      const f = path.join(out1, 'data/as/state', name);
      const st = JSON.parse(fs.readFileSync(f, 'utf8'));
      st.fetchedAt -= 3_600_000;
      for (const p of st.history) p.t -= 3_600_000;
      fs.writeFileSync(f, JSON.stringify(st));
    }
    const served = (dir) => async (url) => {
      const f = path.join(dir, url.replace('https://example.test/site/', ''));
      const found = fs.existsSync(f);
      return { status: found ? 200 : 404, ok: found, text: async () => fs.readFileSync(f, 'utf8') };
    };
    world.bump = 3;
    const out2 = path.join(TMP, 'siteS2');
    const b2 = await build({ cfg: { ...cfgS, dataDir: path.join(TMP, 'buildS2') }, out: out2, seedUrl: 'https://example.test/site/', search, api: { as: { fetchChart, lookup } }, fetchImpl: served(out1), ...quiet });
    assert.deepEqual([b2.as.loaded, b2.as.written], [6, 6]);
    const chartS = JSON.parse(fs.readFileSync(path.join(out2, 'data/as/free.all.json'), 'utf8'));
    assert.deepEqual([chartS.version, chartS.items[1].gain, chartS.items[1].move, chartS.from], [2, 3, 0, undefined]);
    ok('app store: 차트 순서, 순위 변동·신규·평가 증가, 조회 실패 시 이어 쓰기, 일부 실패, 서버 주소, 빌드');
  }

  // 15) Hacker News: 기간마다 점수순으로 검색하고, 끝난 기간은 가끔만 다시 확인한다
  {
    const { HnCollector, storeConfig } = require(path.join(root, 'lib/hncollector'));
    const { HnError, slim } = require(path.join(root, 'lib/hn'));
    const { build } = require(path.join(root, 'lib/build'));
    const DAYMS = 86_400_000;
    const today = periods.startOfDay(Date.now()).getTime();
    const year = new Date(today).getUTCFullYear();

    // 검색 결과 다루기: 원문 주소와 사이트, 토론 페이지
    assert.deepEqual(
      slim({ objectID: '123', title: 'Show HN: X', url: 'https://www.example.com/a/b?c=1', author: 'pg', points: 42, num_comments: 7, created_at_i: 1_700_000_000 }),
      { id: '123', name: 'Show HN: X', owner: 'pg', avatar: '', url: 'https://www.example.com/a/b?c=1', hn: 'https://news.ycombinator.com/item?id=123', desc: '', lang: 'example.com', stars: 42, comments: 7, created: '2023-11-14T22:13:20.000Z' },
    );
    // 본문만 있는 글이나 주소가 http(s)가 아닌 글은 토론 페이지로 잇는다.
    const ask = slim({ objectID: '9', title: 'Ask HN: ?', author: 'a', points: null, created_at_i: 0 });
    assert.deepEqual([ask.url, ask.lang, ask.stars, ask.comments], ['https://news.ycombinator.com/item?id=9', 'news.ycombinator.com', 0, 0]);
    assert.equal(slim({ objectID: '9', title: 't', url: 'javascript:alert(1)', created_at_i: 0 }).url, 'https://news.ycombinator.com/item?id=9');
    assert.equal(slim({ objectID: '9', title: 't', url: 'http://old.example.org/x', created_at_i: 0 }).lang, 'old.example.org');

    // 가짜 검색: 점수 내림차순 글 3,000개. i번째 글은 (i % 500)일 전에 올라왔다.
    const story = (i) => ({ id: `s${i}`, name: `Story ${i}`, owner: `u${i % 9}`, avatar: '', url: `https://site${i % 5}.example/${i}`, hn: `https://news.ycombinator.com/item?id=${i}`, desc: '', lang: `site${i % 5}.example`, stars: 9000 - i, comments: i % 50, created: new Date(today - (i % 500) * DAYMS + 3_600_000).toISOString() });
    const stories = Array.from({ length: 3000 }, (_, i) => story(i));
    const world = { calls: [], bump: 0, failing: new Set(), status: 503 };
    const search = async ({ from, to, limit }) => {
      world.calls.push(`${from}..${to}`);
      if (world.failing.has('*') || world.failing.has(`${from}..${to}`)) throw new HnError(`HTTP ${world.status}`, { status: world.status });
      const a = Date.parse(from);
      const b = to ? Date.parse(to) + DAYMS : Infinity; // to는 그날 끝까지
      const hit = stories.filter((s) => Date.parse(s.created) >= a && Date.parse(s.created) < b);
      // 글이 많은 기간은 개수를 정확히 세지 못한다(total: null).
      return { items: hit.slice(0, limit).map((s) => ({ ...s, stars: s.stars + world.bump })), total: hit.length < 1000 ? hit.length : null };
    };
    // 주간 5개(최근 7일, 이번 주, 지난 3주) + 월간 4개 + 연간 5개(최근 365일, 올해부터 3년 전까지) = 14개 기간
    const hnCfg = (name) => ({
      ...baseCfg, hf: null, as: null, token: '', dataDir: path.join(TMP, name),
      hn: { ...fullCfg.hn, listed: { weekly: 3, monthly: 2 }, firstYear: year - 3, concurrency: 3 },
    });
    const hnSetup = (name) => {
      const cfg = hnCfg(name);
      const store = new Store(storeConfig(cfg));
      store.load();
      return { cfg, store, collector: new HnCollector({ cfg, store, search }) };
    };

    const a = hnSetup('hnA');
    const descs = a.collector.descs();
    assert.equal(descs.length, 14);
    const r1 = await a.collector.run();
    assert.deepEqual([r1.pages, r1.buckets, r1.failed, r1.skipped, world.calls.length], [14, 14, 0, 0, 14]);
    // 기간마다 그 기간에 올라온 글의 점수 상위 100개와 같다.
    for (const d of descs) {
      const from = Date.parse(d.from);
      const to = d.to ? Date.parse(d.to) + DAYMS : Infinity;
      const want = stories.filter((s) => Date.parse(s.created) >= from && Date.parse(s.created) < to).slice(0, 100).map((s) => s.id);
      assert.deepEqual(a.store.get(d.type, d.key).items.map((x) => x.id), want, `${d.type}.${d.key}`);
    }
    const wk = a.store.get('weekly', 'rolling');
    assert.deepEqual([wk.items.length, wk.total, wk.items[0].name, wk.items[0].rank, wk.items[0].comments, wk.items[0].spam], [48, 48, 'Story 0', 1, 0, false]);
    assert.equal(wk.items[1].hn, 'https://news.ycombinator.com/item?id=1');
    assert.equal(a.store.get('yearly', 'rolling').total, null); // 정확히 세지 못한 개수는 싣지 않는다
    assert.ok(a.store.dir.endsWith(path.join('hnA', 'hn', 'cache')));

    // 바로 다시 훑으면 진행 중인 기간(최근 N일, 이번 주·달·해) 6개만 다시 받는다. 끝난 기간은 건너뛴다.
    for (const b of a.store.buckets.values()) for (const p of b.history) p.t -= 3_600_000;
    world.calls = [];
    world.bump = 4;
    const r2 = await a.collector.run();
    assert.deepEqual([r2.pages, r2.buckets, r2.skipped, world.calls.length], [6, 6, 8, 6]);
    assert.ok(world.calls.every((c) => c.endsWith('..null') || descs.some((d) => d.kind === 'current' && c === `${d.from}..${d.to}`)));
    const wk2 = a.store.get('weekly', 'rolling');
    assert.deepEqual([wk2.version, wk2.items[0].stars, wk2.items[0].gain, wk2.items[0].move], [2, 9004, 4, 0]);
    const closed = descs.find((d) => d.type === 'weekly' && d.kind === 'closed');
    assert.equal(a.store.get('weekly', closed.key).version, 1);

    // 끝난 기간은 GitHub과 같은 주기로 다시 확인한다: 오래된 연도는 7일에 한 번.
    const old = a.collector.find('yearly', String(year - 3));
    const oldBucket = a.store.get('yearly', old.key);
    oldBucket.fetchedAt = Date.now() - 6 * DAYMS;
    assert.equal(a.collector.due(old, Date.now()), false);
    oldBucket.fetchedAt = Date.now() - 8 * DAYMS;
    assert.equal(a.collector.due(old, Date.now()), true);
    world.calls = [];
    const r3 = await a.collector.run();
    assert.deepEqual([r3.pages, world.calls.includes(`${old.from}..${old.to}`)], [7, true]);

    // 한 기간만 실패하면 그 기간만 이전 순위를 두고 표시를 남긴다.
    const warn = console.warn;
    console.warn = () => {};
    const rolling = a.collector.find('weekly', 'rolling');
    world.failing.add(`${rolling.from}..null`);
    const r4 = await a.collector.run();
    assert.deepEqual([r4.failed, a.store.get('weekly', 'rolling').version], [1, 2]);
    assert.equal(a.collector.bucketStatus(rolling).error, 'HTTP 503');
    assert.equal(a.collector.bucketStatus(a.collector.find('monthly', 'rolling')).error, null);
    world.failing.clear();
    await a.collector.run();
    assert.equal(a.collector.bucketStatus(rolling).error, null);

    // 전부 실패하면 아무것도 바꾸지 않는다. 한도 초과(429)면 풀릴 때까지 쉬고, 빌드에서는 기다리다 시간을 넘기지 않는다.
    const versions = () => [...a.store.buckets.values()].map((b) => b.version).join(',');
    const v0 = versions();
    world.failing.add('*');
    world.status = 429;
    assert.equal(await a.collector.run(), null);
    assert.equal(versions(), v0);
    assert.equal(a.collector.bucketStatus(rolling).error, 'Hacker News API 요청 한도를 넘었습니다');
    assert.ok(a.collector.pauseUntil - Date.now() > 50_000);
    assert.deepEqual(await a.collector.drain(Date.now() + 1000), { ran: 0, failed: 0, left: 1 });

    // 서버가 아예 답하지 않으면(잇달아 8번 실패) 남은 기간은 보내지 않는다.
    world.status = 503;
    world.calls = [];
    const b = hnSetup('hnB');
    assert.equal(await b.collector.run(), null);
    assert.ok(world.calls.length >= 8 && world.calls.length <= 10, `검색 ${world.calls.length}번`);
    assert.equal(b.store.buckets.size, 0);
    world.failing.clear();
    console.warn = warn;

    // 서버: data/hn/ 주소와 meta.hn
    const { createApp } = require(path.join(root, 'server'));
    const gh = setup('hnRoutes', async () => ({ total: 100, incomplete: false, items: page(100, 3000), rate: FAST }));
    const { server, close } = createApp({ store: gh.store, collector: gh.collector, extra: { hn: { store: a.store, collector: a.collector } } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const meta = await (await fetch(`${base}/data/meta.json`)).json();
    assert.deepEqual([meta.hn.types.weekly.length, meta.hn.types.yearly.length, meta.hn.types.weekly[0].hasData, meta.hf, meta.as], [5, 5, true, undefined, undefined]);
    const res = await fetch(`${base}/data/hn/weekly.rolling.json`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).items[0].name, 'Story 0');
    assert.equal((await fetch(`${base}/data/hn/yearly.1999.json`)).status, 404); // 목록 밖
    assert.equal((await fetch(`${base}/data/hf/weekly.rolling.json`)).status, 404); // 켜지 않은 출처
    assert.equal((await fetch(`${base}/api/refresh?src=hn&type=weekly&key=rolling`, { method: 'POST' })).status, 429); // 방금 받았으므로 쿨다운
    close();
    server.closeAllConnections();

    // 빌드: data/hn/ 아래에 쓰고, 다음 빌드는 배포본에서 이어받아 진행 중인 기간만 다시 받는다.
    const ghSearch = async () => ({ total: 1000, incomplete: false, items: page(100, 5000), rate: FAST });
    const quiet = { log: () => {} };
    const cfgN = { ...hnCfg('buildN'), listed: { weekly: 0, monthly: 0 }, firstYear: year, static: { every: 15 * 60_000, budget: 5000 } };
    world.bump = 0;
    world.calls = [];
    const out1 = path.join(TMP, 'siteN1');
    const b1 = await build({ cfg: cfgN, out: out1, search: ghSearch, api: { hn: search }, ...quiet });
    assert.deepEqual([b1.written, b1.hf, b1.as, b1.hn.written, b1.hn.loaded, b1.hn.ran, b1.hn.failed], [5, null, null, 14, 0, 14, 0]);
    for (const f of ['data/hn/weekly.rolling.json', `data/hn/yearly.${year - 3}.json`, 'data/hn/state/monthly.rolling.json']) assert.ok(fs.existsSync(path.join(out1, f)), f);
    const metaN = JSON.parse(fs.readFileSync(path.join(out1, 'data/meta.json'), 'utf8'));
    assert.deepEqual([metaN.hn.types.weekly.length, metaN.hn.types.yearly[4].key, metaN.hn.types.yearly[4].version, metaN.hf], [5, String(year - 3), 1, undefined]);
    for (const name of fs.readdirSync(path.join(out1, 'data/hn/state'))) {
      const f = path.join(out1, 'data/hn/state', name);
      const st = JSON.parse(fs.readFileSync(f, 'utf8'));
      st.fetchedAt -= 3_600_000;
      for (const p of st.history) p.t -= 3_600_000;
      fs.writeFileSync(f, JSON.stringify(st));
    }
    const served = (dir) => async (url) => {
      const f = path.join(dir, url.replace('https://example.test/site/', ''));
      const found = fs.existsSync(f);
      return { status: found ? 200 : 404, ok: found, text: async () => fs.readFileSync(f, 'utf8') };
    };
    world.bump = 2;
    world.calls = [];
    const out2 = path.join(TMP, 'siteN2');
    const b2 = await build({ cfg: { ...cfgN, dataDir: path.join(TMP, 'buildN2') }, out: out2, seedUrl: 'https://example.test/site/', search: ghSearch, api: { hn: search }, fetchImpl: served(out1), ...quiet });
    assert.deepEqual([b2.hn.loaded, b2.hn.written, b2.hn.ran, world.calls.length], [14, 14, 6, 6]);
    const chartN = JSON.parse(fs.readFileSync(path.join(out2, 'data/hn/weekly.rolling.json'), 'utf8'));
    assert.deepEqual([chartN.version, chartN.total, chartN.items[0].gain, chartN.items[0].move, chartN.items[0].comments], [2, 48, 2, 0, 0]);
    ok('hacker news: 기간별 점수순, 끝난 기간은 가끔만 재확인, 증가, 일부·전체 실패, 한도 초과, 서버 주소, 빌드');
  }

  // 16) Hugging Face Space·데이터셋: 같은 수집기를 종류만 바꿔 쓰고, 빌드에서는 한도를 나눠 쓰므로 차례로 받는다
  {
    const { slimSpace, slimDataset, KINDS, HfError } = require(path.join(root, 'lib/hf'));
    const sources = require(path.join(root, 'lib/sources'));
    const { build } = require(path.join(root, 'lib/build'));
    const today = periods.startOfDay(Date.now()).getTime();
    const year = new Date(today).getUTCFullYear();

    // 항목 다루기: 주소와 분류가 종류마다 다르다(Space는 SDK, 데이터셋은 첫 번째 형태).
    assert.deepEqual(
      slimSpace({ _id: 's1', id: 'org/demo', likes: 9, sdk: 'gradio', tags: ['gradio', 'region:us'], createdAt: '2026-01-01T00:00:00.000Z' }),
      { id: 's1', name: 'org/demo', owner: 'org', avatar: '', url: 'https://huggingface.co/spaces/org/demo', desc: '', lang: 'gradio', stars: 9, created: '2026-01-01T00:00:00.000Z' },
    );
    assert.deepEqual(
      slimDataset({ _id: 'd1', id: 'org/data', likes: 4, downloads: 12, tags: ['task_categories:text-generation', 'modality:text', 'modality:image', 'license:mit'], createdAt: '2026-01-01T00:00:00.000Z' }),
      { id: 'd1', name: 'org/data', owner: 'org', avatar: '', url: 'https://huggingface.co/datasets/org/data', desc: '', lang: 'text', stars: 4, downloads: 12, license: 'mit', created: '2026-01-01T00:00:00.000Z' },
    );
    assert.deepEqual(Object.keys(KINDS), ['models', 'spaces', 'datasets']);

    // 출처 목록: 설정의 kinds에 든 종류만 켜진다. 이름은 hf(모델), hfs(Space), hfd(데이터셋).
    // 기간은 5개(최근 7일, 이번 주, 최근 30일, 이번 달, 올해)만 둔다.
    const cfgK = (name, kinds) => ({
      ...baseCfg, as: null, token: '', dataDir: path.join(TMP, name),
      hf: { ...baseCfg.hf, token: '', kinds, listed: { weekly: 0, monthly: 0 }, firstYear: year, pageSize: 100, maxPages: 3 },
    });
    assert.deepEqual(Object.keys(sources.create(cfgK('kA', ['models', 'spaces', 'datasets']))), ['hf', 'hfs', 'hfd']);
    assert.deepEqual(Object.keys(sources.create(cfgK('kB', ['datasets']))), ['hfd']);
    assert.deepEqual(Object.keys(sources.create({ ...cfgK('kC', ['models']), hf: null })), []);
    assert.deepEqual(Object.keys(sources.create(fullCfg)), ['hf', 'hfs', 'hfd', 'hn', 'as']); // 실제 설정에서는 모두 켜져 있다
    assert.deepEqual([sources.validKey('hfs', 'weekly', 'rolling'), sources.validKey('hfd', 'weekly', '../x'), sources.validKey('nope', 'weekly', 'rolling')], [true, false, false]);

    // 가짜 목록: 종류마다 오늘 만들어진 것 150개. 동시에 몇 건이 돌고 있는지도 센다.
    const world = { calls: [], active: 0, peak: 0 };
    const lister = (prefix) => async ({ kind, cursor, limit }) => {
      world.calls.push(kind);
      world.active += 1;
      world.peak = Math.max(world.peak, world.active);
      await sleep(5);
      world.active -= 1;
      const items = Array.from({ length: 150 }, (_, i) => ({ id: `${prefix}${i}`, name: `org/${prefix}-${i}`, owner: 'org', avatar: '', url: `https://huggingface.co/${prefix}/org/${prefix}-${i}`, desc: '', lang: 'x', stars: 500 - i, created: new Date(today + 3_600_000).toISOString() }));
      const start = cursor ? Number(cursor) : 0;
      return { items: items.slice(start, start + limit), next: start + limit < items.length ? String(start + limit) : null, rate: null };
    };

    // 수집기는 맡은 종류를 목록 함수에 넘기고, 종류마다 다른 폴더에 저장한다.
    const one = sources.create(cfgK('kD', ['spaces']), { hfs: lister('spaces') }).hfs;
    one.store.load();
    const col = one.make();
    assert.deepEqual([col.kind, col.label, one.group], ['spaces', 'Hugging Face Spaces', 'hf']);
    const r = await col.run();
    assert.deepEqual([r.pages, r.buckets, world.calls.join()], [1, 5, 'spaces']);
    assert.ok(one.store.dir.endsWith(path.join('kD', 'hfs', 'cache')));
    assert.equal(one.store.get('weekly', 'rolling').items[0].name, 'org/spaces-0');

    // 서버: data/hfs/ 주소와 meta.hfs
    const { createApp } = require(path.join(root, 'server'));
    const gh = setup('hfsRoutes', async () => ({ total: 100, incomplete: false, items: page(100, 3000), rate: FAST }));
    const { server, close } = createApp({ store: gh.store, collector: gh.collector, extra: { hfs: { store: one.store, collector: col } } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const liveMeta = await (await fetch(`${base}/data/meta.json`)).json();
    assert.deepEqual([liveMeta.hfs.types.weekly[0].hasData, liveMeta.hf, liveMeta.hfd], [true, undefined, undefined]);
    assert.equal((await (await fetch(`${base}/data/hfs/weekly.rolling.json`)).json()).items[0].name, 'org/spaces-0');
    assert.equal((await fetch(`${base}/data/hfd/weekly.rolling.json`)).status, 404); // 켜지 않은 종류
    close();
    server.closeAllConnections();

    // 빌드: 세 종류를 차례로(겹치지 않게) 받아 data/hf/, data/hfs/, data/hfd/에 쓴다.
    const ghSearch = async () => ({ total: 1000, incomplete: false, items: page(100, 5000), rate: FAST });
    const quiet = { log: () => {} };
    const api = { hf: lister('models'), hfs: lister('spaces'), hfd: lister('datasets') };
    const cfgB = { ...cfgK('buildK', ['models', 'spaces', 'datasets']), listed: { weekly: 0, monthly: 0 }, firstYear: year, static: { every: 15 * 60_000, budget: 5000 } };
    world.calls = [];
    world.peak = 0;
    const out1 = path.join(TMP, 'siteK1');
    const b1 = await build({ cfg: cfgB, out: out1, search: ghSearch, api, ...quiet });
    assert.deepEqual([b1.written, b1.hf.written, b1.hfs.written, b1.hfd.written, b1.hn, b1.as], [5, 5, 5, 5, null, null]);
    assert.deepEqual([world.calls.join(), world.peak], ['models,spaces,datasets', 1]);
    for (const f of ['data/hf/weekly.rolling.json', 'data/hfs/weekly.rolling.json', 'data/hfd/state/monthly.rolling.json']) assert.ok(fs.existsSync(path.join(out1, f)), f);
    const meta1 = JSON.parse(fs.readFileSync(path.join(out1, 'data/meta.json'), 'utf8'));
    assert.deepEqual([meta1.hf.types.weekly.length, meta1.hfs.types.weekly[0].hasData, meta1.hfd.types.yearly.length], [2, true, 1]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out1, 'data/hfd/weekly.rolling.json'), 'utf8')).items[0].name, 'org/datasets-0');

    // 다음 빌드는 종류마다 배포본에서 이어받는다. 한 종류가 실패해도 나머지는 그대로 낸다.
    const served = (dir) => async (url) => {
      const f = path.join(dir, url.replace('https://example.test/site/', ''));
      const found = fs.existsSync(f);
      return { status: found ? 200 : 404, ok: found, text: async () => fs.readFileSync(f, 'utf8') };
    };
    const warn = console.warn;
    console.warn = () => {};
    const down = async () => {
      throw new HfError('boom', { status: 500 });
    };
    const out2 = path.join(TMP, 'siteK2');
    const b2 = await build({ cfg: { ...cfgB, dataDir: path.join(TMP, 'buildK2') }, out: out2, seedUrl: 'https://example.test/site/', search: ghSearch, api: { ...api, hfs: down }, fetchImpl: served(out1), ...quiet });
    assert.deepEqual([b2.hf.loaded, b2.hfs.loaded, b2.hfd.loaded], [5, 5, 5]);
    assert.deepEqual([b2.hf.written, b2.hfs.written, b2.hfs.failed, b2.hfd.written, b2.hfd.failed], [5, 5, 1, 5, 0]); // Space는 지난 것을 다시 싣는다
    const meta2 = JSON.parse(fs.readFileSync(path.join(out2, 'data/meta.json'), 'utf8'));
    assert.deepEqual([meta2.hfs.types.weekly[0].error, meta2.hfd.types.weekly[0].error], ['boom', null]);
    // 처음부터 실패한 종류는 목록에 싣지 않는다(화면에 그 단추가 나타나지 않는다).
    const out3 = path.join(TMP, 'siteK3');
    const b3 = await build({ cfg: { ...cfgB, dataDir: path.join(TMP, 'buildK3') }, out: out3, search: ghSearch, api: { ...api, hfd: down }, ...quiet });
    const meta3 = JSON.parse(fs.readFileSync(path.join(out3, 'data/meta.json'), 'utf8'));
    assert.deepEqual([b3.hfs.written, b3.hfd.written, Boolean(meta3.hfs), meta3.hfd], [5, 0, true, undefined]);
    console.warn = warn;
    ok('hugging face space·데이터셋: 항목 모양, 켜고 끄기, 종류별 저장, 서버 주소, 차례로 받기, 이어받기, 일부 실패');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} groups passed`);
})().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
