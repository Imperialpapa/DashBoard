'use strict';

// 기간(버킷) 정의. 모든 경계는 UTC 날짜 기준이다.
//   weekly : rolling(최근 7일) | YYYY-Www (ISO 주, 월~일)
//   monthly: rolling(최근 30일) | YYYY-MM
//   yearly : rolling(최근 365일) | YYYY

const DAY = 86_400_000;
const TYPES = ['weekly', 'monthly', 'yearly'];
const ROLLING_DAYS = { weekly: 7, monthly: 30, yearly: 365 };
const ROLLING_LABEL = { weekly: '최근 7일', monthly: '최근 30일', yearly: '최근 365일' };

const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const iso = (d) => d.toISOString().slice(0, 10);
const pad = (n) => String(n).padStart(2, '0');

function startOfDay(t) {
  const d = new Date(t);
  return utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function isoWeekOf(date) {
  const t = utc(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const dow = t.getUTCDay() || 7; // 월=1 … 일=7
  t.setUTCDate(t.getUTCDate() + 4 - dow); // 그 주의 목요일이 속한 해가 ISO 연도
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return { year: t.getUTCFullYear(), week: Math.ceil(((t - yearStart) / DAY + 1) / 7) };
}

function isoWeekStart(year, week) {
  const jan4 = utc(year, 0, 4);
  const dow = jan4.getUTCDay() || 7;
  return addDays(jan4, 1 - dow + (week - 1) * 7);
}

const weeksInYear = (year) => isoWeekOf(utc(year, 11, 28)).week;

function make(type, key, from, to, label, today, firstYear) {
  if (from.getUTCFullYear() < firstYear || from > today) return null;
  const kind = to === null ? 'rolling' : to >= today ? 'current' : 'closed';
  return { type, key, kind, label, from: iso(from), to: to ? iso(to) : null };
}

/** 키가 유효하면 버킷 설명을, 아니면 null을 돌려준다. */
function describe(type, key, now = Date.now(), firstYear = 2008) {
  if (!TYPES.includes(type) || typeof key !== 'string') return null;
  const today = startOfDay(now);

  if (key === 'rolling') {
    return make(type, key, addDays(today, -ROLLING_DAYS[type]), null, ROLLING_LABEL[type], today, firstYear);
  }
  if (type === 'weekly') {
    const m = /^(\d{4})-W(\d{2})$/.exec(key);
    if (!m) return null;
    const year = +m[1];
    const week = +m[2];
    if (week < 1 || week > weeksInYear(year)) return null;
    const from = isoWeekStart(year, week);
    return make(type, key, from, addDays(from, 6), `${year}년 ${week}주차`, today, firstYear);
  }
  if (type === 'monthly') {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (!m) return null;
    const year = +m[1];
    const month = +m[2];
    if (month < 1 || month > 12) return null;
    return make(type, key, utc(year, month - 1, 1), utc(year, month, 0), `${year}년 ${month}월`, today, firstYear);
  }
  const m = /^(\d{4})$/.exec(key);
  if (!m) return null;
  const year = +m[1];
  return make(type, key, utc(year, 0, 1), utc(year, 11, 31), `${year}년`, today, firstYear);
}

/** 한 종류의 버킷 목록: [rolling, 진행 중, 지난 구간(최신순)…] */
function list(type, now, cfg) {
  const today = startOfDay(now);
  const keys = ['rolling'];
  let eagerCount;

  if (type === 'weekly') {
    const { year, week } = isoWeekOf(today);
    const start = isoWeekStart(year, week);
    for (let i = 0; i <= cfg.listed.weekly; i++) {
      const w = isoWeekOf(addDays(start, -7 * i));
      keys.push(`${w.year}-W${pad(w.week)}`);
    }
    eagerCount = cfg.eager.weekly;
  } else if (type === 'monthly') {
    for (let i = 0; i <= cfg.listed.monthly; i++) {
      const d = utc(today.getUTCFullYear(), today.getUTCMonth() - i, 1);
      keys.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`);
    }
    eagerCount = cfg.eager.monthly;
  } else {
    for (let y = today.getUTCFullYear(); y >= cfg.firstYear; y--) keys.push(String(y));
    eagerCount = Infinity;
  }

  const typeIdx = TYPES.indexOf(type);
  return keys
    .map((key) => describe(type, key, now, cfg.firstYear))
    .filter(Boolean)
    .map((desc, i) => ({
      ...desc,
      eager: i < 2 + eagerCount, // rolling + 진행 중 + 최근 N개
      order: i * TYPES.length + typeIdx, // 첫 수집 순서: 세 종류를 번갈아 최신 구간부터
    }));
}

/** GitHub 검색 한정자 */
function query(desc) {
  return desc.to ? `created:${desc.from}..${desc.to}` : `created:>=${desc.from}`;
}

/**
 * 수집 주기의 한계(config.js의 collect): 같은 것을 min보다 자주 받지 않고, 진행 중인 것을 max보다 드물게 받지 않는다.
 * 설정에 없으면 한계를 두지 않는다.
 */
function gaps(cfg) {
  const c = (cfg && cfg.collect) || {};
  return { min: c.minGap || 0, max: c.maxGap || Infinity };
}

/** 진행 중인 것(최근 N일, 이번 주·달·해, 차트)을 다시 받는 간격을 한계 안으로 맞춘다. */
function clampGap(ms, cfg) {
  const { min, max } = gaps(cfg);
  return Math.min(max, Math.max(min, ms));
}

/** 이 버킷을 얼마나 자주 다시 확인할지. 끝난 기간은 가끔만 확인하므로 아래쪽 한계(min)만 적용한다. */
function interval(desc, now, cfg) {
  if (desc.kind !== 'closed') return clampGap(cfg.refresh[desc.type][desc.kind], cfg);
  const closedFor = now - Date.parse(desc.to) - DAY;
  let ms = cfg.refresh.archive;
  if (closedFor < 35 * DAY) ms = cfg.refresh.recentClosed;
  else if (closedFor < 400 * DAY) ms = cfg.refresh.closed;
  return Math.max(gaps(cfg).min, ms);
}

module.exports = { TYPES, describe, list, query, interval, gaps, clampGap, startOfDay };
