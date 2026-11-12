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

  // 수집 주기의 한계. 어떤 방식으로 돌리든(GitHub Actions 빌드, 로컬 서버, '지금 갱신') 이 범위를 벗어나지 않는다.
  //   minGap: 같은 것을 이보다 자주 받지 않는다(한 시간에 한 번까지). 푸시나 수동 실행으로 빌드가 잇달아 돌아도
  //           받은 지 한 시간이 안 된 것은 다시 받지 않고, 지난 배포본에서 이어받은 것을 그대로 싣는다.
  //   maxGap: 진행 중인 기간(최근 N일, 이번 주·달·해)과 차트를 이보다 드물게 받지 않는다(하루 두 번 이상).
  //           끝난 기간은 순위가 거의 바뀌지 않으므로 아래 refresh의 주기로 가끔만 다시 확인한다.
  // 아래의 주기들(refresh, hf·hn·as의 refresh, static.every)이 이 범위를 벗어나면 범위 안으로 맞춰진다.
  collect: { minGap: HOUR, maxGap: 12 * HOUR },

  // 구간별 갱신 주기(로컬 서버). 정적 사이트는 빌드할 때 이 주기가 지난 것만 다시 받는다.
  refresh: {
    weekly: { rolling: HOUR, current: HOUR },
    monthly: { rolling: HOUR, current: HOUR },
    yearly: { rolling: HOUR, current: HOUR },
    recentClosed: 6 * HOUR, // 끝난 지 35일 이내
    closed: DAY, // 끝난 지 400일 이내
    archive: 7 * DAY, // 그보다 오래된 구간
  },

  // 대시보드를 보고 있는 사람이 없으면 주기를 이만큼 늘려 API 한도를 아낀다(진행 중인 기간은 collect.maxGap까지만).
  idleFactor: 5,

  // "최근 증가"와 순위 변동을 계산하기 위한 스냅샷 보관 규칙.
  history: { spacing: 30 * MIN, window: 25 * HOUR, max: 60, minSpan: 10 * MIN },

  // '지금 갱신'을 잇달아 누를 때의 간격. 받은 지 collect.minGap이 안 된 것은 눌러도 다시 받지 않는다.
  manualRefreshCooldown: 30_000,

  // Hugging Face 탭(lib/hf.js, lib/hfcollector.js): 목록을 좋아요순으로 훑어 만든 날짜로 기간에 나눠 담는다.
  // 이 항목을 지우면(null) Hugging Face 탭 없이 돈다.
  hf: {
    // 무엇을 다룰지: models(모델), spaces(Space), datasets(데이터셋). 종류마다 따로 한 번씩 훑는다.
    kinds: ['models', 'spaces', 'datasets'],
    token: process.env.HF_TOKEN || '', // 없어도 된다(익명 한도: 5분에 500회, 한 종류를 훑는 데 60회 이하)
    // 2022년 3월 이전에 만든 것은 만든 날짜가 모두 같은 날로 기록돼 있어, 2022년까지는 기간을 나눌 수 없다.
    firstYear: 2023,
    listed: { weekly: 26, monthly: 36 }, // 기간 목록에 노출할 과거 구간 수(모두 미리 받는다)
    pageSize: 1000, // 한 번에 받는 개수(API 최대값)
    maxPages: 60, // 한 번 훑을 때 받는 쪽 수 상한. 여기까지 가도 100개가 안 찬 기간은 찬 만큼만 보여 준다
    refresh: HOUR, // 로컬 서버가 다시 훑는 간격(정적 사이트는 빌드할 때 한 번, 받은 지 collect.minGap이 지났을 때만)
  },

  // Hacker News 탭(lib/hn.js, lib/hncollector.js): 기간마다 그때 올라온 글을 점수순으로 검색한다. 토큰이 필요 없다.
  // 이 항목을 지우면(null) Hacker News 탭 없이 돈다.
  hn: {
    firstYear: 2007, // 연간 목록의 시작(Hacker News는 2006년 10월에 열렸다)
    listed: { weekly: 26, monthly: 36 }, // 기간 목록에 노출할 과거 구간 수(모두 미리 받는다)
    concurrency: 4, // 동시에 보내는 검색 수
    refresh: HOUR, // 로컬 서버가 다시 받는 간격(정적 사이트는 빌드할 때 한 번). 끝난 기간은 위 refresh의 주기로만 다시 확인한다
  },

  // App Store 탭(lib/appstore.js, lib/ascollector.js): 인기 차트를 종합과 카테고리별로 100위까지 받는다.
  // 이 항목을 지우면(null) App Store 탭 없이 돈다.
  as: {
    country: 'kr', // 어느 나라 스토어인지. 순위·평가 수·별점이 모두 이 스토어 기준이다
    kinds: ['free', 'paid', 'grossing'], // 무료, 유료, 최고 매출
    // [카테고리 id, 화면에 보일 이름]. 'all'은 종합.
    genres: [
      ['all', '종합'], ['6014', '게임'], ['6016', '엔터테인먼트'], ['6005', '소셜 네트워킹'], ['6007', '생산성'],
      ['6002', '유틸리티'], ['6015', '금융'], ['6024', '쇼핑'], ['6023', '음식 및 음료'], ['6012', '라이프 스타일'],
      ['6013', '건강 및 피트니스'], ['6017', '교육'], ['6008', '사진 및 비디오'], ['6011', '음악'], ['6003', '여행'],
      ['6010', '내비게이션'], ['6009', '뉴스'], ['6004', '스포츠'], ['6000', '비즈니스'], ['6018', '도서'],
      ['6006', '참고'], ['6020', '의료'], ['6001', '날씨'], ['6027', '그래픽 및 디자인'], ['6026', '개발자 도구'],
    ],
    concurrency: 4, // 차트 피드를 동시에 받는 수
    lookupBatch: 200, // 평가 수를 한 번에 조회하는 앱 수(API 최대값)
    lookupSpacing: 3000, // 조회 사이 최소 간격. 조회 API 한도는 분당 20회쯤이다
    refresh: HOUR, // 로컬 서버가 다시 받는 간격(정적 사이트는 빌드할 때 한 번)
  },

  // 정적 사이트 빌드(lib/build.js, GitHub Actions + Pages)용.
  //   every : 빌드가 도는 간격(하루 두 번). 화면에 "약 12시간마다"로 표시된다.
  //   at    : 예약 실행 시각(UTC). 한국 시간 9시·21시 = UTC 0시·12시. 화면은 이 시각이 지난 뒤에야 새 판을 확인한다.
  //   budget: 한 번의 빌드가 수집에 쓰는 시간 상한. 못 받은 기간은 다음 빌드에서 이어 받는다.
  // every와 at은 .github/workflows/pages.yml의 cron과 맞춘다. 예약 간격은 collect의 범위 안이어야 한다(시험이 확인한다).
  // 푸시·수동 실행으로 그 사이에 빌드가 돌면 화면 파일은 새로 내지만, 받은 지 collect.minGap이 안 된 것은 다시 받지 않는다.
  static: { every: 12 * HOUR, at: { hours: [0, 12], minute: 7 }, budget: 9 * MIN },
};
