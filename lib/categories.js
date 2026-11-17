'use strict';

// 분야(에이전트 AI, 로보틱스 …)별 순위.
//
// 분야 하나는 출처마다 "어떤 것이 그 분야에 드는지"를 낱말로 적은 것이다(categories.json. config.js의 categories.list가 읽어 온다).
//   github  이름·설명·토픽에 이 낱말이 든 저장소      → 검색 질의 앞에 붙인다(lib/collector.js)
//   hf      이 태그가 붙었거나(tags) 이름에 이 글자가 든(search) 모델·Space·데이터셋
//                                                      → 태그·글자마다 좋아요순 목록을 훑어 합친다(lib/hfcollector.js)
//   hn      제목에 이 낱말(로 시작하는 낱말)이 든 글   → 낱말마다 점수순으로 검색해 합친다(lib/hncollector.js)
//           띄어 쓴 낱말("image generation")은 그 구절이 그대로 든 글이다
// 적지 않은 출처에는 그 분야가 없다. App Store에는 스토어의 카테고리가 따로 있어 분야를 두지 않는다.
//
// 분야 × 출처마다 저장소와 수집기가 하나씩이다(lib/sources.js). 그 이름은 "<출처>_<분야>"(gh_robotics, hf_agents …)이고,
// 다른 출처의 이름과 똑같이 data/ 아래 폴더 이름이자 meta.json의 키로 쓰인다.
//
// 분야는 화면에서도 더할 수 있다. 화면이 낱말로 바로 검색해 보여 주고(public/live.js), "정식 분야로 등록"을 누르면
// GitHub 이슈를 거쳐 categories.json에 들어온다(scripts/category.js가 아래의 edit으로 고친다).

const ID = /^[a-z][a-z0-9-]*$/; // 분야 id: 화면 주소와 폴더 이름에 그대로 들어간다
const SEP = '_';
const GH_MAX_TERMS = 6; // GitHub 검색은 OR를 다섯 번까지만 받는다
const GH_MAX_CHARS = 180; // 질의 전체가 256자를 넘지 못한다(기간과 스타 하한이 뒤에 붙는다)

const DAY = 86_400_000;
const DEFAULTS = {
  listed: { weekly: 4, monthly: 6 },
  // 끝난 기간은 분야가 늘어난 만큼 덜 자주 확인한다(lib/periods.js의 interval이 읽는다).
  refresh: { recentClosed: DAY, closed: 7 * DAY, archive: 30 * DAY },
  hfPages: 20,
  max: 12,
};

const words = (v) => (Array.isArray(v) ? v : []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());

/** GitHub 검색 질의의 앞부분: 낱말 가운데 하나라도 이름·설명·토픽에 든 저장소. 띄어 쓴 낱말은 따옴표로 묶는다. */
function githubQuery(terms) {
  return `${terms.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' OR ')} in:name,description,topics`;
}

/**
 * 설정에 적힌 분야를 확인해 쓰기 좋은 모양으로 돌려준다. 분야를 두지 않았으면(null) 빈 배열이다.
 * 잘못 적힌 것은 조용히 넘기지 않고 던진다: 틀린 질의로 며칠씩 빈 순위를 받게 되는 것보다 낫다.
 * @returns {{id: string, label: string, github: string[], hf: {tags: string[], search: string[]}, hn: string[]}[]}
 */
function all(cfg) {
  const list = (cfg && cfg.categories && cfg.categories.list) || [];
  const seen = new Set();
  return list.map((c) => {
    const id = c && c.id;
    const bad = (why) => new Error(`categories.json: 분야 "${id}" ${why}`);
    if (typeof id !== 'string' || !ID.test(id)) throw bad('의 id는 영문 소문자로 시작하고 소문자·숫자·-만 쓸 수 있습니다');
    if (seen.has(id)) throw bad('가 두 번 적혀 있습니다');
    seen.add(id);
    if (typeof c.label !== 'string' || !c.label.trim()) throw bad('에 화면에 보일 이름(label)이 없습니다');

    const github = words(c.github);
    if (github.length > GH_MAX_TERMS) throw bad(`의 github 낱말은 ${GH_MAX_TERMS}개까지입니다(GitHub 검색이 OR를 다섯 번까지만 받습니다)`);
    if (github.some((t) => t.includes('"'))) throw bad('의 github 낱말에는 따옴표를 쓸 수 없습니다');
    if (github.length && githubQuery(github).length > GH_MAX_CHARS) throw bad('의 github 낱말이 너무 깁니다');

    const hn = words(c.hn);
    if (hn.some((t) => t.includes('"'))) throw bad('의 hn 낱말에는 따옴표를 쓸 수 없습니다');

    const hf = { tags: words(c.hf && c.hf.tags), search: words(c.hf && c.hf.search) };
    if (!github.length && !hn.length && !hf.tags.length && !hf.search.length) throw bad('에 낱말이 하나도 없습니다(github, hf, hn 가운데 하나는 있어야 합니다)');
    return { id, label: c.label.trim(), github, hf, hn };
  });
}

/** 분야별 순위에 쓰는 값: 기간 목록 길이, 끝난 기간을 다시 확인하는 주기, Hugging Face에서 태그 하나를 훑는 쪽 수 상한, 분야 수 상한. */
function settings(cfg) {
  const c = (cfg && cfg.categories) || {};
  return {
    listed: { ...DEFAULTS.listed, ...(c.listed || {}) },
    refresh: { ...DEFAULTS.refresh, ...(c.refresh || {}) },
    hfPages: c.hfPages || DEFAULTS.hfPages,
    max: c.max || DEFAULTS.max,
  };
}

/**
 * 분야 목록에 변경 하나를 반영한 새 목록을 돌려준다(화면에서 온 등록·고치기·지우기). 받을 수 없으면 까닭을 적어 던진다.
 *   {action: 'set', category}  같은 id가 있으면 그 자리에서 바꾸고, 없으면 맨 뒤에 더한다(max개까지)
 *   {action: 'remove', id}     그 분야를 뺀다
 * category는 이미 확인된 것(public/live.js의 spec)이어야 한다. 돌려준 목록은 all()로 한 번 더 확인해 쓴다.
 * @returns {{list: object[], did: 'added'|'changed'|'same'|'removed', label: string}}
 */
function edit(list, change, { max = DEFAULTS.max } = {}) {
  const at = list.findIndex((c) => c.id === (change.action === 'remove' ? change.id : change.category.id));
  if (change.action === 'remove') {
    if (at < 0) throw new Error(`"${change.id}" 분야는 목록에 없습니다`);
    return { list: list.filter((_, i) => i !== at), did: 'removed', label: list[at].label };
  }
  const c = change.category;
  if (at < 0) {
    if (list.length >= max) throw new Error(`분야는 ${max}개까지 둘 수 있습니다(지금 ${list.length}개). 하나를 지운 뒤에 더해 주세요`);
    return { list: [...list, c], did: 'added', label: c.label };
  }
  const same = JSON.stringify(all({ categories: { list: [list[at]] } })[0]) === JSON.stringify(all({ categories: { list: [c] } })[0]);
  return { list: list.map((x, i) => (i === at ? c : x)), did: same ? 'same' : 'changed', label: c.label };
}

/**
 * 분야별 수집기에 넘길 설정. 수집기들은 평소와 같은 자리(listed, refresh, hf.maxPages …)에서 값을 읽으므로,
 * 그 자리에 분야용 값을 넣어 준다. 기간 목록은 짧고, 목록에 있는 것은 모두 미리 받는다.
 */
function config(cfg) {
  const s = settings(cfg);
  return {
    ...cfg,
    listed: s.listed,
    eager: s.listed,
    refresh: { ...cfg.refresh, ...s.refresh },
    hf: cfg.hf ? { ...cfg.hf, listed: s.listed, maxPages: s.hfPages } : cfg.hf,
    hn: cfg.hn ? { ...cfg.hn, listed: s.listed } : cfg.hn,
  };
}

/**
 * 화면에 알려 줄 것(meta.json에 싣는다). 분야를 두지 않았으면 빈 객체다.
 *   cats   분야 목록과 그 낱말: 화면이 분야를 고치는 입력란을 채우고, 아직 받아 오지 못한 기간을 바로 검색하는 데 쓴다
 *   catMax 분야 수 상한
 *   repo   "주인/저장소". 있으면 화면이 "정식 분야로 등록"(GitHub 이슈)을 보여 준다
 */
function publicInfo(cfg, repo = '') {
  if (!cfg || !cfg.categories) return {};
  return { cats: all(cfg), catMax: settings(cfg).max, ...(/^[\w.-]+\/[\w.-]+$/.test(repo) ? { repo } : {}) };
}

/** 분야 × 출처의 이름: name('gh', 'robotics') → 'gh_robotics' */
const name = (base, id) => `${base}${SEP}${id}`;

/** 이름을 출처와 분야로 나눈다: 'gh_robotics' → {base: 'gh', cat: 'robotics'}, 'hf' → {base: 'hf', cat: ''} */
function split(full) {
  const i = String(full).indexOf(SEP);
  return i < 0 ? { base: String(full), cat: '' } : { base: full.slice(0, i), cat: full.slice(i + 1) };
}

module.exports = { all, settings, config, name, split, githubQuery, edit, publicInfo, ID };
