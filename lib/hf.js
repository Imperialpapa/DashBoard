'use strict';

// Hugging Face Hub의 모델 목록 API.
// "이 기간에 만들어진 것만" 거르는 조건이 없어서, 좋아요 내림차순 목록을 쪽 단위로 받아
// 만든 날짜(createdAt)는 받는 쪽(lib/hfcollector.js)에서 거른다.

const API = 'https://huggingface.co/api/models';

class HfError extends Error {
  constructor(message, { status = 0, retryAfter = 0, rate = null } = {}) {
    super(message);
    this.name = 'HfError';
    this.status = status;
    this.retryAfter = retryAfter; // 초
    this.rate = rate;
  }
}

/**
 * 한도 헤더를 읽는다.
 *   ratelimit: "api";r=499;t=229                       남은 횟수 r, 창이 끝날 때까지 t초
 *   ratelimit-policy: "fixed window";"api";q=500;w=300  창 w초에 q회
 */
function readRate(headers, now = Date.now()) {
  const cur = headers.get('ratelimit');
  if (!cur) return null;
  const num = (text, name) => {
    const m = new RegExp(`(?:^|;)\\s*${name}=(\\d+)`).exec(text || '');
    return m ? Number(m[1]) : null;
  };
  const policy = headers.get('ratelimit-policy');
  const left = num(cur, 't');
  return {
    limit: num(policy, 'q'),
    window: num(policy, 'w'), // 초
    remaining: num(cur, 'r'),
    resetAt: left === null ? null : now + left * 1000,
  };
}

/** 다음 쪽 주소: Link: <…>; rel="next" */
function nextLink(headers) {
  const m = /<([^>]+)>;\s*rel="next"/.exec(headers.get('link') || '');
  return m && m[1].startsWith(`${API}?`) ? m[1] : null; // 다른 곳을 가리키면 따라가지 않는다
}

const tagValue = (tags, prefix) => {
  const t = (tags || []).find((x) => typeof x === 'string' && x.startsWith(prefix));
  return t ? t.slice(prefix.length) : '';
};

/** 화면과 저장소(lib/store.js)가 GitHub 항목과 같은 모양으로 다루도록 맞춘다. 좋아요 수가 stars 자리에 들어간다. */
function slim(m) {
  const name = m.id || m.modelId || '';
  const slash = name.indexOf('/');
  return {
    id: m._id || name,
    name,
    owner: slash < 0 ? '' : name.slice(0, slash),
    avatar: '',
    url: `https://huggingface.co/${name}`,
    desc: '',
    lang: m.pipeline_tag || '', // 작업 종류(text-generation 등)
    stars: m.likes || 0,
    downloads: m.downloads || 0, // 최근 30일 다운로드
    lib: m.library_name || '',
    license: tagValue(m.tags, 'license:'),
    created: m.createdAt,
  };
}

/**
 * 모델을 좋아요 내림차순으로 한 쪽 받는다. next는 다음 쪽 주소(없으면 null)이고, 이어 받을 때 cursor로 넘긴다.
 * 실패하면 HfError를 던진다.
 */
async function listModels({ cursor = null, limit = 1000, token = '', timeoutMs = 30_000 } = {}) {
  const url = cursor || `${API}?sort=likes&direction=-1&limit=${limit}`;
  const headers = { 'User-Agent': 'github-best-dashboard', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? '응답 시간 초과' : err.cause?.code || err.message;
    throw new HfError(`Hugging Face에 연결하지 못했습니다 (${why})`);
  }

  const rate = readRate(res.headers);
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error || '';
    } catch {
      /* 본문이 JSON이 아니어도 상태 코드만으로 처리한다 */
    }
    throw new HfError(detail || `HTTP ${res.status}`, {
      status: res.status,
      retryAfter: Number(res.headers.get('retry-after')) || 0,
      rate,
    });
  }

  const body = await res.json();
  if (!Array.isArray(body)) throw new HfError('Hugging Face 응답 형식이 예상과 다릅니다');
  return { items: body.filter((m) => m && m.createdAt).map(slim), next: nextLink(res.headers), rate };
}

module.exports = { listModels, HfError, readRate, slim };
