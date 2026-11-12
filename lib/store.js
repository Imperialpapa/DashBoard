'use strict';

// 메모리 캐시 + 디스크 영속화.
// 요청 경로에서는 GitHub를 부르지 않는다. 여기 들어 있는, 미리 직렬화·압축해 둔 응답만 내보낸다.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { rankAll, countSkipped } = require('./spam');

// 캐시 파일 형식 번호. 2부터 항목마다 스팸 의심 표시(spam)와 스팸을 뺀 순위(crank)가 들어간다.
const SCHEMA = 2;
const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');

class Store {
  constructor(cfg) {
    this.cfg = cfg;
    this.dir = path.join(cfg.dataDir, 'cache');
    this.buckets = new Map();
  }

  static id(type, key) {
    return `${type}/${key}`;
  }

  file(type, key) {
    return path.join(this.dir, `${type}.${key}.json`);
  }

  /** 시작할 때 디스크 캐시를 읽어 들여, 재시작 직후에도 바로 화면을 채운다. */
  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const b = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        if (!b || !b.type || !b.key || !Array.isArray(b.items)) continue;
        b.history = Array.isArray(b.history) ? b.history : [];
        if (b.schema !== SCHEMA) this.upgrade(b);
        this.render(b);
        this.buckets.set(Store.id(b.type, b.key), b);
      } catch {
        // 깨진 캐시 파일은 버린다. 수집기가 다시 받아 온다.
      }
    }
    return this.buckets.size;
  }

  get(type, key) {
    return this.buckets.get(Store.id(type, key));
  }

  /**
   * 예전 형식의 캐시를 지금 형식으로 맞춘다. 가진 항목에 스팸 의심 표시만 새로 매기고,
   * 스팸을 빼면 순위표가 모자란 기간은 "받다 만 것"으로 표시해 수집기가 다음 쪽을 이어 받게 한다.
   */
  upgrade(b) {
    const { top, perPage, spam } = this.cfg;
    b.skipped = countSkipped(b.items, spam, top);
    b.items = rankAll(b.items, spam, top).map((r) => ({ ...r, cmove: null }));
    b.partial = b.items.length >= perPage && b.items.filter((r) => !r.spam).length < top;
    b.schema = SCHEMA;
    b.version = (b.version || 0) + 1; // 내용이 달라졌으니 브라우저 캐시(ETag)도 새로 받게 한다
    b.sig = sha1(`upgrade:${b.sig || ''}`);
  }

  /**
   * 새로 받아 온 결과를 반영한다.
   * partial이면 첫 쪽만 받은 중간 결과다: 화면에는 보여 주되 비교 기준 스냅샷으로는 남기지 않는다.
   * @returns {{bucket: object, changed: boolean}} changed는 화면에 보이는 내용이 달라졌는지
   */
  update(desc, result, now, { partial = false } = {}) {
    const { history: H, top, spam } = this.cfg;
    const id = Store.id(desc.type, desc.key);
    const b = this.buckets.get(id) || { type: desc.type, key: desc.key, version: 0, history: [], items: [] };

    const ranked = rankAll(result.items, spam, top);
    const skipped = countSkipped(result.items, spam, top);

    // 스냅샷 이력: spacing 간격으로 한 점씩, window 안의 것만 보관한다. 항목마다 [스타, 순위, 스팸을 뺀 순위].
    const hist = b.history;
    const last = hist[hist.length - 1];
    if (!partial && (!last || now - last.t >= H.spacing)) {
      hist.push({ t: now, c: 1, s: Object.fromEntries(ranked.map((r) => [r.id, [r.stars, r.rank, r.crank || 0]])) });
    }
    while (hist.length > 1 && (now - hist[0].t > H.window || hist.length > H.max)) hist.shift();

    // 기준점: 보관 중인 가장 오래된 스냅샷(너무 최근 것이면 비교하지 않는다).
    // 그때 순위표(top) 밖에 있었거나 아예 없던 저장소는 새로 진입한 것으로 본다.
    // 예전 형식 스냅샷(c 없음)만 남아 있을 때가 아니면, 스팸을 뺀 순위까지 들어 있는 스냅샷을 쓴다.
    const usable = (p) => now - p.t >= H.minSpan && now - p.t <= H.window;
    const base = hist.find((p) => p.c && usable(p)) || hist.find(usable);
    const items = ranked.map((r) => {
      if (!base) return { ...r, gain: null, move: null, cmove: null };
      const prev = base.s[r.id];
      const was = (rank) => (rank && rank <= top ? rank : 0);
      let cmove = null; // 스팸을 뺀 순위의 변동. 예전 형식 스냅샷(c 없음)에는 비교할 순위가 없다.
      if (r.crank !== null && base.c) cmove = prev && was(prev[2]) ? prev[2] - r.crank : 'new';
      return {
        ...r,
        gain: prev ? r.stars - prev[0] : null,
        move: prev && was(prev[1]) ? prev[1] - r.rank : 'new',
        cmove,
      };
    });

    // cut: 이 수보다 적은 것은 아직 훑지 못했다는 표시(Hugging Face 수집기만 쓴다. 없으면 서명에 넣지 않아 기존 서명이 유지된다).
    const cut = result.cut || 0;
    const sig = sha1(JSON.stringify([items, result.total, result.approx, result.incomplete, desc.from, desc.to, partial, skipped, ...(cut ? [cut] : [])]));
    const changed = sig !== b.sig;

    Object.assign(b, {
      schema: SCHEMA,
      from: desc.from,
      to: desc.to,
      query: result.query,
      total: result.total,
      totalAt: result.totalAt,
      approx: Boolean(result.approx),
      incomplete: Boolean(result.incomplete),
      floor: result.floor || 0,
      cut,
      pages: result.pages || 1,
      partial,
      skipped,
      span: base ? now - base.t : null,
      items,
      fetchedAt: now,
    });
    if (changed) {
      b.sig = sig;
      b.version += 1;
      b.dataAt = now;
      this.render(b);
    }

    this.buckets.set(id, b);
    this.persist(b);
    return { bucket: b, changed };
  }

  /** 클라이언트에 줄 본문을 미리 만들어 둔다(직렬화 + gzip + ETag). */
  render(b) {
    const payload = {
      type: b.type,
      key: b.key,
      from: b.from,
      to: b.to,
      query: b.query,
      version: b.version,
      dataAt: b.dataAt,
      total: b.total,
      approx: b.approx,
      incomplete: b.incomplete,
      partial: Boolean(b.partial),
      skipped: b.skipped || 0, // 스팸을 뺀 순위표를 채우느라 건너뛴 스팸 의심 개수
      top: this.cfg.top,
      span: b.span,
      ...(b.cut ? { cut: b.cut } : {}),
      items: b.items,
    };
    b.body = Buffer.from(JSON.stringify(payload));
    b.gz = zlib.gzipSync(b.body);
    b.etag = `"${b.version}-${(b.sig || '').slice(0, 10)}"`;
  }

  /** 임시 파일에 쓴 뒤 이름을 바꿔, 쓰는 도중 꺼져도 캐시가 깨지지 않게 한다. */
  persist(b) {
    const { body, gz, etag, ...plain } = b;
    const file = this.file(b.type, b.key);
    const tmp = `${file}.tmp`;
    const text = JSON.stringify(plain);
    try {
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.writeFileSync(file, text); // 백신 등이 파일을 잡고 있어 rename이 막힌 경우
        fs.rmSync(tmp, { force: true });
      } catch (err) {
        console.warn(`[store] ${path.basename(file)} 저장 실패: ${err.message}`);
      }
    }
  }
}

module.exports = { Store };
