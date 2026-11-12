'use strict';

// Hacker News 글 검색(Algolia가 제공하는 공개 API, 토큰 없음).
//   https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>=A,created_at_i<B&hitsPerPage=100
// 검색어 없이 부르면 점수 내림차순으로 온다. 올라온 시각으로 범위를 걸 수 있어, 기간마다 한 번 부르면 그 기간의 상위 글이 된다.
// tags=story라서 채용 공고와 설문은 빠진다.

const API = 'https://hn.algolia.com/api/v1/search';
const ITEM = 'https://news.ycombinator.com/item?id=';
const DAY = 86_400_000;
// 필요한 것만 받는다(다 받으면 댓글 번호 목록과 강조 표시까지 와서 8배쯤 크다).
const FIELDS = 'title,url,author,points,num_comments,created_at_i';

class HnError extends Error {
  constructor(message, { status = 0, retryAfter = 0 } = {}) {
    super(message);
    this.name = 'HnError';
    this.status = status;
    this.retryAfter = retryAfter; // 초
  }
}

/**
 * 검색 결과 하나를 화면과 저장소(lib/store.js)가 다루는 모양으로 맞춘다. 점수가 stars 자리에 들어간다.
 *   url: 글이 가리키는 원문(본문만 있는 글은 Hacker News 토론 페이지)   hn: 토론 페이지   lang: 원문 사이트
 */
function slim(h) {
  const id = String(h.objectID);
  const page = ITEM + encodeURIComponent(id);
  let url = page;
  let site = 'news.ycombinator.com'; // Ask HN처럼 본문만 있는 글
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
    owner: h.author || '', // 올린 사람
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

/**
 * 기간 안에 올라온 글을 점수 내림차순으로 받는다.
 * @param {object} o
 * @param {string} o.from  시작일(YYYY-MM-DD, UTC)
 * @param {string|null} o.to 끝나는 날(그날 끝까지 포함). null이면 지금까지
 * @returns {{items: object[], total: number|null}} total은 그 기간에 올라온 글 수. 정확히 세지 못했으면 null
 */
async function searchStories({ from, to = null, limit = 100, timeoutMs = 20_000 }) {
  const filters = [`created_at_i>=${Math.floor(Date.parse(from) / 1000)}`];
  if (to) filters.push(`created_at_i<${Math.floor((Date.parse(to) + DAY) / 1000)}`);
  const url =
    `${API}?tags=story&numericFilters=${encodeURIComponent(filters.join(','))}` +
    `&hitsPerPage=${limit}&attributesToRetrieve=${FIELDS}&attributesToHighlight=none`;

  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'github-best-dashboard', Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? '응답 시간 초과' : err.cause?.code || err.message;
    throw new HnError(`Hacker News 검색에 연결하지 못했습니다 (${why})`);
  }
  if (!res.ok) {
    throw new HnError(`HTTP ${res.status}`, { status: res.status, retryAfter: Number(res.headers.get('retry-after')) || 0 });
  }

  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!body || !Array.isArray(body.hits)) throw new HnError('Hacker News 검색 응답 형식이 예상과 다릅니다');

  const items = body.hits
    .filter((h) => h && h.objectID && h.title && Number.isFinite(h.created_at_i))
    .map(slim)
    .sort((a, b) => b.stars - a.stars); // 이미 점수순이지만 확실히 해 둔다(안정 정렬)
  // 글이 많은 기간은 개수를 어림값으로만 주는데, 그 어림값은 실제와 열 배쯤 차이 나기도 해서 쓰지 않는다.
  const exact = body.exhaustiveNbHits === true || (body.exhaustive && body.exhaustive.nbHits === true);
  return { items, total: exact && Number.isFinite(body.nbHits) ? body.nbHits : null };
}

module.exports = { searchStories, slim, HnError };
