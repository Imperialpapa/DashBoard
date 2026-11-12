'use strict';

const path = require('node:path');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

module.exports = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT) || 4173,

  // 없어도 동작한다(검색 API 분당 10회). 토큰이 있으면 분당 30회.
  token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',

  dataDir: path.join(__dirname, 'data'),
  top: 100, // 순위표 길이
  perPage: 100, // 검색 한 번에 받는 개수(GitHub 최대값)
  firstYear: 2008,

  // 스팸 의심 기준(lib/spam.js). 스타가 minStars 이상인데 포크가 스타의 maxForkRatio에 못 미치고,
  // since 이후에 만들어진 저장소. 스팸 의심을 빼고도 순위표가 차도록 최대 maxPages쪽까지 더 받는다.
  spam: { minStars: 100, maxForkRatio: 0.005, since: '2020-01-01', maxPages: 5 },

  // 기간 목록에 노출할 과거 구간 수와, 그중 백그라운드로 미리 받아 둘 구간 수.
  // 나머지는 처음 열 때 받아 오고, 다시 열 때만 갱신한다.
  listed: { weekly: 26, monthly: 36 },
  eager: { weekly: 8, monthly: 12 },

  // 구간별 갱신 주기. 변화가 빠른 구간일수록 자주 확인한다.
  refresh: {
    weekly: { rolling: 2 * MIN, current: 5 * MIN },
    monthly: { rolling: 5 * MIN, current: 10 * MIN },
    yearly: { rolling: 15 * MIN, current: 15 * MIN },
    recentClosed: 6 * HOUR, // 끝난 지 35일 이내
    closed: DAY, // 끝난 지 400일 이내
    archive: 7 * DAY, // 그보다 오래된 구간
  },

  // 대시보드를 보고 있는 사람이 없으면 주기를 이만큼 늘려 API 한도를 아낀다.
  idleFactor: 5,

  // "최근 증가"와 순위 변동을 계산하기 위한 스냅샷 보관 규칙.
  history: { spacing: 30 * MIN, window: 25 * HOUR, max: 60, minSpan: 10 * MIN },

  manualRefreshCooldown: 30_000,

  // 정적 사이트 빌드(lib/build.js, GitHub Actions + Pages)용.
  //   every : 빌드가 도는 간격. 화면에 "약 N분마다"로 표시된다(.github/workflows/pages.yml의 cron과 맞춘다).
  //   budget: 한 번의 빌드가 수집에 쓰는 시간 상한. 못 받은 기간은 다음 빌드에서 이어 받는다.
  static: { every: 15 * MIN, budget: 9 * MIN },
};
