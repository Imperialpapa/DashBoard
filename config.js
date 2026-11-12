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

  // Hugging Face 탭(lib/hf.js, lib/hfcollector.js): 모델을 좋아요순으로 훑어 만든 날짜로 기간에 나눠 담는다.
  // 이 항목을 지우면(null) Hugging Face 탭 없이 돈다.
  hf: {
    token: process.env.HF_TOKEN || '', // 없어도 된다(익명 한도: 5분에 500회, 한 번 훑는 데 60회 이하)
    // 2022년 3월 이전에 만든 모델은 만든 날짜가 모두 같은 날로 기록돼 있어, 2022년까지는 기간을 나눌 수 없다.
    firstYear: 2023,
    listed: { weekly: 26, monthly: 36 }, // 기간 목록에 노출할 과거 구간 수(모두 미리 받는다)
    pageSize: 1000, // 한 번에 받는 개수(API 최대값)
    maxPages: 60, // 한 번 훑을 때 받는 쪽 수 상한. 여기까지 가도 100개가 안 찬 기간은 찬 만큼만 보여 준다
    refresh: 30 * MIN, // 로컬 서버가 다시 훑는 간격(정적 사이트는 빌드할 때마다 한 번)
  },

  // 정적 사이트 빌드(lib/build.js, GitHub Actions + Pages)용.
  //   every : 빌드가 도는 간격(하루 두 번). 화면에 "약 12시간마다"로 표시된다.
  //   at    : 예약 실행 시각(UTC). 한국 시간 9시·21시 = UTC 0시·12시. 화면은 이 시각이 지난 뒤에야 새 판을 확인한다.
  //   budget: 한 번의 빌드가 수집에 쓰는 시간 상한. 못 받은 기간은 다음 빌드에서 이어 받는다.
  // every와 at은 .github/workflows/pages.yml의 cron과 맞춘다.
  static: { every: 12 * HOUR, at: { hours: [0, 12], minute: 7 }, budget: 9 * MIN },
};
