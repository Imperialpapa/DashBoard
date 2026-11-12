'use strict';

// App Store 공개 데이터.
//   차트 피드: https://itunes.apple.com/<나라>/rss/<종류>/limit=100[/genre=<id>]/json  (종류당 100위까지)
//   앱 조회  : https://itunes.apple.com/lookup?id=a,b,c&country=<나라>               (평가 수와 별점)
// 차트 피드에는 이름·아이콘·개발사·카테고리·가격·출시일이 있고, 평가 수와 별점은 조회 API에만 있다.

const FEEDS = { free: 'topfreeapplications', paid: 'toppaidapplications', grossing: 'topgrossingapplications' };
const HOST = 'https://itunes.apple.com';

class AppStoreError extends Error {
  constructor(message, { status = 0, retryAfter = 0 } = {}) {
    super(message);
    this.name = 'AppStoreError';
    this.status = status;
    this.retryAfter = retryAfter; // 초
  }
}

async function getJson(url, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'github-best-dashboard', Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? '응답 시간 초과' : err.cause?.code || err.message;
    throw new AppStoreError(`App Store에 연결하지 못했습니다 (${why})`);
  }
  if (!res.ok) {
    throw new AppStoreError(`HTTP ${res.status}`, { status: res.status, retryAfter: Number(res.headers.get('retry-after')) || 0 });
  }
  try {
    return await res.json();
  } catch {
    throw new AppStoreError('App Store 응답 형식이 예상과 다릅니다');
  }
}

const https = (url) => (typeof url === 'string' && url.startsWith('https://') ? url : '');

/** 피드 항목 하나를 화면과 저장소(lib/store.js)가 다루는 모양으로 맞춘다. 평가 수(stars)는 조회한 뒤에 채운다. */
function slim(e) {
  const images = Array.isArray(e['im:image']) ? e['im:image'] : [];
  const links = Array.isArray(e.link) ? e.link : e.link ? [e.link] : [];
  const page = links.find((l) => l.attributes && l.attributes.rel === 'alternate');
  const price = e['im:price'] || {};
  const released = Date.parse(e['im:releaseDate'] && e['im:releaseDate'].label);
  return {
    id: String(e.id.attributes['im:id']),
    name: (e['im:name'] && e['im:name'].label) || '',
    owner: (e['im:artist'] && e['im:artist'].label) || '', // 개발사
    avatar: https(images.length ? images[images.length - 1].label : ''), // 가장 큰 아이콘(100px)
    url: https(page ? page.attributes.href : e.id.label),
    desc: '',
    lang: (e.category && e.category.attributes && e.category.attributes.label) || '', // 카테고리
    price: Number(price.attributes && price.attributes.amount) > 0 ? price.label : '', // 유료일 때만
    created: Number.isNaN(released) ? null : new Date(released).toISOString(), // 출시일
  };
}

/**
 * 인기 차트 하나를 순위 순서대로 받는다.
 * @param {object} o
 * @param {string} o.kind  free | paid | grossing
 * @param {string} o.genre 카테고리 id, 종합은 'all'
 */
async function fetchChart({ country, kind, genre = 'all', limit = 100, timeoutMs = 25_000 }) {
  if (!FEEDS[kind]) throw new AppStoreError(`모르는 차트 종류: ${kind}`);
  const tail = genre === 'all' ? '' : `/genre=${encodeURIComponent(genre)}`;
  const body = await getJson(`${HOST}/${encodeURIComponent(country)}/rss/${FEEDS[kind]}/limit=${limit}${tail}/json`, timeoutMs);
  if (!body || !body.feed) throw new AppStoreError('App Store 응답 형식이 예상과 다릅니다');
  let entry = body.feed.entry || []; // 오른 앱이 없으면 entry가 없고, 하나뿐이면 배열이 아니다
  if (!Array.isArray(entry)) entry = [entry];
  return entry.filter((e) => e && e.id && e.id.attributes && e.id.attributes['im:id']).map(slim);
}

/** 여러 앱의 평가 수와 별점을 한 번에 받는다(그 나라 스토어 기준). 조회되지 않는 앱은 빠진다. */
async function lookup({ country, ids, timeoutMs = 40_000 }) {
  const body = await getJson(`${HOST}/lookup?id=${ids.map(encodeURIComponent).join(',')}&country=${encodeURIComponent(country)}`, timeoutMs);
  return ((body && body.results) || [])
    .filter((a) => a && a.trackId)
    .map((a) => ({ id: String(a.trackId), stars: a.userRatingCount || 0, rating: typeof a.averageUserRating === 'number' ? Math.round(a.averageUserRating * 10) / 10 : null }));
}

module.exports = { fetchChart, lookup, slim, AppStoreError, FEEDS };
