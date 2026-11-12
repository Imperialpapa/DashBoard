'use strict';

// 정적 사이트를 site/ 에 만든다. 사용: npm run build
//   SEED_URL      지난번 배포본 주소. 주면 거기서 수집 상태를 이어받는다(GitHub Actions에서 쓴다).
//   GITHUB_TOKEN  있으면 검색 한도가 분당 30회.
//   HF_TOKEN      Hugging Face 토큰(없어도 된다).
//   BUDGET_SEC    수집에 쓸 시간 상한(초). 기본값은 config.js의 static.budget.

const path = require('node:path');
const cfg = require('../config');
const { build } = require('../lib/build');

const budget = Number(process.env.BUDGET_SEC) * 1000;
const conf = budget > 0 ? { ...cfg, static: { ...cfg.static, budget } } : cfg;

build({ cfg: conf, out: path.join(__dirname, '..', 'site'), seedUrl: process.env.SEED_URL || '' }).catch((err) => {
  console.error(`빌드 실패: ${err.message}`);
  process.exit(1);
});
