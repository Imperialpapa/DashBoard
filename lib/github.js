'use strict';

const API = 'https://api.github.com/search/repositories';

class GitHubError extends Error {
  constructor(message, { status = 0, retryAfter = 0, rate = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.retryAfter = retryAfter; // 초
    this.rate = rate;
  }
}

function readRate(headers) {
  const num = (name) => {
    const v = headers.get(name);
    return v === null ? null : Number(v);
  };
  const limit = num('x-ratelimit-limit');
  if (limit === null) return null;
  return { limit, remaining: num('x-ratelimit-remaining'), reset: num('x-ratelimit-reset') };
}

function slim(r) {
  return {
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
  };
}

/** 스타 내림차순으로 저장소를 검색한다. 실패하면 GitHubError를 던진다. */
async function searchRepos({ q, page = 1, perPage = 100, token = '', timeoutMs = 25_000 }) {
  const url = `${API}?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;
  const headers = {
    'User-Agent': 'github-best-dashboard',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? '응답 시간 초과' : err.cause?.code || err.message;
    throw new GitHubError(`GitHub에 연결하지 못했습니다 (${why})`);
  }

  const rate = readRate(res.headers);
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch {
      /* 본문이 JSON이 아니어도 상태 코드만으로 처리한다 */
    }
    throw new GitHubError(detail || `HTTP ${res.status}`, {
      status: res.status,
      retryAfter: Number(res.headers.get('retry-after')) || 0,
      rate,
    });
  }

  const body = await res.json();
  return {
    total: body.total_count,
    incomplete: Boolean(body.incomplete_results),
    items: (body.items || []).map(slim),
    rate,
  };
}

module.exports = { searchRepos, GitHubError };
