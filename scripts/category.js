'use strict';

// 화면에서 온 "분야 더하기·고치기·지우기"를 categories.json에 반영한다.
//
// 화면의 "정식 분야로 등록"은 그 분야를 적은 GitHub 이슈를 연다(public/live.js의 issueUrl). 이슈가 올라오면
// 워크플로(.github/workflows/category.yml)가 이 스크립트를 부르고, 바뀐 categories.json을 커밋한 뒤 배포를 돌린다.
// 저장소 주인이 올린 이슈만 여기까지 온다(워크플로의 if). 그래도 본문은 믿지 않는다: 정해진 모양의 JSON만 읽고,
// 낱말에 쓸 수 있는 글자와 개수를 화면과 같은 규칙(public/live.js의 spec)으로 확인한 다음, 설정을 읽는 쪽의
// 규칙(lib/categories.js의 all)으로 목록 전체를 한 번 더 본다.
//
// 사용: ISSUE_BODY="…" node scripts/category.js <결과를 쓸 폴더>
//   <폴더>/changed      true면 categories.json이 바뀌었다(커밋할 것이 있다)
//   <폴더>/ok           true면 요청을 받아들였다(바뀐 것이 없어도). false면 받지 않았다
//   <폴더>/comment.md   이슈에 달 답글
//   <폴더>/commit.txt   커밋 글(바뀌었을 때만)

const fs = require('node:fs');
const path = require('node:path');
const live = require('../public/live.js'); // 화면과 함께 쓰는 규칙
const categories = require('../lib/categories');

const FILE = path.join(__dirname, '..', 'categories.json');

/**
 * 이슈 본문을 읽어 분야 목록을 고친다. 파일은 건드리지 않고 결과만 돌려준다.
 * @param {object} o
 * @param {string} o.body   이슈 본문
 * @param {object[]} o.list 지금의 분야 목록
 * @param {number} [o.max]  분야 수 상한
 * @returns {{ok: boolean, changed: boolean, list: object[], comment: string, commit: string}}
 */
function apply({ body, list, max }) {
  const fail = (why) => ({ ok: false, changed: false, list, commit: '', comment: `반영하지 못했습니다: ${why}.\n\n화면에서 낱말을 고친 뒤 다시 등록해 주세요.` });
  let change;
  let done;
  try {
    change = live.parseIssue(body);
    done = categories.edit(list, change, { max });
    categories.all({ categories: { list: done.list } }); // 목록 전체가 설정으로 읽히는지
  } catch (err) {
    return fail(String(err.message || err).replace(/[.。]+$/, ''));
  }
  const name = `「${done.label}」`;
  const id = change.action === 'remove' ? change.id : change.category.id;
  if (done.did === 'same') {
    return { ok: true, changed: false, list, commit: '', comment: `${name} 분야는 이미 같은 내용으로 등록돼 있습니다. 바꾼 것이 없습니다.` };
  }
  const soon = '몇 분 뒤 배포가 끝나면 사이트에 반영됩니다(화면을 새로 고치세요).';
  const comment = {
    added:
      `${name} 분야를 더했습니다. ${soon}\n\n` +
      'Hugging Face와 Hacker News의 순위는 첫 수집 때 채워지고, GitHub의 지난 기간은 예약 수집 몇 번에 걸쳐 채워집니다. ' +
      '아직 받아 오지 못한 기간은 그동안 화면이 바로 검색한 결과로 보여 줍니다.',
    changed: `${name} 분야를 고쳤습니다. ${soon}\n\n낱말이 바뀐 출처는 다음 수집부터 새 낱말로 받습니다.`,
    removed: `${name} 분야를 지웠습니다. ${soon}`,
  }[done.did];
  const verb = { added: '더하기', changed: '고치기', removed: '지우기' }[done.did];
  return { ok: true, changed: true, list: done.list, comment, commit: `분야 ${verb}: ${done.label} (${id})\n\n화면에서 등록한 것을 반영했다(scripts/category.js).\n` };
}

/** categories.json에 쓰는 모양: 분야마다 한 덩이, 낱말 목록은 한 줄(사람이 고치기 쉽게). */
function format(list) {
  const one = (c) =>
    '  {\n' +
    [
      `    "id": ${JSON.stringify(c.id)}`,
      `    "label": ${JSON.stringify(c.label)}`,
      `    "github": ${inline(c.github || [])}`,
      `    "hf": { "tags": ${inline((c.hf && c.hf.tags) || [])}, "search": ${inline((c.hf && c.hf.search) || [])} }`,
      `    "hn": ${inline(c.hn || [])}`,
    ].join(',\n') +
    '\n  }';
  return list.length ? `[\n${list.map(one).join(',\n')}\n]\n` : '[]\n';
}
const inline = (words) => `[${words.map((w) => JSON.stringify(w)).join(', ')}]`;

function main() {
  const out = process.argv[2];
  if (!out) throw new Error('결과를 쓸 폴더를 인자로 주세요');
  fs.mkdirSync(out, { recursive: true });
  const cfg = require('../config');
  const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const r = apply({ body: process.env.ISSUE_BODY || '', list, max: categories.settings(cfg).max });
  if (r.changed) fs.writeFileSync(FILE, format(r.list));
  fs.writeFileSync(path.join(out, 'changed'), String(r.changed));
  fs.writeFileSync(path.join(out, 'ok'), String(r.ok));
  fs.writeFileSync(path.join(out, 'comment.md'), `${r.comment}\n`);
  if (r.changed) fs.writeFileSync(path.join(out, 'commit.txt'), r.commit);
  console.log(r.comment);
}

if (require.main === module) main();

module.exports = { apply, format };
