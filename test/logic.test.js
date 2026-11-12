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
const baseCfg = require(path.join(root, 'config'));

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
    // hf: null → Hugging Face 없이 GitHub 쪽만 본다(Hugging Face는 12번에서 따로).
    const cfgA = { ...baseCfg, hf: null, token: '', dataDir: path.join(TMP, 'buildA'), listed: { weekly: 2, monthly: 2 }, firstYear: new Date().getUTCFullYear() - 1, static: { every: 15 * 60_000, budget: 60_000 } };
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
    const { server, close } = createApp({ store: gh.store, collector: gh.collector, hf: { store: a.store, collector: a.collector } });
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
      ...baseCfg, token: '', dataDir: path.join(TMP, 'buildH'), listed: { weekly: 0, monthly: 0 }, firstYear: year,
      static: { every: 15 * 60_000, budget: 2000 },
      hf: { ...baseCfg.hf, token: '', listed: { weekly: 0, monthly: 0 }, firstYear: year },
    };
    const out1 = path.join(TMP, 'siteH1');
    const r1 = await build({ cfg: cfgH, out: out1, search, hfList, ...quiet });
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
    const r2 = await build({ cfg: { ...cfgH, dataDir: path.join(TMP, 'buildH2') }, out: out2, seedUrl: 'https://example.test/site/', search, hfList, fetchImpl: served(out1), ...quiet });
    assert.deepEqual([r2.loaded, r2.hf.loaded, r2.hf.written], [5, 5, 5]);
    const hfChart2 = JSON.parse(fs.readFileSync(path.join(out2, 'data/hf/weekly.rolling.json'), 'utf8'));
    assert.deepEqual([hfChart2.version, hfChart2.items[0].gain, hfChart2.items[0].move], [2, 5, 0]);

    // Hugging Face가 실패해도 빌드는 끝난다: 이어받은 순위를 그대로 다시 싣고, 실패했다는 표시를 남긴다.
    const warn = console.warn;
    console.warn = () => {};
    const down = async () => { throw new HfError('Hugging Face에 연결하지 못했습니다 (ENOTFOUND)'); };
    const out3 = path.join(TMP, 'siteH3');
    const r3 = await build({ cfg: { ...cfgH, dataDir: path.join(TMP, 'buildH3') }, out: out3, seedUrl: 'https://example.test/site/', search, hfList: down, fetchImpl: served(out2), ...quiet });
    assert.deepEqual([r3.written, r3.hf.written, r3.hf.loaded, r3.hf.ran, r3.hf.failed], [5, 5, 5, 0, 1]);
    const meta3 = JSON.parse(fs.readFileSync(path.join(out3, 'data/meta.json'), 'utf8'));
    assert.match(meta3.hf.types.weekly[0].error, /연결하지 못했습니다/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out3, 'data/hf/weekly.rolling.json'), 'utf8')).version, 2);

    // 이어받은 것도 없이 실패하면 Hugging Face 탭 없이 낸다.
    const out4 = path.join(TMP, 'siteH4');
    const r4 = await build({ cfg: { ...cfgH, dataDir: path.join(TMP, 'buildH4') }, out: out4, search, hfList: down, ...quiet });
    assert.deepEqual([r4.written, r4.hf.written], [5, 0]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out4, 'data/meta.json'), 'utf8')).hf, undefined);
    console.warn = warn;
    ok('build + hugging face: data/hf/ 파일, 배포본에서 이어받기, 실패해도 GitHub 순위는 낸다');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} groups passed`);
})().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
