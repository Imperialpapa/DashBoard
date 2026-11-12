'use strict';

// 스팸 의심 판정.
//
// GitHub 검색의 "새로 만들어진 저장소 스타순"에는 스타를 사들인 저장소가 대량으로 섞인다
// (유료 소프트웨어 크랙·치트 배포용, 같은 날 수십 개씩 생성, 스타 1,200개에 포크 0개 같은 형태).
// 진짜 사람들이 쓰는 저장소는 스타가 붙는 만큼 포크도 붙으므로, 스타에 비해 포크가 거의 없는 저장소를
// 스팸으로 의심한다. 내용을 보는 것이 아니라 숫자만 보는 어림 규칙이라 틀릴 수 있고,
// 그래서 지우지 않고 표시만 해 둔다(화면에서 켜고 끌 수 있다).

/** @param {{stars:number, forks:number, created:string}} r */
function isSpam(r, rule) {
  if (!rule || r.stars < rule.minStars) return false;
  // 오래된 저장소 가운데는 포크 없이 스타만 많은 정상 라이브러리가 있어서 제외한다(ISO 날짜는 글자순 비교가 된다).
  if (rule.since && r.created < rule.since) return false;
  return r.forks < Math.max(1, r.stars * rule.maxForkRatio);
}

const countClean = (items, rule) => items.reduce((n, r) => n + (isSpam(r, rule) ? 0 : 1), 0);

/**
 * 스타 내림차순 목록에 순위 두 가지를 매긴다.
 *   rank : 받은 그대로의 순위
 *   crank: 스팸 의심을 뺀 순위(스팸 의심이면 null)
 * 둘 중 하나라도 top 안에 드는 저장소만 남긴다.
 */
function rankAll(items, rule, top) {
  const out = [];
  let clean = 0;
  items.forEach((r, i) => {
    const spam = isSpam(r, rule);
    const crank = spam ? null : ++clean;
    if (i < top || (crank !== null && crank <= top)) out.push({ ...r, rank: i + 1, spam, crank });
  });
  return out;
}

/** 스팸을 뺀 순위표 top개를 채우느라 건너뛴(그보다 위에 있던) 스팸 의심 개수 */
function countSkipped(items, rule, top) {
  let clean = 0;
  let spam = 0;
  let skipped = 0;
  for (const r of items) {
    if (isSpam(r, rule)) {
      spam += 1;
    } else {
      clean += 1;
      skipped = spam;
      if (clean >= top) break;
    }
  }
  return skipped;
}

/** 여러 쪽을 이어 붙인다. 쪽을 받는 사이에 순위가 바뀌어 겹친 항목은 한 번만 남기고 스타순으로 다시 세운다. */
function merge(a, b) {
  const seen = new Set();
  const out = [];
  for (const r of [...a, ...b]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out.sort((x, y) => y.stars - x.stars); // 안정 정렬이라 스타가 같으면 받은 순서를 지킨다
}

module.exports = { isSpam, countClean, countSkipped, rankAll, merge };
