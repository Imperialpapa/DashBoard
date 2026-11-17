// 분야를 화면에서 더하는 데 쓰는 부분. 화면(app.js)도 쓰고 Node(시험, scripts/category.js)도 쓴다.
//
//   1) 분야 하나를 적는 규칙: 화면의 입력과 GitHub 이슈로 온 것을 같은 규칙으로 확인한다(spec).
//   2) 바로 검색: 사이트가 받아 두지 않은 분야의 순위를 브라우저가 GitHub·Hacker News·Hugging Face에 직접 물어 만든다.
//      수집기(lib/collector.js, lib/hncollector.js, lib/hfcollector.js)가 하는 일을 한 기간만큼만 하는 것이고,
//      돌려주는 모양은 사이트의 순위 파일과 같다(화면이 그대로 그린다). 앞서 받아 둔 것이 없으니 증가와 순위 변동은 없다.
//   3) 정식 분야로 등록: 그 분야를 적은 GitHub 이슈를 여는 주소와, 이슈 본문을 읽는 법(.github/workflows/category.yml).
//
// 질의를 만드는 법과 항목의 모양은 lib/ 쪽과 같아야 한다(같은지는 시험이 확인한다).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BestLive = api;
})(typeof self !== 'undefined' ? self : globalThis, () => {
  'use strict';

  const DAY = 86_400_000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 1) 분야를 적는 규칙 ─────────────────────────────────────────
  const ID = /^[a-z][a-z0-9-]*$/; // lib/categories.js와 같다: 화면 주소와 폴더 이름에 들어간다
  // 낱말은 글자·숫자로 시작하고 띄어쓰기와 . _ + # - 를 쓸 수 있다. 태그는 띄어 쓰지 않고 :도 쓴다(task_categories:robotics).
  // 검색 질의에 그대로 들어가므로 따옴표나 한정자(stars:>5 같은 것)가 될 글자는 받지 않는다.
  const WORD = /^[\p{L}\p{N}.][\p{L}\p{N} ._+#-]*$/u;
  const TAG = /^[\p{L}\p{N}.][\p{L}\p{N}._:+#-]*$/u;
  const LIMITS = { id: 30, label: 30, word: 60, github: 6, hn: 6, tags: 6, search: 6, githubChars: 180 };

  /** 쉼표나 줄바꿈으로 나눠 적은 글을 낱말 목록으로: 앞뒤 공백을 떼고, 겹친 공백을 하나로, 같은 낱말(대소문자 무시)은 한 번만. */
  function words(text) {
    const list = Array.isArray(text) ? text : String(text == null ? '' : text).split(/[,\n、，]/);
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const w = raw.trim().replace(/\s+/g, ' ');
      const k = w.toLowerCase();
      if (!w || seen.has(k)) continue;
      seen.add(k);
      out.push(w);
    }
    return out;
  }

  /** GitHub 검색 질의의 앞부분(lib/categories.js의 githubQuery와 같다). */
  function githubQuery(terms) {
    return `${terms.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' OR ')} in:name,description,topics`;
  }

  /** 분야 하나를 늘 같은 모양·같은 순서로: {id, label, github, hf: {tags, search}, hn}. 두 분야가 같은지 견줄 때도 쓴다. */
  function plain(c) {
    const hf = (c && c.hf) || {};
    return {
      id: String((c && c.id) || ''),
      label: String((c && c.label) || '').trim().replace(/\s+/g, ' '),
      github: words(c && c.github),
      hf: { tags: words(hf.tags), search: words(hf.search) },
      hn: words(c && c.hn),
    };
  }

  /**
   * 분야 하나를 확인해 다듬은 것을 돌려준다. 맞지 않으면 까닭을 적어 던진다.
   * 화면의 입력과 이슈로 온 것 모두 여기를 지난다.
   */
  function spec(input) {
    const c = plain(input);
    const bad = (why) => new Error(why);
    if (!ID.test(c.id) || c.id.length > LIMITS.id) throw bad(`분야의 id는 영문 소문자로 시작하고 소문자·숫자·-만 써서 ${LIMITS.id}자까지입니다`);
    if (!c.label) throw bad('분야의 이름을 적어 주세요');
    if (c.label.length > LIMITS.label) throw bad(`분야의 이름은 ${LIMITS.label}자까지입니다`);
    if (/[\u0000-\u001f\u007f<>]/.test(c.label)) throw bad('분야의 이름에 쓸 수 없는 글자가 있습니다');
    const check = (list, name, max, rule, what) => {
      if (list.length > max) throw bad(`${name}은 ${max}개까지입니다`);
      for (const w of list) {
        if (w.length > LIMITS.word) throw bad(`"${w.slice(0, 20)}…": 낱말 하나는 ${LIMITS.word}자까지입니다`);
        if (!rule.test(w)) throw bad(`"${w}": ${what}`);
      }
    };
    const wordRule = '낱말에는 글자·숫자·띄어쓰기와 . _ + # - 만 쓸 수 있습니다';
    check(c.github, 'GitHub 낱말', LIMITS.github, WORD, wordRule);
    check(c.hn, 'Hacker News 낱말', LIMITS.hn, WORD, wordRule);
    check(c.hf.search, 'Hugging Face 이름 낱말', LIMITS.search, WORD, wordRule);
    check(c.hf.tags, 'Hugging Face 태그', LIMITS.tags, TAG, '태그는 띄어 쓰지 않고 글자·숫자와 . _ : + # - 만 쓸 수 있습니다');
    if (c.github.length && githubQuery(c.github).length > LIMITS.githubChars) throw bad('GitHub 낱말이 너무 깁니다(모두 합쳐 160자쯤까지)');
    if (!c.github.length && !c.hn.length && !c.hf.tags.length && !c.hf.search.length) throw bad('낱말을 하나 이상 적어 주세요');
    return c;
  }

  /** 낱말 한 벌로 모든 출처를 채운 분야: Hugging Face에서는 이름에서도 찾고, 띄어 쓰지 않은 낱말은 태그로도 찾는다. */
  function fromWords(label, list, id = '') {
    const w = words(list);
    return plain({ id, label, github: w, hn: w, hf: { tags: w.filter((t) => !/\s/.test(t)), search: w } });
  }

  /** 낱말 한 벌로 적은 분야면 그 낱말들을, 출처마다 다르게 적은 분야면 null을 돌려준다(입력란을 어떻게 보일지 정한다). */
  function simple(c) {
    const p = plain(c);
    const same = fromWords(p.label, p.github, p.id);
    return JSON.stringify(same) === JSON.stringify(p) ? p.github : null;
  }

  /** 낱말에서 id를 만든다: 영문 소문자·숫자·-만 남긴다. 만들 수 없으면(한글뿐이면) 빈 글자다. */
  function slug(text) {
    const s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[-0-9]+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
    return ID.test(s) ? s : '';
  }

  /** 새 분야의 id: 첫 낱말에서 만들고, 이미 있는 id면 뒤에 번호를 붙인다(humanoid, humanoid-2 …). */
  function newId(c, taken = []) {
    const p = plain(c);
    const first = [...p.github, ...p.hn, ...p.hf.search, ...p.hf.tags].map(slug).find(Boolean) || 'topic';
    const used = new Set(taken);
    if (!used.has(first)) return first;
    for (let n = 2; ; n += 1) if (!used.has(`${first}-${n}`)) return `${first}-${n}`;
  }

  // ── 2) 바로 검색 ────────────────────────────────────────────────
  class LiveError extends Error {
    /** @param {number} [o.retryAt] 한도가 풀리는 때(ms). 그때 다시 받아 볼 수 있다 */
    constructor(message, { status = 0, retryAt = 0 } = {}) {
      super(message);
      this.name = 'LiveError';
      this.status = status;
      this.retryAt = retryAt;
    }
  }

  const get = async (f, url, name, headers = { Accept: 'application/json' }) => {
    try {
      return await f(url, { headers });
    } catch (err) {
      throw new LiveError(`${name}에 연결하지 못했습니다`);
    }
  };
  const header = (res, name) => (res.headers && res.headers.get ? res.headers.get(name) : null);

  // 스팸 의심 판정과 순위 매기기(lib/spam.js와 같다).
  function isSpam(r, rule) {
    if (!rule || r.stars < rule.minStars) return false;
    if (rule.since && r.created < rule.since) return false;
    return r.forks < Math.max(1, r.stars * rule.maxForkRatio);
  }
  function rankAll(items, rule, top) {
    const out = [];
    let clean = 0;
    items.forEach((r, i) => {
      const spam = isSpam(r, rule);
      const crank = spam ? null : ++clean;
      if (i < top || (crank !== null && crank <= top)) out.push({ ...r, rank: i + 1, spam, crank });
    });
    return out;
  }
  function countSkipped(items, rule, top) {
    let clean = 0;
    let spam = 0;
    let skipped = 0;
    for (const r of items) {
      if (isSpam(r, rule)) spam += 1;
      else {
        clean += 1;
        skipped = spam;
        if (clean >= top) break;
      }
    }
    return skipped;
  }
  /** 겹친 것은 한 번만 남기고 수(스타·점수)가 많은 순으로 세운다. 안정 정렬이라 수가 같으면 받은 순서다. */
  function merge(lists) {
    const seen = new Set();
    const out = [];
    for (const r of lists.flat()) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return out.sort((a, b) => b.stars - a.stars);
  }

  /** 순위 파일과 같은 모양으로 싼다. 앞서 받아 둔 것이 없으니 증가(gain)와 순위 변동(move)은 비워 둔다. */
  function bucket({ from, to, items, top, now, rule = null, ...more }) {
    return {
      from,
      to: to || null,
      version: 1,
      dataAt: now,
      total: null,
      approx: false,
      incomplete: false,
      partial: false,
      skipped: countSkipped(items, rule, top),
      top,
      span: null,
      live: true, // 사이트가 받아 둔 것이 아니라 브라우저가 바로 검색한 것
      ...more,
      items: rankAll(items, rule, top).map((r) => ({ ...r, gain: null, move: null, cmove: null })),
    };
  }

  // GitHub: 저장소 검색(lib/github.js의 slim과 같다)
  const GH_API = 'https://api.github.com/search/repositories';
  const ghSlim = (r) => ({
    id: r.id,
    name: r.full_name,
    owner: r.owner ? r.owner.login : '',
    avatar: r.owner ? r.owner.avatar_url : '',
    url: r.html_url,
    desc: r.description || '',
    lang: r.language || '',
    stars: r.stargazers_count,
    forks: r.forks_count,
    created: r.created_at,
    pushed: r.pushed_at,
  });
  const created = (from, to) => (to ? `created:${from}..${to}` : `created:>=${from}`); // lib/periods.js의 query와 같다

  /**
   * 그 기간에 만들어진 저장소 가운데 이름·설명·토픽에 낱말이 든 것을 스타순으로 받는다.
   * 토큰 없이 부르므로 검색은 분당 10회까지다. 스팸 의심을 빼고 top개가 안 차면 다음 쪽을 더 받되(maxPages쪽까지),
   * 그러다 한도에 걸리면 받은 데까지만 돌려준다(short).
   * @param {{minStars: number, maxForkRatio: number, since: string}|null} [o.spam] 스팸 의심 기준(사이트의 목록에 실려 온다)
   */
  async function github({ terms, from, to = null, top = 100, spam = null, maxPages = 3, fetch: f = fetch, now = Date.now() }) {
    const q = `${githubQuery(terms)} ${created(from, to)}`;
    let items = [];
    let total = null;
    let incomplete = false;
    let rate = null;
    let short = false;
    for (let page = 1; page <= maxPages; page += 1) {
      const res = await get(f, `${GH_API}?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${page}`, 'GitHub', { Accept: 'application/vnd.github+json' });
      const num = (name) => (header(res, name) === null ? null : Number(header(res, name)));
      if (num('x-ratelimit-limit') !== null) rate = { limit: num('x-ratelimit-limit'), remaining: num('x-ratelimit-remaining'), reset: num('x-ratelimit-reset') };
      if (!res.ok) {
        const limited = res.status === 429 || (res.status === 403 && (rate ? rate.remaining === 0 : true));
        if (limited && page > 1) {
          short = true; // 첫 쪽은 받았다: 그것만이라도 보여 준다
          break;
        }
        if (limited) {
          const wait = Number(header(res, 'retry-after')) || 0;
          const retryAt = wait ? now + wait * 1000 : rate && rate.reset ? rate.reset * 1000 : now + 60_000;
          throw new LiveError(`GitHub 검색 한도(분당 ${(rate && rate.limit) || 10}회)를 다 썼습니다`, { status: res.status, retryAt });
        }
        let detail = '';
        try {
          detail = (await res.json()).message || '';
        } catch {
          /* 본문이 JSON이 아니어도 상태 코드만으로 알린다 */
        }
        throw new LiveError(`GitHub 검색이 실패했습니다 (${detail || `HTTP ${res.status}`})`, { status: res.status });
      }
      const body = await res.json();
      const got = (body.items || []).map(ghSlim);
      total = body.total_count;
      incomplete = incomplete || Boolean(body.incomplete_results);
      items = merge([items, got]);
      const clean = items.reduce((n, r) => n + (isSpam(r, spam) ? 0 : 1), 0);
      if (clean >= top || got.length < 100 || items.length >= total) break;
    }
    return bucket({ from, to, items, top, now, rule: spam, total, incomplete, short, query: q, rate });
  }

  // Hacker News: Algolia 검색(lib/hn.js와 같다)
  const HN_API = 'https://hn.algolia.com/api/v1/search';
  const HN_ITEM = 'https://news.ycombinator.com/item?id=';
  const HN_FIELDS = 'title,url,author,points,num_comments,created_at_i';
  function hnSlim(h) {
    const id = String(h.objectID);
    const page = HN_ITEM + encodeURIComponent(id);
    let url = page;
    let site = 'news.ycombinator.com';
    try {
      const u = new URL(h.url);
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        url = u.href;
        site = u.hostname.replace(/^www\./, '');
      }
    } catch {
      /* 주소가 없거나 깨졌으면 토론 페이지로 잇는다 */
    }
    return {
      id,
      name: h.title || '',
      owner: h.author || '',
      avatar: '',
      url,
      hn: page,
      desc: '',
      lang: site,
      stars: h.points || 0,
      comments: h.num_comments || 0,
      created: new Date(h.created_at_i * 1000).toISOString(),
    };
  }
  function hnUrl({ from, to = null, query, limit = 100 }) {
    const filters = [`created_at_i>=${Math.floor(Date.parse(from) / 1000)}`];
    if (to) filters.push(`created_at_i<${Math.floor((Date.parse(to) + DAY) / 1000)}`);
    const phrase = /\s/.test(query);
    return (
      `${HN_API}?tags=story&numericFilters=${encodeURIComponent(filters.join(','))}` +
      `&query=${encodeURIComponent(phrase ? `"${query}"` : query)}${phrase ? '&advancedSyntax=true' : ''}` +
      '&restrictSearchableAttributes=title&typoTolerance=false' +
      `&hitsPerPage=${limit}&attributesToRetrieve=${HN_FIELDS}&attributesToHighlight=none`
    );
  }

  /** 그 기간에 올라온 글 가운데 제목에 낱말이 든 것을 낱말마다 점수순으로 받아 합친다. */
  async function hn({ terms, from, to = null, top = 100, fetch: f = fetch, now = Date.now() }) {
    const parts = await Promise.all(
      terms.map(async (query) => {
        const res = await get(f, hnUrl({ from, to, query, limit: top }), 'Hacker News 검색');
        if (!res.ok) {
          const wait = Number(header(res, 'retry-after')) || 0;
          throw new LiveError(`Hacker News 검색이 실패했습니다 (HTTP ${res.status})`, { status: res.status, retryAt: res.status === 429 ? now + (wait || 60) * 1000 : 0 });
        }
        const body = await res.json().catch(() => null);
        if (!body || !Array.isArray(body.hits)) throw new LiveError('Hacker News 검색 응답 형식이 예상과 다릅니다');
        const exact = body.exhaustiveNbHits === true || (body.exhaustive && body.exhaustive.nbHits === true);
        return {
          items: body.hits.filter((h) => h && h.objectID && h.title && Number.isFinite(h.created_at_i)).map(hnSlim),
          total: exact && Number.isFinite(body.nbHits) ? body.nbHits : null,
        };
      }),
    );
    // 낱말이 여럿이면 겹치는 글이 있어 개수를 더할 수 없다
    return bucket({ from, to, items: merge(parts.map((p) => p.items)).slice(0, top), top, now, total: parts.length === 1 ? parts[0].total : null });
  }

  // Hugging Face: 목록(lib/hf.js와 같다)
  const HF_API = 'https://huggingface.co/api';
  const HF_SITE = 'https://huggingface.co';
  const tagValue = (tags, prefix) => {
    const t = (tags || []).find((x) => typeof x === 'string' && x.startsWith(prefix));
    return t ? t.slice(prefix.length) : '';
  };
  const hfCommon = (m, prefix) => {
    const name = m.id || m.modelId || '';
    const slash = name.indexOf('/');
    return { id: m._id || name, name, owner: slash < 0 ? '' : name.slice(0, slash), avatar: '', url: `${HF_SITE}/${prefix}${name}`, desc: '' };
  };
  const HF_KINDS = {
    models: {
      path: 'models',
      fields: '',
      slim: (m) => ({
        ...hfCommon(m, ''),
        lang: m.pipeline_tag || '',
        stars: m.likes || 0,
        downloads: m.downloads || 0,
        lib: m.library_name || '',
        license: tagValue(m.tags, 'license:'),
        created: m.createdAt,
      }),
    },
    spaces: { path: 'spaces', fields: '', slim: (m) => ({ ...hfCommon(m, 'spaces/'), lang: m.sdk || '', stars: m.likes || 0, created: m.createdAt }) },
    datasets: {
      path: 'datasets',
      fields: '&expand[]=likes&expand[]=createdAt&expand[]=downloads&expand[]=tags',
      slim: (m) => ({
        ...hfCommon(m, 'datasets/'),
        lang: tagValue(m.tags, 'modality:'),
        stars: m.likes || 0,
        downloads: m.downloads || 0,
        license: tagValue(m.tags, 'license:'),
        created: m.createdAt,
      }),
    },
  };

  /**
   * 조건(태그, 이름)마다 좋아요순 목록을 훑어 합친다(lib/hfcollector.js의 walkTerms와 같은 규칙).
   * 만든 날짜로 거르는 조건이 없어 기간과 상관없이 한 번 훑으면 되고, 그 결과에서 기간마다 골라 쓴다(hfBucket).
   * 조건 하나는 목록 끝에 이르거나, 좋아요가 없는 것까지 내려가거나, pages쪽을 받으면 멈춘다. 쪽 상한에서 멈춘 조건이 있으면
   * 모든 조건에서 빠짐없이 본 좋아요 수(cut) 이상인 것만 남긴다.
   * @returns {{pool: object[], cut: number, pages: number}}
   */
  async function hfSweep({ kind, tags = [], search = [], pages: maxPages = 5, pageSize = 1000, retryWait = 2000, fetch: f = fetch, now = Date.now() }) {
    const K = HF_KINDS[kind];
    if (!K) throw new LiveError(`모르는 종류: ${kind}`);
    const base = `${HF_API}/${K.path}`;
    const conds = [...tags.map((t) => `&filter=${encodeURIComponent(t)}`), ...search.map((s) => `&search=${encodeURIComponent(s)}`)];
    const page = async (url) => {
      const res = await get(f, url, 'Hugging Face');
      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.json()).error || '';
        } catch {
          /* 본문이 JSON이 아니어도 상태 코드만으로 알린다 */
        }
        const wait = Number(header(res, 'retry-after')) || 0;
        throw new LiveError(res.status === 429 ? 'Hugging Face 요청 한도를 다 썼습니다' : `Hugging Face가 목록을 주지 않았습니다 (${detail || `HTTP ${res.status}`})`, {
          status: res.status,
          retryAt: res.status === 429 ? now + (wait || 60) * 1000 : 0,
        });
      }
      const body = await res.json();
      if (!Array.isArray(body)) throw new LiveError('Hugging Face 응답 형식이 예상과 다릅니다');
      const m = /<([^>]+)>;\s*rel="next"/.exec(header(res, 'link') || '');
      return { items: body.filter((x) => x && x.createdAt).map(K.slim), next: m && m[1].startsWith(`${base}?`) ? m[1] : null };
    };
    const found = new Map();
    let pages = 0;
    let cut = 0;
    for (const cond of conds) {
      let url = `${base}?sort=likes&direction=-1&limit=${pageSize}${K.fields}${cond}`;
      for (let n = 1; ; n += 1) {
        let res;
        try {
          res = await page(url);
        } catch (err) {
          // 조건을 건 목록은 처음 부를 때 "오래 걸린다"며 거절당하는 일이 있다: 잠깐 쉬었다가 한 번 더 받아 본다(한도 초과는 그대로 던진다).
          if (err.status === 429 || err.status === 401) throw err;
          await sleep(retryWait);
          res = await page(url);
        }
        pages += 1;
        for (const m of res.items) if (m.stars > 0 && !found.has(m.id)) found.set(m.id, m);
        const last = res.items.length ? res.items[res.items.length - 1].stars : 0;
        url = res.next;
        if (!url || last < 1) break;
        if (n >= maxPages) {
          cut = Math.max(cut, last + 1); // 좋아요가 last인 것은 일부만 봤을 수 있다
          break;
        }
      }
    }
    return { pool: [...found.values()].filter((m) => m.stars >= cut).sort((a, b) => b.stars - a.stars), cut, pages };
  }

  /** 훑어 둔 것에서 그 기간에 만들어진 것만 골라 순위를 만든다. */
  function hfBucket(sweep, { from, to = null, top = 100, now = Date.now() }) {
    const start = Date.parse(from);
    const end = to ? Date.parse(to) + DAY : Infinity; // to는 그날 끝까지
    const items = [];
    for (const m of sweep.pool) {
      const at = Date.parse(m.created);
      if (at < start || at >= end) continue;
      items.push(m);
      if (items.length >= top) break;
    }
    return bucket({ from, to, items, top, now, ...(items.length < top && sweep.cut ? { cut: sweep.cut } : {}) });
  }

  // ── 3) 정식 분야로 등록: GitHub 이슈 ────────────────────────────
  const ISSUE_MARK = '[분야]'; // 이슈 제목이 이것으로 시작해야 워크플로가 처리한다
  const REPO = /^[\w.-]+\/[\w.-]+$/;

  /** 이슈 본문: 사람이 읽을 안내 한 줄과, 기계가 읽을 JSON 덩이. */
  function issueBody(action, c) {
    let json;
    if (action === 'remove') json = JSON.stringify({ action, id: c.id });
    else {
      // 한 줄에 한 항목씩: 이슈 화면에서 읽기 쉽고, 주소가 너무 길어지지 않는다.
      const cat = spec(c);
      json = `{\n  "action": "set",\n  "category": {\n${Object.keys(cat).map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(cat[k])}`).join(',\n')}\n  }\n}`;
    }
    return (
      (action === 'remove' ? '이 분야를 사이트에서 지웁니다. ' : '이 분야를 사이트에 더합니다(같은 id가 있으면 고칩니다). ') +
      '그대로 제출하면 몇 분 안에 반영됩니다. 저장소 주인이 올린 것만 처리합니다.\n\n' +
      '```json\n' +
      json +
      '\n```\n'
    );
  }

  /** 그 내용이 미리 채워진 "새 이슈" 화면의 주소. repo는 "주인/저장소". */
  function issueUrl(repo, action, c) {
    if (!REPO.test(String(repo || ''))) return '';
    const what = action === 'remove' ? '지우기' : '더하기';
    const title = `${ISSUE_MARK} ${what}: ${plain(c).label || c.id}`;
    return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(issueBody(action, c))}`;
  }

  /**
   * 이슈 본문에서 할 일을 읽는다. 맞지 않으면 까닭을 적어 던진다.
   * @returns {{action: 'set', category: object} | {action: 'remove', id: string}}
   */
  function parseIssue(body) {
    const text = String(body == null ? '' : body);
    if (text.length > 20_000) throw new Error('본문이 너무 깁니다');
    const m = /```json\s*([\s\S]*?)```/.exec(text);
    if (!m) throw new Error('본문에 ```json 덩이가 없습니다');
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      throw new Error('본문의 JSON을 읽을 수 없습니다');
    }
    if (!data || typeof data !== 'object') throw new Error('본문의 JSON이 예상한 모양이 아닙니다');
    if (data.action === 'remove') {
      if (typeof data.id !== 'string' || !ID.test(data.id)) throw new Error('지울 분야의 id가 없습니다');
      return { action: 'remove', id: data.id };
    }
    if (data.action === 'set') return { action: 'set', category: spec(data.category) };
    throw new Error('할 일(action)은 set이나 remove여야 합니다');
  }

  return {
    ID, LIMITS, ISSUE_MARK, LiveError,
    words, plain, spec, fromWords, simple, slug, newId, githubQuery,
    isSpam, rankAll, countSkipped, merge,
    github, hn, hnUrl, hfSweep, hfBucket,
    issueBody, issueUrl, parseIssue,
    slim: { github: ghSlim, hn: hnSlim, hf: Object.fromEntries(Object.entries(HF_KINDS).map(([k, v]) => [k, v.slim])) },
  };
});
