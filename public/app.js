(() => {
  'use strict';

  const DAY = 86_400_000;
  const CURRENT_LABEL = { weekly: '이번 주', monthly: '이번 달', yearly: '올해' };
  const PERIOD_TYPES = [['weekly', '주간'], ['monthly', '월간'], ['yearly', '연간']];
  const COUNTRIES = { kr: '한국', us: '미국', jp: '일본', cn: '중국', gb: '영국', de: '독일', fr: '프랑스' };

  // 출처(탭)별 낱말과 문구. 화면 구조와 데이터 모양은 같고 부르는 이름만 다르다.
  // 항목의 stars에는 스타(GitHub), 좋아요(Hugging Face), 점수(Hacker News), 평가 수(App Store)가 들어 있다.
  //   dir: 순위 파일이 놓인 곳(data/ 아래)     types: 위쪽 탭 [주소에 쓰는 이름, 보이는 이름]
  //   home: 기본으로 여는 [종류, 키]            bucket: 고르는 단위를 부르는 말(기간 / 차트)
  //   facet: 언어 자리에 보여 주는 분류         made: 날짜를 부르는 말(생성 / 등록 / 출시)
  //   pool, order: 기간 설명에 쓰는 말("… 만들어진 공개 저장소 가운데 스타가 많은 순으로 …")
  //   plainName: 이름이 "주인/이름" 꼴이 아니다(제목이나 앱 이름이라 /로 나누지 않는다)
  //   pending: 서버 방식에서 아직 받는 중일 때의 안내 [제목, 본문]
  //   tab, sub: 한 탭 안에 묶이는 출처들(tab이 같다)과, 그 탭 안에서 이 출처를 부르는 이름
  // GitHub·Hugging Face·Hacker News는 "그 기간에 새로 나온 것"의 순위이고, App Store는 애플이 낸 인기 차트 그대로다.

  // Hugging Face는 한 탭 안에서 모델·Space·데이터셋을 오간다. 셋은 받는 방식과 화면이 같고 낱말만 다르다.
  //   unitGa, unitEul: 조사를 붙인 꼴(모델이 / Space가)   facetOr: "작업 종류나 검색어를 바꿔 보세요"의 앞부분
  const hugging = ({ dir, sub, unit, unitGa, unitEul, facet, facetOr, note }) => ({
    name: 'Hugging Face', title: 'Hugging Face 베스트', tab: 'hf', sub, dir, types: PERIOD_TYPES, home: ['weekly', 'rolling'], homeLabel: '최근 7일 보기',
    bucket: '기간', unit, score: '좋아요', mark: '♥', facet, noFacet: `${facet} 표시 없음`, made: '생성',
    pool: `만들어진 공개 ${unit}`, order: '좋아요가 많은 순',
    rankSort: '좋아요순', gainSort: '최근 증가순', histTitle: '만들어진 시점',
    searchHint: `${unit} 이름으로 찾기`,
    histHint: `순위에 든 ${unitGa} 언제 만들어졌는지 보여 줍니다.`,
    none: `이 기간에 만들어진 ${unitEul} 아직 찾지 못했습니다`,
    noMatch: [`조건에 맞는 ${unitGa} 없습니다`, `${facetOr} 검색어를 바꿔 보세요.`],
    pending: ['이 기간의 순위를 받아 오는 중입니다', `Hugging Face ${unit} 목록을 좋아요순으로 훑고 있습니다. 끝나는 즉시 여기에 나타납니다.`],
    foot: [
      `순위는 해당 기간(UTC 기준)에 새로 만들어진 Hugging Face 공개 ${unitEul} 좋아요 수로 줄 세운 상위 100개입니다. 기간 안에 만들어진 것만 다루므로 좋아요 수가 곧 그 기간에 받은 좋아요입니다. 좋아요가 아주 적은 것까지는 훑지 않아서, 막 시작한 기간은 100개가 안 될 수 있습니다.`,
      `증가와 순위 변동은 앞서 수집해 둔 스냅샷(하루쯤 전까지)과 비교한 값입니다. ${note}`,
      '2022년 3월 이전에 만든 것은 만든 날짜가 모두 같은 날로 기록돼 있어, 2023년부터만 다룹니다.',
    ],
  });

  const SOURCES = {
    gh: {
      name: 'GitHub', title: 'GitHub 베스트', dir: '', types: PERIOD_TYPES, home: ['weekly', 'rolling'], homeLabel: '최근 7일 보기',
      bucket: '기간', unit: '저장소', score: '스타', mark: '★', facet: '언어', noFacet: '언어 표시 없음', made: '생성',
      pool: '만들어진 공개 저장소', order: '스타가 많은 순',
      rankSort: '스타순', gainSort: '최근 증가순', histTitle: '만들어진 시점',
      searchHint: '저장소 이름이나 설명으로 찾기',
      histHint: '순위에 든 저장소가 언제 만들어졌는지 보여 줍니다.',
      none: '이 기간에 만들어진 저장소가 아직 없습니다',
      noMatch: ['조건에 맞는 저장소가 없습니다', '언어나 검색어를 바꿔 보세요.'],
      foot: [
        '순위는 해당 기간(UTC 기준)에 새로 만들어진 공개 저장소를 스타 수로 줄 세운 GitHub 검색 결과 상위 100개입니다. 포크는 빠집니다. 기간 안에 만들어진 저장소만 다루므로 스타 수가 곧 그 기간에 받은 스타입니다.',
        '증가와 순위 변동은 앞서 수집해 둔 스냅샷(하루쯤 전까지)과 비교한 값입니다.',
        '스타에 비해 포크가 거의 없는 저장소는 스타를 사들인 스팸으로 의심해 기본으로 숨기고, 그만큼 아래 순위를 더 받아 100개를 채웁니다. 숫자만 보는 어림 규칙이라 틀릴 수 있으니, 숨기기를 끄면 표시가 붙은 채로 모두 볼 수 있습니다.',
      ],
    },
    hf: hugging({
      dir: 'hf/', sub: '모델', unit: '모델', unitGa: '모델이', unitEul: '모델을', facet: '작업', facetOr: '작업 종류나',
      note: '다운로드는 최근 30일 동안의 횟수입니다.',
    }),
    hfs: hugging({
      dir: 'hfs/', sub: 'Spaces', unit: 'Space', unitGa: 'Space가', unitEul: 'Space를', facet: 'SDK', facetOr: 'SDK나',
      note: 'SDK는 그 Space를 무엇으로 만들었는지(Gradio, Docker, Static 등)입니다.',
    }),
    hfd: hugging({
      dir: 'hfd/', sub: '데이터셋', unit: '데이터셋', unitGa: '데이터셋이', unitEul: '데이터셋을', facet: '형태', facetOr: '형태나',
      note: '다운로드는 최근 30일 동안의 횟수이고, 형태는 데이터의 종류(text, image, audio 등)입니다.',
    }),
    hn: {
      name: 'Hacker News', title: 'Hacker News 베스트', dir: 'hn/', types: PERIOD_TYPES, home: ['weekly', 'rolling'], homeLabel: '최근 7일 보기',
      bucket: '기간', unit: '글', score: '점수', scoreUnit: '점', mark: '▲', facet: '사이트', noFacet: '사이트 없음', made: '등록',
      pool: '올라온 글', order: '점수가 높은 순', plainName: true, searchFacet: true,
      rankSort: '점수순', gainSort: '최근 증가순', histTitle: '올라온 시점',
      searchHint: '제목, 사이트, 올린 사람으로 찾기',
      histHint: '순위에 든 글이 언제 올라왔는지 보여 줍니다.',
      none: '이 기간에 올라온 글이 아직 없습니다',
      noMatch: ['조건에 맞는 글이 없습니다', '사이트나 검색어를 바꿔 보세요.'],
      pending: ['이 기간의 순위를 받아 오는 중입니다', 'Hacker News 검색으로 기간마다 상위 글을 받고 있습니다. 끝나는 즉시 여기에 나타납니다.'],
      foot: [
        '순위는 해당 기간(UTC 기준)에 Hacker News에 올라온 글을 점수로 줄 세운 상위 100개입니다. 기간 안에 올라온 글만 다루므로 점수가 곧 그 글이 받은 점수입니다. 채용 공고와 설문은 빠집니다.',
        '증가와 순위 변동은 앞서 수집해 둔 스냅샷(하루쯤 전까지)과 비교한 값입니다. 제목을 누르면 원문으로, "댓글"을 누르면 Hacker News의 토론으로 갑니다.',
        '순위와 점수는 Algolia가 제공하는 Hacker News 검색 API에서 받습니다. 오래된 글의 원문 주소는 사라졌을 수 있습니다.',
      ],
    },
    as: {
      name: 'App Store', title: 'App Store 인기 차트', dir: 'as/', types: [['free', '무료'], ['paid', '유료'], ['grossing', '매출']],
      typeNames: { free: '무료 앱', paid: '유료 앱', grossing: '최고 매출' },
      home: ['free', 'all'], homeLabel: '무료 종합 차트 보기',
      bucket: '차트', unit: '앱', score: '평가', mark: '평가', facet: '카테고리', noFacet: '카테고리 없음', made: '출시',
      plainName: true,
      rankSort: '차트순', gainSort: '평가 증가순', histTitle: '출시 시점',
      searchHint: '앱 이름이나 개발사로 찾기',
      histHint: '차트에 오른 앱이 언제 출시됐는지 보여 줍니다.',
      none: '이 차트에 오른 앱이 없습니다',
      noMatch: ['조건에 맞는 앱이 없습니다', '출시 시기나 카테고리, 검색어를 바꿔 보세요.'],
      pending: ['이 차트를 받아 오는 중입니다', 'App Store 차트와 앱마다의 평가 수를 받고 있습니다. 몇 분 걸리며, 끝나는 즉시 여기에 나타납니다.'],
      // {country}는 어느 나라 스토어인지로 바뀐다.
      foot: [
        '{country} App Store의 인기 차트(무료·유료·최고 매출)를 종합과 카테고리별로 100위까지 보여 줍니다. 순위는 애플이 낸 차트 순서 그대로입니다.',
        '순위 변동과 NEW 표시, 평가 증가는 앞서 수집해 둔 스냅샷(하루쯤 전까지)과 비교한 값입니다. 평가 수와 별점은 {country} 스토어 기준입니다.',
        'GitHub·Hugging Face 탭과 달리 "그 기간에 새로 나온 것"만 모은 순위가 아닙니다. 새로 나온 앱만 보려면 "출시" 조건으로 거르세요.',
      ],
    },
  };
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  // GitHub이 언어마다 쓰는 색(linguist). 항상 언어 이름과 함께 표시한다.
  const LANG_COLORS = {
    JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Go: '#00ADD8', Rust: '#dea584',
    Java: '#b07219', C: '#555555', 'C++': '#f34b7d', 'C#': '#178600', Swift: '#F05138', Kotlin: '#A97BFF',
    Ruby: '#701516', PHP: '#4F5D95', Shell: '#89e051', HTML: '#e34c26', CSS: '#663399', Vue: '#41b883',
    Svelte: '#ff3e00', Dart: '#00B4AB', Zig: '#ec915c', Lua: '#000080', 'Jupyter Notebook': '#DA5B0B',
    'Objective-C': '#438eff', Scala: '#c22d40', Elixir: '#6e4a7e', Haskell: '#5e5086', R: '#198CE7',
    MDX: '#fcb32c', Markdown: '#083fa1', Nix: '#7e7eff', Dockerfile: '#384d54', PowerShell: '#012456',
    Astro: '#ff5a03', Solidity: '#AA6746', TeX: '#3D6117', 'Vim Script': '#199f4b', Makefile: '#427819',
    HCL: '#844FBA', OCaml: '#ef7a08', Clojure: '#db5855', Perl: '#0298c3', Assembly: '#6E4C13',
    Julia: '#a270ba', Nim: '#ffc200', GDScript: '#355570', Batchfile: '#C1F12E', 'Emacs Lisp': '#c065db',
    Typst: '#239dad', Cuda: '#3A4E3A', Mojo: '#ff4c1f', Gleam: '#ffaff3', Roff: '#ecdebe', SCSS: '#c6538c',
    Erlang: '#B83998', 'F#': '#b845fc', Groovy: '#4298b8', Verilog: '#b2b7f8', Move: '#4a137a',
  };

  const $ = (sel) => document.querySelector(sel);
  const el = {
    live: $('#live'), liveText: $('#liveText'), themeBtn: $('#themeBtn'),
    types: $('.types'), prev: $('#prevBtn'), next: $('#nextBtn'), period: $('#periodSelect'), sub: $('#periodSub'),
    seg: $('.seg'), lang: $('#langSelect'), search: $('#search'), count: $('#count'),
    notice: $('#notice'), cols: $('#cols'), gainHead: $('#gainHead'), rows: $('#rows'), empty: $('#empty'),
    langs: $('#langs'), hist: $('#hist'), status: $('#status'),
    refreshBtn: $('#refreshBtn'), refreshMsg: $('#refreshMsg'), tip: $('#tip'),
    spamLabel: $('#spamLabel'), spamToggle: $('#spamToggle'), spamCount: $('#spamCount'),
    sources: $('#sources'), subs: $('#subs'), brandText: $('#brandText'), unitHead: $('#unitHead'), scoreHead: $('#scoreHead'),
    facetLabel: $('#facetLabel'), facetTitle: $('#facetTitle'), facetHint: $('#facetHint'), histHint: $('#histHint'),
    histTitle: $('#histTitle'), ageField: $('#ageField'), age: $('#ageSelect'), foot: $('#foot'),
  };

  const state = {
    src: 'gh', // 출처: SOURCES의 이름(gh, hf, hfs, hfd, hn, as)
    type: 'weekly',
    key: 'rolling',
    sort: 'rank',
    lang: '',
    q: '',
    age: 0, // App Store: 출시된 지 이 날수 안쪽인 앱만 보기(0이면 전체)
    hideSpam: true, // 스팸 의심 저장소를 빼고 보기
    items: [], // 지금 보기 방식(스팸 숨김 여부)에 맞춘 순위표 항목
    meta: null, // 기간 목록
    metaDay: 0, // 기간 목록을 받은 날(UTC 일 번호)
    status: new Map(), // 'src:type/key' → 그 기간의 수집 상태
    collectors: {}, // 출처별 수집기 상태
    data: null, // 지금 보고 있는 순위 데이터
    dataId: '',
    view: 'loading', // loading | ready | pending | invalid | offline
    live: true, // 서버 방식(실시간 연결)인지. 정적 사이트면 false이고 주기적으로 다시 읽는다
    connected: false,
    everConnected: false,
    skew: 0, // 서버 시계 - 내 시계
    loadSeq: 0,
    loadingId: '', // 지금 순위를 받고 있는 기간
    retryTimer: 0,
  };

  // ── 표기 도우미 ───────────────────────────────────────────────
  const nf = new Intl.NumberFormat('ko-KR');
  const fmt = (n) => nf.format(n);
  const pad = (n) => String(n).padStart(2, '0');
  const now = () => Date.now() + state.skew;
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const ymd = (isoDate) => isoDate.slice(0, 10).replaceAll('-', '.');
  const md = (isoDate) => isoDate.slice(5, 10).replace('-', '.');

  function rel(t) {
    const s = Math.max(0, Math.round((now() - t) / 1000));
    if (s < 5) return '방금';
    if (s < 60) return `${s}초 전`;
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
    return `${Math.floor(s / 86400)}일 전`;
  }

  function until(t) {
    const s = Math.round((t - now()) / 1000);
    if (s <= 0) return '곧';
    if (s < 3600) return `${Math.floor(s / 60)}:${pad(s % 60)} 뒤`;
    if (s < 86400) return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분 뒤`;
    return `${Math.floor(s / 86400)}일 뒤`;
  }

  function spanText(ms) {
    const m = Math.round(ms / 60000);
    return m < 90 ? `${m}분` : `${Math.round(m / 60)}시간`;
  }

  /** "3일 전 생성", "2024.05.01 출시" */
  function ageText(created, word) {
    const ms = now() - Date.parse(created);
    if (ms < 3_600_000) return `${Math.max(1, Math.floor(ms / 60000))}분 전 ${word}`;
    if (ms < DAY) return `${Math.floor(ms / 3_600_000)}시간 전 ${word}`;
    if (ms < 60 * DAY) return `${Math.floor(ms / DAY)}일 전 ${word}`;
    return `${ymd(created)} ${word}`;
  }

  function approxKo(n) {
    if (n >= 1e8) return `${(n / 1e8).toFixed(1)}억`;
    if (n >= 1e4) {
      const man = Math.round(n / 1e4);
      const digits = String(man).length;
      const unit = 10 ** Math.max(0, digits - 2);
      return `${fmt(Math.round(man / unit) * unit)}만`;
    }
    return fmt(n);
  }

  const pace = (r, asOf) => r.stars / Math.max(1, (asOf - Date.parse(r.created)) / DAY);
  const S = () => SOURCES[state.src];
  /** 그 출처가 속한 탭(위쪽 단추의 이름)과, 한 탭에 묶인 출처들. Hugging Face 탭에 hf·hfs·hfd가 묶인다. */
  const tabOf = (src) => SOURCES[src].tab || src;
  const family = (tab) => Object.keys(SOURCES).filter((src) => tabOf(src) === tab);
  const langOf = (r) => r.lang || S().noFacet;
  const idOf = (type, key, src = state.src) => `${src}:${type}/${key}`;
  const currentId = () => idOf(state.type, state.key);
  /** 한 출처의 기간(차트) 목록과 상태. GitHub 것은 meta 바로 아래에, 나머지는 meta.hf, meta.as에 있다(없으면 null). */
  const metaOf = (src = state.src) => (state.meta ? (src === 'gh' ? state.meta : state.meta[src]) || null : null);
  const listing = () => {
    const m = metaOf();
    return (m && m.types[state.type]) || [];
  };
  /** App Store가 어느 나라 스토어인지 */
  const countryName = () => {
    const m = metaOf('as');
    const c = (m && m.country) || 'kr';
    return COUNTRIES[c] || c.toUpperCase();
  };
  const currentDesc = () => listing().find((d) => d.key === state.key) || null;
  const currentStatus = () => state.status.get(currentId()) || null;
  const collector = () => state.collectors[state.src] || null;

  /**
   * 서버는 "받은 그대로의 상위 N개"와 "스팸 의심을 뺀 상위 N개"를 한 목록에 담아 준다.
   * 지금 보기 방식에 해당하는 쪽만 골라, 그 방식의 순위·변동을 rank·move로 맞춘다.
   */
  function chartItems() {
    const d = state.data;
    if (state.view !== 'ready' || !d) return [];
    const top = d.top || 100;
    if (!state.hideSpam) return d.items.filter((r) => r.rank <= top);
    return d.items.filter((r) => !r.spam && r.crank <= top).map((r) => ({ ...r, rank: r.crank, move: r.cmove }));
  }

  /** 스팸 의심 개수: 숨김 상태에서는 건너뛴 개수, 아니면 순위표에 섞여 있는 개수 */
  function spamCount() {
    const d = state.data;
    if (state.view !== 'ready' || !d) return 0;
    if (!state.hideSpam) return state.items.filter((r) => r.spam).length;
    return d.skipped || 0; // 순위표 밖에서 건너뛴 것까지 서버가 센 값
  }

  /** 목록에 없는 기간(주소로 직접 연 오래된 기간)의 이름 */
  function keyLabel(key) {
    let m;
    if ((m = /^(\d{4})-W(\d{2})$/.exec(key))) return `${m[1]}년 ${+m[2]}주차`;
    if ((m = /^(\d{4})-(\d{2})$/.exec(key))) return `${m[1]}년 ${+m[2]}월`;
    if (/^\d{4}$/.test(key)) return `${key}년`;
    return key;
  }

  /** 언어 색 점. 작업 종류(Hugging Face)에는 정해진 색이 없어 점을 찍지 않는다. */
  function langDot(lang) {
    if (state.src !== 'gh') return '';
    const color = LANG_COLORS[lang];
    return `<i class="lang-dot"${color ? ` style="background:${color}"` : ''}></i>`;
  }

  // ── 주소(#weekly/rolling, #hf/weekly/rolling, #hn/weekly/rolling, #as/free/all) ────
  // GitHub은 앞머리 없이, 나머지 출처는 그 이름을 앞에 붙인다.
  const HASH = new RegExp(`^#(?:(${Object.keys(SOURCES).filter((src) => src !== 'gh').join('|')})/)?([a-z]+)/([\\w-]+)$`);
  function readHash() {
    const m = HASH.exec(location.hash);
    state.src = m && m[1] ? m[1] : 'gh';
    const s = S();
    const known = Boolean(m) && s.types.some(([t]) => t === m[2]); // 그 출처에 있는 종류인지
    state.type = known ? m[2] : s.home[0];
    state.key = known ? m[3] : s.home[1];
  }

  function go(type, key, src = state.src) {
    const hash = `#${src === 'gh' ? '' : `${src}/`}${type}/${key}`;
    if (location.hash === hash) return;
    location.hash = hash;
  }

  /** 출처가 바뀌면 달라지는 고정 문구(제목, 탭, 표 머리, 안내문)를 맞춘다. */
  function applySource() {
    const s = S();
    document.documentElement.dataset.src = state.src;
    document.title = s.title;
    el.brandText.textContent = s.title;
    el.types.innerHTML = s.types.map(([t, label]) => `<button type="button" data-type="${t}" aria-pressed="false">${esc(label)}</button>`).join('');
    // 고르는 것이 기간인지(GitHub·Hugging Face) 차트 종류와 카테고리인지(App Store)에 맞춰 읽어 주는 이름을 바꾼다.
    const pick = state.src === 'as' ? '카테고리' : '기간';
    el.types.setAttribute('aria-label', state.src === 'as' ? '차트 종류' : '집계 단위');
    el.prev.setAttribute('aria-label', `이전 ${pick}`);
    el.next.setAttribute('aria-label', `다음 ${pick}`);
    el.period.setAttribute('aria-label', `${pick} 선택`);
    el.unitHead.textContent = s.unit;
    el.scoreHead.textContent = s.score;
    el.seg.querySelector('[data-sort="rank"]').textContent = s.rankSort;
    el.seg.querySelector('[data-sort="gain"]').textContent = s.gainSort;
    // 포크 수는 GitHub에만 있다. 포크순으로 보다가 다른 출처로 가면 기본 정렬로 돌아간다.
    el.seg.querySelector('[data-sort="forks"]').hidden = state.src !== 'gh';
    if (state.src !== 'gh' && state.sort === 'forks') state.sort = 'rank';
    for (const x of el.seg.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.sort === state.sort));
    el.facetLabel.textContent = s.facet;
    el.search.placeholder = s.searchHint;
    el.facetTitle.textContent = `${s.facet}별 ${s.unit} 수`;
    el.facetHint.textContent = `막대를 누르면 그 ${s.facet}만 보여 줍니다.`;
    el.histTitle.textContent = s.histTitle;
    el.histHint.textContent = s.histHint;
    el.foot.innerHTML = s.foot.map((p) => `<p>${esc(p.replaceAll('{country}', countryName()))}</p>`).join('');
    el.spamLabel.hidden = state.src !== 'gh'; // 스팸 의심 규칙(스타 대비 포크)은 GitHub에만 있다
    el.ageField.hidden = state.src !== 'as'; // 출시 시기로 거르기는 App Store에만 있다
    el.age.value = String(state.age || '');
  }

  // ── 서버 통신 ────────────────────────────────────────────────
  function applyMeta(meta) {
    state.meta = meta;
    state.live = meta.live !== false;
    state.metaDay = Math.floor(meta.now / DAY);
    // 서버 방식에서는 서버 시계에 맞춘다. 정적 사이트의 meta.now는 만든 시각이라 시계 보정에 쓸 수 없다.
    state.skew = state.live ? meta.now - Date.now() : 0;
    document.documentElement.dataset.mode = state.live ? 'live' : 'static';
    for (const src of Object.keys(SOURCES)) {
      const m = metaOf(src);
      if (!m) continue;
      state.collectors[src] = m.collector;
      for (const type of Object.keys(m.types)) for (const b of m.types[type]) state.status.set(idOf(type, b.key, src), b);
    }
    if (state.src === 'as') applySource(); // 안내문에 들어가는 나라 이름은 목록을 받아야 안다
    renderNav();
    renderSub();
    renderSpam();
    renderStatus();
  }

  // 서버 방식과 정적 사이트가 같은 주소를 쓴다(주소는 모두 상대 경로: 하위 경로에 올려도 된다).
  const fetchMeta = () =>
    fetch('data/meta.json', { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });

  async function loadChart({ live = false } = {}) {
    const seq = ++state.loadSeq;
    const { type, key } = state;
    const id = idOf(type, key);
    const dir = S().dir;
    clearTimeout(state.retryTimer);

    // 이 사이트에 없는 출처(예: Hugging Face 수집을 끈 경우)는 요청하지 않는다.
    if (state.meta && !metaOf()) {
      state.loadingId = '';
      state.view = 'invalid';
      state.data = null;
      state.dataId = '';
      renderAll();
      return;
    }

    // 정적 사이트: 목록에는 있지만 아직 만들어지지 않은 기간은 파일이 없으니 요청하지 않는다.
    const known = state.status.get(id);
    if (!state.live && known && !known.hasData) {
      state.loadingId = '';
      state.view = 'pending';
      state.data = null;
      state.dataId = '';
      renderAll();
      return;
    }
    state.loadingId = id;

    let res;
    try {
      // ?v=는 브라우저·CDN이 예전 판을 돌려주지 않게 하는 꼬리표다.
      const v = known && known.version ? `?v=${known.version}` : '';
      res = await fetch(`data/${dir}${type}.${encodeURIComponent(key)}.json${v}`, state.live ? undefined : { cache: 'no-cache' });
    } catch {
      if (seq !== state.loadSeq) return;
      state.loadingId = '';
      if (state.dataId !== id) state.view = 'offline';
      renderAll();
      state.retryTimer = setTimeout(() => loadChart({ live }), 5000);
      return;
    }
    if (seq !== state.loadSeq) return;
    state.loadingId = '';

    if (res.status === 202) {
      state.view = 'pending';
      state.data = null;
      state.dataId = '';
      renderAll();
      state.retryTimer = setTimeout(loadChart, 5000); // 푸시를 놓쳤을 때를 위한 안전망
      return;
    }
    if (!res.ok) {
      state.view = 'invalid';
      state.data = null;
      state.dataId = '';
      renderAll();
      return;
    }

    const data = await res.json();
    if (seq !== state.loadSeq) return;
    const sameView = state.dataId === id && state.view === 'ready';
    state.data = data;
    state.dataId = id;
    state.view = 'ready';
    renderAll({ live: live && sameView });
    // 받는 사이에 서버 쪽 순위가 한 번 더 바뀌었으면 따라잡는다.
    // (정적 사이트에서는 CDN 반영이 늦을 수 있어 여기서 되풀이하지 않고 다음 확인 때 다시 본다.)
    const st = state.status.get(id);
    if (state.live && st && st.version > data.version) loadChart({ live: true });
  }

  /**
   * 정적 사이트: 새로 만들어진 판이 있는지 확인하고, 보고 있는 기간이 바뀌었으면 다시 받는다.
   * 다음 수집 예정 시각이 지나기 전에는 새 판이 있을 리 없으므로 아예 묻지 않고,
   * 지난 뒤에도(예약 실행은 늦어질 수 있다) POLL_GAP에 한 번만 묻는다.
   */
  const POLL_GAP = 10 * 60_000;
  let polledAt = 0;
  const nextAt = (m) => m.nextAt || m.builtAt + m.every;
  /** 순위를 마지막으로 받아 온 때. 푸시로 화면만 다시 낸 판은 만든 때(builtAt)보다 이르다. */
  const collectedAt = (m) => m.collectedAt || m.builtAt;
  async function poll() {
    if (document.hidden) return;
    const cur = state.meta;
    if (cur && Date.now() < nextAt(cur)) return;
    if (Date.now() - polledAt < POLL_GAP) return;
    polledAt = Date.now();
    let meta;
    try {
      meta = await fetchMeta();
    } catch {
      return; // 다음 확인 때 다시 본다
    }
    if (state.meta && meta.builtAt === state.meta.builtAt) return;
    applyMeta(meta);
    const id = currentId();
    const st = state.status.get(id);
    const stale = !state.data || state.dataId !== id || (st && st.version !== state.data.version);
    if (st && st.hasData && stale && state.loadingId !== id) loadChart({ live: true });
  }

  function connect() {
    const es = new EventSource('api/events');
    es.addEventListener('hello', (e) => {
      const again = state.everConnected;
      state.connected = true;
      state.everConnected = true;
      applyMeta(JSON.parse(e.data));
      const st = currentStatus();
      // 끊겼다 다시 붙은 사이에 바뀐 내용이 있으면 따라잡는다.
      if (again && st && st.hasData && (!state.data || st.version !== state.data.version)) loadChart({ live: true });
      renderLive();
    });
    es.addEventListener('bucket', (e) => {
      const st = JSON.parse(e.data);
      const id = idOf(st.type, st.key, st.src || 'gh');
      state.status.set(id, { ...state.status.get(id), ...st });
      if (id !== currentId()) return;
      const stale = !state.data || state.dataId !== id || st.version !== state.data.version;
      if (st.hasData && stale && state.loadingId !== id) loadChart({ live: true });
      renderNotice();
      renderStatus();
    });
    es.addEventListener('collector', (e) => {
      const c = JSON.parse(e.data);
      state.collectors[c.src || 'gh'] = c;
      renderStatus();
    });
    es.onopen = () => {
      state.connected = true;
      renderLive();
    };
    es.onerror = () => {
      state.connected = false; // EventSource가 알아서 다시 붙는다
      renderLive();
    };
  }

  // ── 그리기: 기간 선택 ─────────────────────────────────────────
  function optionLabel(d) {
    return d.kind === 'current' ? CURRENT_LABEL[state.type] : d.label;
  }

  function renderNav() {
    // 출처 탭은 이 사이트에 그 출처의 순위가 있을 때만(또는 그 주소로 들어왔을 때만) 보인다.
    const tab = tabOf(state.src);
    let shown = 0;
    for (const b of el.sources.querySelectorAll('button')) {
      const src = b.dataset.src;
      b.hidden = !(src === 'gh' || src === tab || family(src).some((x) => metaOf(x)));
      if (!b.hidden) shown += 1;
      b.setAttribute('aria-pressed', String(src === tab));
    }
    el.sources.hidden = shown < 2;
    // 탭 안에서 오가는 단추(Hugging Face: 모델 | Spaces | 데이터셋). 볼 것이 둘 이상일 때만 보인다.
    const subs = family(tab).filter((src) => src === state.src || metaOf(src));
    const subSig = `${state.src}|${subs.join(',')}`;
    if (el.subs.dataset.sig !== subSig) {
      el.subs.dataset.sig = subSig;
      el.subs.hidden = subs.length < 2;
      el.subs.setAttribute('aria-label', `${S().name}에서 볼 것`);
      el.subs.innerHTML = subs
        .map((src) => `<button type="button" data-sub="${src}" aria-pressed="${src === state.src}">${esc(SOURCES[src].sub || SOURCES[src].name)}</button>`)
        .join('');
    }
    for (const b of el.types.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.type === state.type));
    }
    const list = listing();
    const sig = `${state.src}|${state.type}|${list.map((d) => `${d.key}:${d.kind}`).join(',')}|${state.key}`;
    if (el.period.dataset.sig !== sig) {
      el.period.dataset.sig = sig;
      const known = list.some((d) => d.key === state.key);
      el.period.innerHTML =
        list.map((d) => `<option value="${esc(d.key)}">${esc(optionLabel(d))}</option>`).join('') +
        (known ? '' : `<option value="${esc(state.key)}">${esc(keyLabel(state.key))}</option>`);
    }
    el.period.value = state.key;
    const i = list.findIndex((d) => d.key === state.key);
    // 기간 목록은 최근 것이 앞에 있어 "이전"이 목록의 뒤쪽이다. 카테고리 목록(App Store)은 적힌 순서대로 넘긴다.
    const atEnd = i < 0 || i >= list.length - 1;
    const atStart = i <= 0;
    el.prev.disabled = state.src === 'as' ? atStart : atEnd;
    el.next.disabled = state.src === 'as' ? atEnd : atStart;
  }

  function step(delta) {
    const list = listing();
    const i = list.findIndex((d) => d.key === state.key);
    const target = list[i + delta];
    if (i >= 0 && target) go(state.type, target.key);
  }

  function renderSub() {
    // 기간을 막 바꿔 새 데이터가 아직 안 왔으면 이전 기간의 설명을 보여 주지 않는다.
    const d = state.view === 'ready' && state.dataId === currentId() ? state.data : null;
    const desc = currentDesc();
    if (state.src === 'as') {
      // App Store는 기간이 아니라 차트다: "한국 App Store 게임 · 무료 앱 차트 상위 100개"
      const s = S();
      if (!desc) el.sub.innerHTML = '&nbsp;';
      else el.sub.textContent = `${countryName()} App Store ${desc.label} · ${s.typeNames[state.type]} 차트` + (d ? ` 상위 ${state.items.length}개` : '');
      return;
    }
    if (!d) {
      if (!desc) el.sub.innerHTML = '&nbsp;';
      else if (desc.kind === 'rolling') el.sub.textContent = `${ymd(desc.from)}부터 지금까지`;
      else el.sub.textContent = `${desc.label}, ${ymd(desc.from)} – ${md(desc.to)}`;
      return;
    }
    const kind = desc ? desc.kind : d.to ? 'closed' : 'rolling';
    const toText = d.to ? (d.to.slice(0, 4) === d.from.slice(0, 4) ? md(d.to) : ymd(d.to)) : '';
    let when;
    if (kind === 'rolling') when = `${ymd(d.from)}부터 지금까지`;
    else if (kind === 'current') when = `${desc.label}(${ymd(d.from)} – ${toText}), 지금까지`;
    else when = `${ymd(d.from)} – ${toText}에`;
    const total = d.total == null ? '' : d.approx ? ` 약 ${approxKo(d.total)}개` : ` ${fmt(d.total)}개`;
    const skipped = state.hideSpam ? spamCount() : 0;
    const s = S();
    // cut: 순위표가 다 차지 않았고, 이 수보다 적은 것은 아직 훑지 못했다(Hugging Face).
    const cut = d.cut && state.items.length < (d.top || 100) ? ` (${s.score} ${fmt(d.cut)}개 이상까지만 훑었습니다)` : '';
    el.sub.textContent =
      `${when} ${s.pool}${total} 가운데 ${s.order}으로 ${state.items.length}개` +
      (skipped ? ` (스팸 의심 ${fmt(skipped)}개 제외)` : '') +
      cut;
  }

  // ── 그리기: 순위표 ───────────────────────────────────────────
  function visibleItems() {
    const d = state.data;
    let items = state.items;
    if (state.lang) items = items.filter((r) => langOf(r) === state.lang);
    if (state.src === 'as' && state.age) {
      const since = now() - state.age * DAY; // 출시된 지 며칠 안쪽인 앱만
      items = items.filter((r) => r.created && Date.parse(r.created) >= since);
    }
    if (state.q) {
      const q = state.q.toLowerCase();
      const facet = S().searchFacet; // 분류(사이트 이름)로도 찾을 수 있는 출처
      items = items.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.desc.toLowerCase().includes(q) ||
          (r.owner || '').toLowerCase().includes(q) ||
          (facet && (r.lang || '').toLowerCase().includes(q)),
      );
    }
    if (state.sort === 'gain') {
      items = [...items].sort((a, b) => (b.gain ?? -Infinity) - (a.gain ?? -Infinity) || a.rank - b.rank);
    } else if (state.sort === 'pace') {
      items = [...items].sort((a, b) => pace(b, d.dataAt) - pace(a, d.dataAt));
    } else if (state.sort === 'forks') {
      items = [...items].sort((a, b) => (b.forks || 0) - (a.forks || 0) || a.rank - b.rank);
    }
    return items;
  }

  function moveHtml(move) {
    if (move === null || move === undefined) return '<span class="move"></span>';
    if (move === 'new') return '<span class="move move-new" aria-label="새로 진입">NEW</span>';
    if (move > 0) return `<span class="move move-up" aria-label="${move}계단 상승">▲${move}</span>`;
    if (move < 0) return `<span class="move move-down" aria-label="${-move}계단 하락">▼${-move}</span>`;
    return '<span class="move move-same" aria-label="변동 없음">–</span>';
  }

  function gainHtml(r, span) {
    const tip = span ? ` data-tip="최근 ${spanText(span)} 동안의 ${S().score} 변화"` : '';
    if (r.gain === null || r.gain === undefined) return `<div class="gain gain-none"${tip}>–</div>`;
    if (r.gain > 0) return `<div class="gain gain-up"${tip}>+${fmt(r.gain)}</div>`;
    if (r.gain < 0) return `<div class="gain gain-down"${tip}>−${fmt(-r.gain)}</div>`;
    return `<div class="gain gain-none"${tip}>0</div>`;
  }

  /** 하루 평균: 작은 값은 소수 한 자리까지 */
  const paceText = (v) => (v < 10 ? String(Math.round(v * 10) / 10) : fmt(Math.round(v)));

  function rowHtml(r, max, d) {
    const s = S();
    const hf = s.tab === 'hf'; // 모델·Space·데이터셋
    const hn = state.src === 'hn';
    const as = state.src === 'as';
    // 저장소·모델은 "주인/이름"이고, 글 제목과 앱 이름에는 주인이 붙지 않는다(이름에 /가 들어 있어도 나누지 않는다).
    const slash = s.plainName ? -1 : r.name.indexOf('/');
    const owner = slash < 0 ? '' : r.name.slice(0, slash + 1);
    const repo = slash < 0 ? r.name : r.name.slice(slash + 1);
    // 링크는 https만 건다. Hacker News의 오래된 글은 원문이 http인 것이 많아 그것까지 허용한다.
    const url = r.url.startsWith('https://') || (hn && r.url.startsWith('http://')) ? r.url : '#';
    let avatar = r.avatar && r.avatar.startsWith('https://') ? r.avatar : '';
    if (avatar && state.src === 'gh') avatar += `${avatar.includes('?') ? '&' : '?'}s=72`; // GitHub 프로필 사진 크기 지정
    const pct = max ? Math.max(0.5, (r.stars / max) * 100) : 0;
    const share = max ? Math.round((r.stars / max) * 100) : 0;
    // 출처마다 다른 곁들임 정보: GitHub은 포크 수, Hugging Face는 라이브러리와 다운로드 수, Hacker News는 올린 사람과
    // 토론으로 가는 링크, App Store는 개발사와 가격. 사진이 없는 출처는 머리글자로 대신한다
    // (Hugging Face는 주인 이름, Hacker News는 원문 사이트의 첫 글자).
    const letter = hf ? (owner || repo).charAt(0) : hn ? (r.lang || '').charAt(0) : '';
    const face = avatar
      ? `<img class="avatar" src="${esc(avatar)}" alt="" width="36" height="36" loading="lazy" decoding="async">`
      : `<span class="avatar${letter ? ' avatar-txt' : ''}" aria-hidden="true">${esc(letter.toUpperCase())}</span>`;
    let extra;
    if (hf) {
      // 다운로드 수는 모델과 데이터셋에만 있다(Space에는 없다).
      const dl = r.downloads === undefined ? '' : `<span data-tip="최근 30일 동안의 다운로드 횟수">다운로드 ${fmt(r.downloads || 0)}</span>`;
      extra = `${r.lib ? `<span>${esc(r.lib)}</span>` : ''}${dl}`;
    } else if (hn) {
      const talk = r.hn && r.hn.startsWith('https://news.ycombinator.com/') ? r.hn : '#';
      extra =
        `${r.owner ? `<span>${esc(r.owner)}</span>` : ''}` +
        `<a class="meta-link" href="${esc(talk)}" target="_blank" rel="noopener" data-tip="Hacker News의 토론 보기">댓글 ${fmt(r.comments || 0)}</a>`;
    } else if (as) extra = `${r.owner ? `<span>${esc(r.owner)}</span>` : ''}${r.price ? `<span>${esc(r.price)}</span>` : ''}`;
    else extra = `<span>포크 ${fmt(r.forks)}</span>`;
    // 크기 칸: 스타·좋아요는 1위 대비 막대로, 평가 수는 앱마다 수백만 배씩 차이 나 막대가 무의미하므로 별점을 대신 적는다.
    const gauge = as
      ? `<span class="rating">${r.rating ? `★ ${r.rating.toFixed(1)}` : ''}</span>`
      : `<span class="bar"><i style="width:${pct.toFixed(2)}%"></i></span>`;
    const scoreTip = as
      ? `평가 ${fmt(r.stars)}개${r.rating ? `&#10;별점 ${r.rating.toFixed(1)}` : ''}&#10;${esc(countryName())} 스토어 기준`
      : `${s.score} ${fmt(r.stars)}${s.scoreUnit || '개'}&#10;이 기간 1위의 ${share}%`;
    const when = r.created ? `<span>${ageText(r.created, s.made)}</span>` : '';
    const perDay = r.created ? `<span>하루 평균 ${s.mark} ${paceText(pace(r, d.dataAt))}</span>` : '';
    return `<li class="row" data-id="${esc(r.id)}" data-stars="${r.stars}"${r.rank <= 3 ? ' data-top' : ''}>
      <div class="rank"><span class="rank-num">${r.rank}</span>${moveHtml(r.move)}</div>
      ${face}
      <div class="repo">
        <a class="name" href="${esc(url)}" target="_blank" rel="noopener"><span class="owner">${esc(owner)}</span><span class="repo-name">${esc(repo)}</span></a>
        ${r.desc ? `<p class="desc">${esc(r.desc)}</p>` : ''}
        <p class="meta">
          ${r.spam ? `<span class="flag" data-tip="${esc(spamRuleText())}">스팸 의심</span>` : ''}
          ${r.lang ? `<span class="lang">${langDot(r.lang)}${esc(r.lang)}</span>` : ''}
          ${extra}
          ${when}
          ${perDay}
        </p>
      </div>
      <div class="stars" data-tip="${scoreTip}">
        ${gauge}
        <span class="stars-val">${fmt(r.stars)}</span>
      </div>
      ${gainHtml(r, d.span)}
    </li>`;
  }

  function showEmpty(title, body, action) {
    el.rows.innerHTML = '';
    el.cols.hidden = true;
    el.empty.hidden = false;
    // 금방 끝나는 첫 로딩에서는 문구가 깜빡이지 않게 조금 늦게 드러낸다.
    el.empty.classList.toggle('late', state.view === 'loading');
    el.empty.innerHTML =
      `<strong>${esc(title)}</strong>${esc(body)}` +
      (action ? `<div><button class="btn" type="button" data-action="${action.id}">${esc(action.label)}</button></div>` : '');
  }

  function renderBoard({ live = false } = {}) {
    const d = state.data;
    if (state.view !== 'ready' || !d) {
      el.count.textContent = '';
      if (state.view === 'pending') {
        const c = collector();
        const limit = c && c.rate.limit ? c.rate.limit : 10;
        if (!state.live) showEmpty(`아직 받아 오지 못한 ${S().bucket}입니다`, `다음 수집 때 채워집니다(${everText()}마다).`);
        else if (S().pending) showEmpty(S().pending[0], S().pending[1]);
        else showEmpty('이 기간의 순위를 받아 오는 중입니다', `GitHub 검색 한도(분당 ${limit}회)에 맞춰 차례로 받고 있습니다. 받는 즉시 여기에 나타납니다.`);
      } else if (state.view === 'invalid' && state.src === 'as') {
        showEmpty('없는 차트입니다', '주소가 잘못됐거나 이 사이트가 받지 않는 카테고리입니다.', { id: 'home', label: S().homeLabel });
      } else if (state.view === 'invalid' && !state.live) {
        showEmpty('준비되지 않은 기간입니다', '이 사이트는 기간 목록에 있는 것만 미리 만들어 둡니다.', { id: 'home', label: S().homeLabel });
      } else if (state.view === 'invalid') {
        showEmpty('없는 기간입니다', '주소가 잘못됐거나 아직 오지 않은 기간입니다.', { id: 'home', label: S().homeLabel });
      } else if (state.view === 'offline') {
        showEmpty('데이터를 불러오지 못했습니다', '연결 상태를 확인하세요. 5초마다 다시 시도합니다.');
      } else {
        showEmpty('불러오는 중입니다', '');
      }
      return;
    }

    const items = visibleItems();
    const total = state.items.length;
    el.count.textContent = items.length === total ? `${fmt(total)}개` : `${fmt(total)}개 중 ${fmt(items.length)}개`;
    el.gainHead.textContent = d.span ? `증가(${spanText(d.span)})` : '증가';
    const s = S();
    if (d.span) el.gainHead.dataset.tip = `최근 ${spanText(d.span)} 동안 늘어난 ${s.score} 수입니다. 앞서 수집해 둔 스냅샷과 비교합니다.`;
    else if (state.live) el.gainHead.dataset.tip = '서버가 10분 넘게 지켜본 뒤부터 표시됩니다.';
    else el.gainHead.dataset.tip = '다음 수집 때부터, 앞서 수집한 값과 비교해 표시됩니다.';

    if (total === 0 && d.items.length > 0) {
      return showEmpty('스팸으로 의심되는 저장소뿐입니다', '숨기기를 끄면 볼 수 있습니다.', { id: 'showspam', label: '스팸 의심도 보기' });
    }
    if (total === 0) return showEmpty(s.none, d.cut ? `${s.score} ${fmt(d.cut)}개 이상인 것까지만 훑었습니다.` : '');
    if (items.length === 0) {
      return showEmpty(s.noMatch[0], s.noMatch[1], { id: 'clear', label: '조건 지우기' });
    }

    const animate = live && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const before = new Map();
    if (animate) {
      for (const li of el.rows.children) {
        before.set(li.dataset.id, { top: li.getBoundingClientRect().top, stars: li.dataset.stars });
      }
    }

    const max = state.items.reduce((m, r) => Math.max(m, r.stars), 0); // 차트순(App Store)에서는 첫 줄이 가장 크다는 보장이 없다
    el.empty.hidden = true;
    el.cols.hidden = false;
    el.rows.innerHTML = items.map((r) => rowHtml(r, max, d)).join('');

    if (!animate || before.size === 0) return;
    const moves = [];
    for (const li of el.rows.children) {
      const old = before.get(li.dataset.id);
      if (!old) {
        li.classList.add('entered');
        continue;
      }
      if (old.stars !== li.dataset.stars) li.classList.add('bumped');
      const dy = old.top - li.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) moves.push([li, dy]);
    }
    // 순위가 바뀐 줄은 원래 자리에서 새 자리로 미끄러져 간다.
    for (const [li, dy] of moves) {
      li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], {
        duration: 480,
        easing: 'cubic-bezier(.2,.7,.2,1)',
      });
    }
  }

  function renderNotice() {
    const d = state.data;
    const st = currentStatus();
    let text = '';
    if (state.view === 'ready' && d) {
      if (st && st.error) {
        text = `마지막 갱신에 실패했습니다(${st.error}). ${st.fetchedAt ? rel(st.fetchedAt) : '이전'} 데이터를 보여 주고 있으며, 자동으로 다시 시도합니다.`;
      } else if (d.partial) {
        text = '스팸으로 의심되는 저장소가 많아, 그만큼 아래 순위를 더 받아 오는 중입니다. 받는 대로 채워집니다.';
      } else if (d.incomplete) {
        text = 'GitHub 검색이 시간 안에 끝나지 않아 일부 저장소가 빠졌을 수 있습니다. 다음 갱신 때 다시 확인합니다.';
      }
    }
    el.notice.hidden = !text;
    el.notice.textContent = text ? `${d && d.partial && !(st && st.error) ? '…' : '⚠'} ${text}` : '';
  }

  // ── 그리기: 언어 ─────────────────────────────────────────────
  function langStats() {
    const map = new Map();
    for (const r of state.items) {
      const k = langOf(r);
      const cur = map.get(k) || { lang: k, n: 0, stars: 0 };
      cur.n += 1;
      cur.stars += r.stars;
      map.set(k, cur);
    }
    return [...map.values()].sort((a, b) => b.n - a.n || b.stars - a.stars);
  }

  function renderLangs() {
    if (state.view !== 'ready' || !state.data || state.items.length === 0) {
      el.langs.innerHTML = '';
      el.lang.innerHTML = '<option value="">전체</option>';
      el.lang.dataset.sig = '';
      return;
    }
    const stats = langStats();
    const total = state.items.length;

    const sig = stats.map((s) => `${s.lang}:${s.n}`).join(',');
    if (el.lang.dataset.sig !== sig) {
      el.lang.dataset.sig = sig;
      el.lang.innerHTML =
        '<option value="">전체</option>' +
        stats.map((s) => `<option value="${esc(s.lang)}">${esc(s.lang)} (${s.n})</option>`).join('');
    }
    // 고른 언어가 이 기간에 없으면 목록에 임시로 넣어 선택 상태를 유지한다.
    if (state.lang && !stats.some((s) => s.lang === state.lang)) {
      el.lang.insertAdjacentHTML('beforeend', `<option value="${esc(state.lang)}">${esc(state.lang)} (0)</option>`);
      el.lang.dataset.sig = '';
    }
    el.lang.value = state.lang;

    const top = stats.slice(0, 8);
    const rest = stats.slice(8);
    const max = top[0].n;
    const { unit, score, facet } = S();
    let html = top
      .map((s) => {
        const share = Math.round((s.n / total) * 100);
        return `<button class="lang-row" type="button" data-lang="${esc(s.lang)}" aria-pressed="${s.lang === state.lang}" data-tip="${esc(s.lang)}&#10;${unit} ${s.n}개 (${share}%)&#10;${score} 합계 ${fmt(s.stars)}" aria-label="${esc(s.lang)}, ${unit} ${s.n}개">
          <span class="lang-name">${langDot(s.lang)}<span>${esc(s.lang)}</span></span>
          <span class="lang-bar"><i style="width:${((s.n / max) * 100).toFixed(1)}%"></i></span>
          <span class="lang-n">${s.n}</span>
        </button>`;
      })
      .join('');
    if (rest.length) {
      const n = rest.reduce((sum, s) => sum + s.n, 0);
      html += `<div class="lang-row" data-tip="${esc(rest.map((s) => `${s.lang} ${s.n}`).join(', '))}">
        <span class="lang-name">${state.src === 'gh' ? '<i class="lang-dot"></i>' : ''}<span>그 밖 ${rest.length}개 ${facet}</span></span>
        <span class="lang-bar"><i style="width:${((n / max) * 100).toFixed(1)}%;max-width:100%"></i></span>
        <span class="lang-n">${n}</span>
      </div>`;
    }
    el.langs.innerHTML = html;
    el.langs.toggleAttribute('data-filtered', Boolean(state.lang));
  }

  // ── 그리기: 만들어진 시점 ─────────────────────────────────────
  function buildBins(d) {
    const today = Math.floor(now() / DAY) * DAY;
    const from = Date.parse(d.from);
    const end = d.to ? Math.min(Date.parse(d.to), today) : today;
    const bins = [];
    if (state.src === 'as') {
      // 차트에는 기간이 없다. 출시 연도별로 최근 10년을 보여 주고, 그 이전은 한 칸에 모은다.
      const year = new Date(now()).getUTCFullYear();
      const first = year - 9;
      bins.push({ start: -Infinity, end: Date.UTC(first, 0, 1), short: `~${first - 1}`, long: `${first - 1}년까지` });
      for (let y = first; y <= year; y++) bins.push({ start: Date.UTC(y, 0, 1), end: Date.UTC(y + 1, 0, 1), short: String(y), long: `${y}년` });
    } else if (state.type === 'yearly') {
      let y = new Date(from).getUTCFullYear();
      let m = new Date(from).getUTCMonth();
      const ey = new Date(end).getUTCFullYear();
      const em = new Date(end).getUTCMonth();
      while (y < ey || (y === ey && m <= em)) {
        bins.push({ start: Date.UTC(y, m, 1), end: Date.UTC(y, m + 1, 1), short: `${y}.${pad(m + 1)}`, long: `${y}년 ${m + 1}월` });
        m += 1;
        if (m > 11) {
          m = 0;
          y += 1;
        }
      }
    } else {
      for (let t = from; t <= end; t += DAY) {
        const dt = new Date(t);
        bins.push({
          start: t,
          end: t + DAY,
          short: `${pad(dt.getUTCMonth() + 1)}.${pad(dt.getUTCDate())}`,
          long: `${dt.getUTCMonth() + 1}월 ${dt.getUTCDate()}일 (${WEEKDAYS[dt.getUTCDay()]})`,
        });
      }
    }
    for (const b of bins) {
      b.n = 0;
      b.top = null;
    }
    for (const r of state.items) {
      const c = Date.parse(r.created);
      const b = bins.find((x) => c >= x.start && c < x.end);
      if (!b) continue;
      b.n += 1;
      if (!b.top) b.top = r; // items는 스타 내림차순이므로 처음 만난 것이 그 구간의 1위
    }
    return bins;
  }

  function niceStep(max) {
    for (const s of [1, 2, 5, 10, 20, 25, 50, 100]) if (max / s <= 4) return s;
    return 200;
  }

  function renderHist() {
    const d = state.data;
    if (state.view !== 'ready' || !d || state.items.length === 0) {
      el.hist.innerHTML = '';
      return;
    }
    const bins = buildBins(d);
    if (bins.length === 0) {
      el.hist.innerHTML = '';
      return;
    }
    const W = Math.max(220, Math.round(el.hist.clientWidth));
    const H = 150;
    const m = { l: 24, r: 4, t: 8, b: 22 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const maxN = Math.max(1, ...bins.map((b) => b.n));
    const stepN = niceStep(maxN);
    const top = Math.ceil(maxN / stepN) * stepN;
    const y = (v) => m.t + ih - (v / top) * ih;
    const slot = iw / bins.length;
    const bw = Math.min(24, Math.max(2, slot - 2));

    let svg = '';
    for (let v = stepN; v <= top; v += stepN) {
      svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    }
    svg += `<text x="${m.l - 6}" y="${y(0) + 4}" text-anchor="end">0</text>`;

    bins.forEach((b, i) => {
      const x = m.l + i * slot + (slot - bw) / 2;
      const h = (b.n / top) * ih;
      const r = Math.min(4, bw / 2, h);
      let tip;
      if (!b.n) tip = `${b.long}&#10;순위에 든 ${S().unit} 없음`;
      else if (state.src === 'as') tip = `${b.long} 출시&#10;차트에 오른 앱 ${b.n}개&#10;그중 순위가 가장 높은 앱: ${esc(b.top.name)} (${b.top.rank}위)`;
      else tip = `${b.long}&#10;순위에 든 ${S().unit} ${b.n}개&#10;그중 1위 ${esc(b.top.name)} ${S().mark} ${fmt(b.top.stars)}`;
      // 위쪽(데이터 끝)만 둥글리고 기준선 쪽은 각지게 둔다.
      const bar = b.n
        ? `<path class="col-bar" d="M${x},${y(0)} V${y(0) - h + r} Q${x},${y(0) - h} ${x + r},${y(0) - h} H${x + bw - r} Q${x + bw},${y(0) - h} ${x + bw},${y(0) - h + r} V${y(0)} Z"/>`
        : '';
      svg += `<g class="col" data-tip="${tip}"><rect class="col-hit" x="${m.l + i * slot}" y="${m.t}" width="${slot}" height="${ih}"/>${bar}</g>`;
    });
    svg += `<line class="base" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;

    // 가로축 이름표는 처음·끝(자리가 되면 가운데)만 단다.
    const picks = bins.length > 2 && W >= 260 ? [0, Math.floor((bins.length - 1) / 2), bins.length - 1] : [0, bins.length - 1];
    [...new Set(picks)].forEach((i, n, arr) => {
      const cx = m.l + i * slot + slot / 2;
      const anchor = n === 0 ? 'start' : n === arr.length - 1 ? 'end' : 'middle';
      const x = n === 0 ? m.l : n === arr.length - 1 ? W - m.r : cx;
      svg += `<text x="${x}" y="${H - 6}" text-anchor="${anchor}">${bins[i].short}</text>`;
    });

    const peak = bins.reduce((a, b) => (b.n > a.n ? b : a));
    el.hist.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${S().histTitle}별 ${S().unit} 수. 가장 많은 구간은 ${peak.long}, ${peak.n}개">${svg}</svg>`;
  }

  // ── 그리기: 상태 ─────────────────────────────────────────────
  /** 정적 사이트가 만들어지는 간격: "약 12시간" */
  function everText() {
    const ms = (state.meta && state.meta.every) || 0;
    return ms >= 3_600_000 ? `약 ${Math.round(ms / 3_600_000)}시간` : `약 ${Math.max(1, Math.round(ms / 60_000))}분`;
  }

  function renderLive() {
    const st = currentStatus();
    if (!state.live && state.meta) {
      // 예약 실행이 한참 밀리거나 멈췄으면 알린다.
      const m = state.meta;
      const at = collectedAt(m);
      const late = now() - at > Math.max(3 * m.every, 3_600_000);
      el.live.dataset.state = late ? 'off' : 'static';
      el.liveText.textContent = late ? `${rel(at)} 수집 뒤로 갱신이 없습니다` : `${everText()}마다 갱신, ${rel(at)} 수집`;
      return;
    }
    if (!state.connected) {
      el.live.dataset.state = state.everConnected ? 'off' : 'connecting';
      el.liveText.textContent = state.everConnected ? '연결이 끊겨 다시 붙는 중' : '서버에 연결하는 중';
      return;
    }
    el.live.dataset.state = 'on';
    el.liveText.textContent = st && st.fetchedAt ? `실시간 연결됨, ${rel(st.fetchedAt)} 확인` : '실시간 연결됨';
  }

  /** 정적 사이트의 수집 상태: 서버 한도 같은 것은 없고, 언제 만들어졌고 언제 다시 만들어지는지를 보여 준다. */
  function renderStaticStatus() {
    const st = currentStatus();
    const m = state.meta;
    const rows = [['마지막 수집', rel(collectedAt(m))]];
    rows.push([`이 ${S().bucket} 확인`, st && st.fetchedAt ? rel(st.fetchedAt) : '아직 없음']);
    if (st && st.dataAt) rows.push(['순위가 바뀐 때', rel(st.dataAt)]);
    rows.push(['다음 수집', until(nextAt(m))]);
    rows.push(['수집 방식', `GitHub Actions, ${everText()}마다`]);
    let have = 0;
    let all = 0;
    const sm = metaOf();
    for (const list of sm ? Object.values(sm.types) : []) {
      for (const b of list) {
        all += 1;
        if (b.hasData) have += 1;
      }
    }
    rows.push([`준비된 ${S().bucket}`, `${have} / ${all}`]);
    el.status.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    el.refreshBtn.parentElement.hidden = true; // 정적 사이트에는 수동 갱신이 없다
    renderLive();
  }

  function renderStatus() {
    if (!state.live && state.meta) return renderStaticStatus();
    const st = currentStatus();
    const c = collector();
    const rows = [];
    rows.push(['마지막 확인', st && st.fetchedAt ? rel(st.fetchedAt) : '아직 없음']);
    if (st && st.dataAt) rows.push(['순위가 바뀐 때', rel(st.dataAt)]);

    let next = `이 ${S().bucket}${state.src === 'as' ? '를' : '을'} 다시 열 때`;
    if (st) {
      if (st.state === 'running') next = '지금 받는 중';
      else if (c && c.pauseUntil && (st.state === 'queued' || (st.nextAt && st.nextAt <= c.pauseUntil))) {
        next = `한도가 풀리는 ${until(c.pauseUntil)}`;
      } else if (st.state === 'queued') next = '차례를 기다리는 중';
      else if (st.nextAt) next = until(st.nextAt);
    }
    rows.push(['다음 확인', next]);

    if (c && state.src !== 'gh') {
      // Hugging Face와 App Store는 하나씩 따로 받지 않고, 한 번 훑어 모든 기간(차트)을 함께 갱신한다.
      const left = c.rate.remaining === null || c.rate.remaining === undefined ? '' : ` 중 ${c.rate.remaining}회 남음`;
      if (c.running && c.progress) rows.push(['받는 중', `요청 ${c.progress.pages}번째`]);
      if (c.rate.limit) rows.push([`${S().name} 한도`, `${Math.round((c.rate.window || 300) / 60)}분에 ${c.rate.limit}회${left}`]);
      if (S().tab === 'hf') rows.push(['Hugging Face 인증', c.authenticated ? '토큰 사용' : '토큰 없음']);
      rows.push([`받아 둔 ${S().bucket}`, `${c.eager - c.missing} / ${c.eager}`]);
    } else if (c) {
      const left = c.rate.remaining === null || c.rate.remaining === undefined ? '' : ` 중 ${c.rate.remaining}회 남음`;
      rows.push(['GitHub 검색 한도', `분당 ${c.rate.limit}회${left}`]);
      rows.push(['GitHub 인증', c.authenticated ? '토큰 사용' : '토큰 없음']);
      rows.push(['미리 받아 둔 기간', `${c.eager - c.missing} / ${c.eager}`]);
    }
    el.status.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    el.refreshBtn.disabled = !st || st.state === 'running';
    renderLive();
  }

  function spamRuleText() {
    const rule = state.meta && state.meta.spam;
    if (!rule) return '스타에 비해 포크가 거의 없는 저장소를 스팸으로 의심합니다.';
    const pct = +(rule.maxForkRatio * 100).toFixed(2);
    return `스타가 ${fmt(rule.minStars)}개 이상인데 포크가 스타의 ${pct}%에 못 미치는 저장소입니다(${rule.since.slice(0, 4)}년 이후 생성). 스타를 사들인 저장소가 주로 걸리지만, 어림 규칙이라 틀릴 수 있습니다.`;
  }

  function renderSpam() {
    const n = spamCount();
    el.spamToggle.checked = state.hideSpam;
    el.spamCount.textContent = n ? fmt(n) : '';
    el.spamCount.hidden = !n;
    el.spamLabel.dataset.tip =
      `${spamRuleText()}
` +
      (state.hideSpam
        ? `숨긴 만큼 아래 순위를 더 받아 채웁니다${n ? `. 지금 ${fmt(n)}개를 건너뛰었습니다` : ''}.`
        : `지금 순위표에 ${fmt(n)}개가 섞여 있습니다.`);
  }

  function renderAll(opts = {}) {
    state.items = chartItems();
    renderSpam();
    renderNav();
    renderSub();
    renderLangs();
    renderBoard(opts);
    renderNotice();
    renderHist();
    renderStatus();
  }

  // ── 조작 ─────────────────────────────────────────────────────
  function setLang(lang) {
    state.lang = lang;
    if (state.view !== 'ready') return;
    renderLangs();
    renderBoard();
  }

  /** 다른 출처로 간다. 보던 종류·기간이 저쪽에도 있으면 그대로 가고, 없으면 저쪽의 기본 화면으로 간다. */
  function switchTo(to) {
    const m = metaOf(to);
    const [homeType, homeKey] = SOURCES[to].home;
    const type = SOURCES[to].types.some(([t]) => t === state.type) ? state.type : homeType;
    const same = type === state.type && m && (m.types[type] || []).some((d) => d.key === state.key);
    go(type, same ? state.key : homeKey, to);
  }
  el.sources.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-src]');
    if (!b || b.dataset.src === tabOf(state.src)) return;
    // 그 탭에 묶인 출처 가운데 이 사이트에 순위가 있는 첫 번째 것으로 간다(Hugging Face면 모델).
    switchTo(family(b.dataset.src).find((src) => metaOf(src)) || b.dataset.src);
  });
  el.subs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sub]');
    if (b && b.dataset.sub !== state.src) switchTo(b.dataset.sub);
  });
  el.types.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-type]');
    if (!b) return;
    // 기간 종류(주간·월간·연간)를 바꾸면 최근 구간으로 가고, 차트 종류(무료·유료·매출)를 바꾸면 보던 카테고리를 유지한다.
    go(b.dataset.type, state.src === 'as' ? state.key : S().home[1]);
  });
  el.age.addEventListener('change', () => {
    state.age = Number(el.age.value) || 0;
    if (state.view === 'ready') renderBoard();
  });
  el.period.addEventListener('change', () => go(state.type, el.period.value));
  el.prev.addEventListener('click', () => step(state.src === 'as' ? -1 : 1));
  el.next.addEventListener('click', () => step(state.src === 'as' ? 1 : -1));

  el.seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sort]');
    if (!b) return;
    state.sort = b.dataset.sort;
    for (const x of el.seg.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    if (state.view === 'ready') renderBoard();
  });
  function setHideSpam(on) {
    state.hideSpam = on;
    try {
      localStorage.setItem('hideSpam', on ? '1' : '0');
    } catch {
      /* 저장이 막혀 있어도 이번 화면에는 적용된다 */
    }
    renderAll();
  }
  el.spamToggle.addEventListener('change', () => setHideSpam(el.spamToggle.checked));
  el.lang.addEventListener('change', () => setLang(el.lang.value));
  el.search.addEventListener('input', () => {
    state.q = el.search.value.trim();
    if (state.view === 'ready') renderBoard();
  });
  el.langs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lang]');
    if (b) setLang(b.dataset.lang === state.lang ? '' : b.dataset.lang);
  });
  el.empty.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b) return;
    if (b.dataset.action === 'home') {
      const src = metaOf() ? state.src : 'gh'; // 이 사이트에 없는 출처였다면 GitHub으로
      go(SOURCES[src].home[0], SOURCES[src].home[1], src);
    }
    if (b.dataset.action === 'showspam') setHideSpam(false);
    if (b.dataset.action === 'clear') {
      state.q = '';
      el.search.value = '';
      state.age = 0;
      el.age.value = '';
      setLang('');
    }
  });

  let msgTimer = 0;
  el.refreshBtn.addEventListener('click', async () => {
    let text;
    try {
      const res = await fetch(`api/refresh?src=${state.src}&type=${state.type}&key=${encodeURIComponent(state.key)}`, { method: 'POST' });
      const body = await res.json();
      if (res.ok) text = '갱신을 요청했습니다';
      else if (body.reason === 'cooldown') {
        // 한 시간에 한 번까지만 다시 받는다(config.js의 collect.minGap).
        const sec = Math.ceil(body.retryInMs / 1000);
        text = sec > 90 ? `받은 지 한 시간이 안 됐습니다. ${Math.ceil(sec / 60)}분 뒤에 다시 받을 수 있습니다` : `방금 확인했습니다. ${sec}초 뒤에 다시 누를 수 있습니다`;
      }
      else text = '지금은 갱신할 수 없습니다';
    } catch {
      text = '서버에 연결하지 못했습니다';
    }
    el.refreshMsg.textContent = text;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => (el.refreshMsg.textContent = ''), 5000);
  });

  el.themeBtn.addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try {
      localStorage.setItem('theme', root.dataset.theme);
    } catch {
      /* 저장이 막혀 있어도 이번 화면에는 적용된다 */
    }
  });

  // 말풍선: data-tip이 달린 요소 위에 올리거나 초점을 주면 뜬다.
  function showTip(target, x, y) {
    el.tip.textContent = target.dataset.tip;
    el.tip.hidden = false;
    const box = el.tip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - box.width - 8, Math.max(8, x + 12));
    const top = y + 16 + box.height > window.innerHeight ? y - box.height - 10 : y + 16;
    el.tip.style.left = `${left}px`;
    el.tip.style.top = `${Math.max(8, top)}px`;
  }
  document.addEventListener('pointermove', (e) => {
    const target = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (target) showTip(target, e.clientX, e.clientY);
    else el.tip.hidden = true;
  });
  document.documentElement.addEventListener('pointerleave', () => (el.tip.hidden = true));
  document.addEventListener('focusin', (e) => {
    const target = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!target) return;
    const box = target.getBoundingClientRect();
    showTip(target, box.left + box.width / 2, box.bottom - 8);
  });
  document.addEventListener('focusout', () => (el.tip.hidden = true));
  window.addEventListener('scroll', () => (el.tip.hidden = true), { passive: true });

  let histFrame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(histFrame);
    histFrame = requestAnimationFrame(renderHist);
  }).observe(el.hist);

  window.addEventListener('hashchange', () => {
    const before = state.src;
    readHash();
    if (state.src !== before) {
      // 출처가 바뀌면 낱말(스타/좋아요, 언어/작업)이 달라지므로, 이전 출처의 순위를 새 머리글 아래에 남겨 두지 않는다.
      state.lang = '';
      state.age = 0;
      state.view = 'loading';
      state.data = null;
      state.dataId = '';
      applySource();
      renderAll();
    }
    renderNav();
    renderSub();
    loadChart();
  });

  // 1초마다 "N초 전", 남은 시간 같은 상대 시각만 새로 쓴다.
  let metaCheckAt = 0;
  setInterval(() => {
    renderStatus();
    if (el.notice.hidden === false) renderNotice();
    // 화면을 켜 둔 채 날짜(UTC)가 넘어가면 기간 목록을 새로 받는다(새 주·새 달이 생긴다).
    // (정적 사이트는 poll이 새 판을 받아 오면서 목록도 함께 바뀐다.)
    if (state.live && state.meta && Math.floor(now() / DAY) !== state.metaDay && Date.now() - metaCheckAt > 30_000) {
      metaCheckAt = Date.now();
      fetchMeta().then(applyMeta, () => {});
    }
  }, 1000);

  // ── 시작 ─────────────────────────────────────────────────────
  try {
    state.hideSpam = localStorage.getItem('hideSpam') !== '0';
  } catch {
    /* 저장소를 못 읽으면 기본값(숨김)으로 둔다 */
  }
  readHash();
  applySource();
  renderAll();

  // 기간 목록을 먼저 받아 어느 방식인지 안 다음, 실시간 연결을 맺거나(서버) 주기적으로 확인한다(정적 사이트).
  function boot() {
    fetchMeta().then(
      (meta) => {
        applyMeta(meta);
        loadChart();
        if (state.live) {
          connect();
        } else {
          setInterval(poll, POLL_GAP);
          document.addEventListener('visibilitychange', poll); // 탭으로 돌아왔을 때도 (때가 됐으면) 확인한다
        }
      },
      () => {
        state.view = 'offline';
        renderAll();
        setTimeout(boot, 5000);
      },
    );
  }
  boot();
})();
