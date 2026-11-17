/* 소설 작업실 — core.js
 * AI 없이 동작하는 순수 로직: 글자 수, 원고지 환산, 단락 ID 보존, 버전 비교,
 * 문체 통계, 찾기·바꾸기, 텍스트 정리, 장 나누기, 내보내기 텍스트, 백업 검증.
 * 브라우저(window.NSCore)와 Node(module.exports) 양쪽에서 쓴다. */
(function (root, factory) {
  const m = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = m;
  else root.NSCore = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ───────────── 기본 유틸 ───────────── */
  let _seq = 0;
  function uid(prefix) {
    let r = '';
    try {
      const a = new Uint32Array(2);
      (globalThis.crypto || require('crypto').webcrypto).getRandomValues(a);
      r = a[0].toString(36) + a[1].toString(36);
    } catch (e) {
      r = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    _seq = (_seq + 1) % 1679616;
    return (prefix || 'id') + '_' + r.slice(0, 10) + _seq.toString(36);
  }
  const nowIso = () => new Date().toISOString();
  const splitLines = (t) => String(t == null ? '' : t).replace(/\r\n?/g, '\n').split('\n');
  const cpLen = (s) => { let n = 0; for (const _ of s) n++; return n; };
  const WS_RE = /[\s​-‍⁠﻿]/g;

  /* ───────────── 글자 수 ───────────── */
  // 공백 포함: 줄바꿈 문자를 제외한 모든 문자(코드포인트 단위, 이모지 1자)
  function countWithSpaces(text) { return cpLen(String(text || '').replace(/[\r\n]/g, '')); }
  // 공백 제외: 공백·탭·전각공백·줄바꿈·폭 없는 공백을 제외
  function countNoSpaces(text) { return cpLen(String(text || '').replace(WS_RE, '')); }

  const DEFAULT_SHEET = { cellsPerLine: 20, linesPerSheet: 10, mode: 'simple', basis: 'with', indent: true };
  function sheetSettings(s) {
    const o = Object.assign({}, DEFAULT_SHEET, s || {});
    o.cellsPerLine = Math.max(2, Math.floor(o.cellsPerLine) || 20);
    o.linesPerSheet = Math.max(1, Math.floor(o.linesPerSheet) || 10);
    return o;
  }
  const round1 = (x) => Math.round(x * 10) / 10;
  // 단순 환산: 글자 수 ÷ (한 줄 칸 수 × 한 면 줄 수)
  function simpleSheets(chars, s) {
    const o = sheetSettings(s);
    return round1(chars / (o.cellsPerLine * o.linesPerSheet));
  }

  // 원고지 모사: 문단마다 줄을 바꾸고 첫 칸을 비우며, 줄 끝 띄어쓰기는 생략하고,
  // 줄 첫 칸에 오면 안 되는 문장부호는 앞줄 마지막 칸에 붙이고, 숫자·영소문자는 한 칸에 두 자.
  const NO_LINE_START = new Set('.,!?:;)]}”’"\'…·」』》〉'.split(''));
  function gridSheets(text, s) {
    const o = sheetSettings(s);
    const cpl = o.cellsPerLine;
    let lines = 0, col = 0, cells = 0, pendingHalf = false;
    for (const rawPara of splitLines(text)) {
      const para = rawPara.replace(/^[\s​-‍⁠﻿]+/, '').replace(/[\s​-‍⁠﻿]+$/, '');
      if (!para) continue;
      lines++; col = 0; pendingHalf = false;
      if (o.indent) { col = 1; cells++; }
      for (const ch of para) {
        const isSpace = /\s/.test(ch);
        const half = /[0-9a-z]/.test(ch);
        if (half && pendingHalf) { pendingHalf = false; continue; }
        if (col >= cpl) {
          if (isSpace) { pendingHalf = false; continue; }
          if (NO_LINE_START.has(ch)) { pendingHalf = false; continue; }
          lines++; col = 0;
        }
        if (col === 0 && isSpace) { pendingHalf = false; continue; }
        col++; cells++;
        pendingHalf = half;
      }
    }
    const per = o.linesPerSheet;
    return { lines, cells, sheets: round1(lines / per), sheetsCeil: Math.ceil(lines / per) };
  }

  function countText(text, settings) {
    const o = sheetSettings(settings);
    const withSp = countWithSpaces(text), noSp = countNoSpaces(text);
    const size = o.cellsPerLine * o.linesPerSheet;
    const simple = { withSpaces: round1(withSp / size), noSpaces: round1(noSp / size) };
    const grid = gridSheets(text, o);
    const chosen = o.mode === 'grid' ? grid.sheets : (o.basis === 'without' ? simple.noSpaces : simple.withSpaces);
    return { withSpaces: withSp, noSpaces: noSp, simple, grid, sheets: chosen, sheetLabel: sheetLabel(o) };
  }
  // 장별 계산 결과를 합산한다(글자 수와 원고지 모사 줄 수는 장 단위로 더해도 전체와 같다).
  function aggregateCounts(list, settings) {
    const o = sheetSettings(settings), size = o.cellsPerLine * o.linesPerSheet;
    let w = 0, n = 0, lines = 0, cells = 0;
    list.forEach((c) => { w += c.withSpaces; n += c.noSpaces; lines += c.grid.lines; cells += c.grid.cells; });
    const simple = { withSpaces: round1(w / size), noSpaces: round1(n / size) };
    const grid = { lines, cells, sheets: round1(lines / o.linesPerSheet), sheetsCeil: Math.ceil(lines / o.linesPerSheet) };
    const sheets = o.mode === 'grid' ? grid.sheets : (o.basis === 'without' ? simple.noSpaces : simple.withSpaces);
    return { withSpaces: w, noSpaces: n, simple, grid, sheets, sheetLabel: sheetLabel(o) };
  }
  function sheetLabel(s) {
    const o = sheetSettings(s);
    const size = `${o.cellsPerLine}자×${o.linesPerSheet}줄`;
    if (o.mode === 'grid') return `원고지 모사(${size}, 문단 첫 칸 ${o.indent ? '비움' : '안 비움'})`;
    return `단순 환산(${o.basis === 'without' ? '공백 제외' : '공백 포함'} 글자 수 ÷ ${o.cellsPerLine * o.linesPerSheet})`;
  }

  /* ───────────── 원고 모델 ───────────── */
  function newParagraph(text, source) {
    return { id: uid('p'), text: String(text == null ? '' : text), locked: false, memo: '', source: source || 'author' };
  }
  function newChapter(title, text) {
    return { id: uid('c'), title: title || '', paragraphs: splitLines(text == null ? '' : text).map((l) => newParagraph(l)) };
  }
  const chapterText = (ch) => ch.paragraphs.map((p) => p.text).join('\n');
  const versionText = (ver) => ver.chapters.map(chapterText).join('\n');
  const SCENE_RE = /^\s*(\*\s*\*\s*\*|\*{3,}|◇+|◆+|[-─—]{3,})\s*$/;
  const isSceneBreak = (t) => SCENE_RE.test(t) && t.trim() !== '';

  // 편집한 텍스트를 기존 단락에 대응시켜 단락 ID를 보존한다.
  function reconcileParagraphs(oldParas, newText) {
    const L = splitLines(newText);
    const O = oldParas;
    const pairs = lcsPairs(O, L, (x) => (typeof x === 'string' ? x : x.text));
    const out = [];
    let gi = 0, gj = 0;
    const pairGap = (i, j) => {
      const gO = O.slice(gi, i), gL = L.slice(gj, j);
      const n = Math.min(gO.length, gL.length);
      for (let k = 0; k < n; k++) out.push(Object.assign({}, gO[k], { text: gL[k] }));
      for (let k = n; k < gL.length; k++) out.push(newParagraph(gL[k]));
    };
    for (const [i, j] of pairs) { pairGap(i, j); out.push(O[i]); gi = i + 1; gj = j + 1; }
    pairGap(O.length, L.length);
    return out;
  }

  /* ───────────── 버전 ───────────── */
  function makeVersion(o) {
    return {
      id: o.id || uid('v'), workId: o.workId, parentId: o.parentId || null,
      label: o.label || '작업본', kind: o.kind || '작업본', note: o.note || '',
      createdAt: nowIso(), updatedAt: nowIso(), frozen: !!o.frozen,
      chapters: o.chapters || [],
    };
  }
  const cloneChapters = (chapters) => JSON.parse(JSON.stringify(chapters));
  const flattenParas = (ver) => {
    const out = [];
    ver.chapters.forEach((ch, ci) => ch.paragraphs.forEach((p, pi) => out.push({ id: p.id, text: p.text, locked: p.locked, chapterId: ch.id, chapterTitle: ch.title, chapterIndex: ci, paraIndex: pi })));
    return out;
  };

  /* ───────────── 비교 ───────────── */
  const DP_LIMIT = 6000000;
  // 두 시퀀스의 공통 부분 대응쌍을 순서대로 돌려준다. 접두·접미 제거 → 작으면 LCS → 크면 patience(유일 일치 앵커).
  function lcsPairs(A, B, key) {
    const KA = A.map(key), KB = B.map(key);
    const out = [];
    (function align(aLo, aHi, bLo, bHi) {
      while (aLo < aHi && bLo < bHi && KA[aLo] === KB[bLo]) { out.push([aLo, bLo]); aLo++; bLo++; }
      const tail = [];
      while (aLo < aHi && bLo < bHi && KA[aHi - 1] === KB[bHi - 1]) { aHi--; bHi--; tail.push([aHi, bHi]); }
      const n = aHi - aLo, m = bHi - bLo;
      if (n > 0 && m > 0) {
        if (n * m <= DP_LIMIT) {
          const W = m + 1, dp = new Uint32Array((n + 1) * W);
          for (let i = n - 1; i >= 0; i--)
            for (let j = m - 1; j >= 0; j--)
              dp[i * W + j] = KA[aLo + i] === KB[bLo + j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
          let i = 0, j = 0;
          while (i < n && j < m) {
            if (KA[aLo + i] === KB[bLo + j]) { out.push([aLo + i, bLo + j]); i++; j++; }
            else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
            else j++;
          }
        } else {
          const ca = new Map(), cb = new Map();
          for (let i = aLo; i < aHi; i++) ca.set(KA[i], ca.has(KA[i]) ? -1 : i);
          for (let j = bLo; j < bHi; j++) cb.set(KB[j], cb.has(KB[j]) ? -1 : j);
          const cand = [];
          ca.forEach((i, k) => { if (i >= 0 && cb.has(k) && cb.get(k) >= 0) cand.push([i, cb.get(k)]); });
          cand.sort((x, y) => x[0] - y[0]);
          // 최장 증가 부분수열(두 번째 좌표 기준)
          const tails = [], prev = new Array(cand.length).fill(-1), idxs = [];
          cand.forEach((c, i) => {
            let lo = 0, hi = tails.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (cand[tails[mid]][1] < c[1]) lo = mid + 1; else hi = mid; }
            if (lo > 0) prev[i] = tails[lo - 1];
            tails[lo] = i; idxs[lo] = i;
          });
          const anchors = [];
          for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) anchors.push(cand[k]);
          anchors.reverse();
          let pa = aLo, pb = bLo;
          for (const [ai, bi] of anchors) { align(pa, ai, pb, bi); out.push([ai, bi]); pa = ai + 1; pb = bi + 1; }
          if (anchors.length) align(pa, aHi, pb, bHi);
        }
      }
      for (let k = tail.length - 1; k >= 0; k--) out.push(tail[k]);
    })(0, A.length, 0, B.length);
    return out;
  }

  function diffVersions(verA, verB) {
    const A = flattenParas(verA), B = flattenParas(verB);
    let pairs = lcsPairs(A, B, (p) => p.id);
    let byText = false;
    const minLen = Math.min(A.length, B.length);
    if (minLen > 0 && pairs.length < minLen * 0.2) { pairs = lcsPairs(A, B, (p) => p.text); byText = true; }
    const rows = [];
    let i = 0, j = 0;
    const push = (type, a, b) => rows.push({ type, a, b });
    for (const [pi, pj] of pairs.concat([[A.length, B.length]])) {
      while (i < pi) push('del', A[i++], null);
      while (j < pj) push('add', null, B[j++]);
      if (pi < A.length && pj < B.length) {
        push(A[pi].text === B[pj].text ? 'same' : 'mod', A[pi], B[pj]);
        i = pi + 1; j = pj + 1;
      }
    }
    const sum = { same: 0, mod: 0, add: 0, del: 0 };
    rows.forEach((r) => sum[r.type]++);
    return { rows, summary: sum, byText };
  }

  function tokenize(s) { return s.match(/\s+|[^\s]+/g) || []; }
  function inlineDiff(aText, bText) {
    const A = tokenize(aText), B = tokenize(bText);
    const pairs = lcsPairs(A, B, (x) => x);
    const segs = [];
    const add = (t, s) => { if (!s) return; const l = segs[segs.length - 1]; if (l && l.t === t) l.s += s; else segs.push({ t, s }); };
    let i = 0, j = 0;
    for (const [pi, pj] of pairs.concat([[A.length, B.length]])) {
      const dels = A.slice(i, pi), inss = B.slice(j, pj);
      if (dels.length === 1 && inss.length === 1) {
        const x = dels[0], y = inss[0];
        let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
        let q = 0; while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
        add('eq', x.slice(0, p)); add('del', x.slice(p, x.length - q)); add('ins', y.slice(p, y.length - q)); add('eq', x.slice(x.length - q));
      } else { add('del', dels.join('')); add('ins', inss.join('')); }
      if (pi < A.length) { add('eq', A[pi]); }
      i = pi + 1; j = pj + 1;
    }
    return segs;
  }

  /* ───────────── 찾기·바꾸기 ───────────── */
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function findAll(ver, query, opts) {
    opts = opts || {};
    if (!query) return [];
    const re = new RegExp(escapeRe(query), opts.caseSensitive ? 'g' : 'gi');
    const out = [];
    for (let ci = 0; ci < ver.chapters.length; ci++) {
      const ch = ver.chapters[ci];
      for (let pi = 0; pi < ch.paragraphs.length; pi++) {
        const p = ch.paragraphs[pi];
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(p.text))) {
          out.push({
            chapterId: ch.id, chapterIndex: ci, paraId: p.id, paraIndex: pi, start: m.index, end: m.index + m[0].length,
            before: p.text.slice(Math.max(0, m.index - 14), m.index), hit: m[0], after: p.text.slice(m.index + m[0].length, m.index + m[0].length + 14), locked: p.locked,
          });
          if (out.length >= 3000) return out;
          if (m[0].length === 0) re.lastIndex++;
        }
      }
    }
    return out;
  }
  // 선택한 일치만 바꾼다. 같은 단락 안에서는 뒤에서부터 적용해 위치가 어긋나지 않게 한다.
  function replaceMatches(ver, matches, replacement) {
    const byPara = new Map();
    matches.forEach((m) => { if (!byPara.has(m.paraId)) byPara.set(m.paraId, []); byPara.get(m.paraId).push(m); });
    let n = 0;
    for (const ch of ver.chapters) for (const p of ch.paragraphs) {
      const ms = byPara.get(p.id);
      if (!ms) continue;
      ms.sort((x, y) => y.start - x.start);
      for (const m of ms) { p.text = p.text.slice(0, m.start) + replacement + p.text.slice(m.end); n++; }
    }
    return n;
  }

  /* ───────────── 가져오기 정리 ───────────── */
  const SPECIAL_SPACES = /[   -   　]/g;
  const ZERO_WIDTH = /[​-‍⁠﻿]/g;
  function cleanText(text, o) {
    o = Object.assign({ nfc: true, specialSpaces: true, quotes: 'keep', ellipsis: 'keep', blankLines: 'keep', trailing: true }, o || {});
    const rep = {};
    const count = (k, n) => { if (n) rep[k] = (rep[k] || 0) + n; };
    let t = String(text || '');
    const before = t;
    t = t.replace(/\r\n?/g, '\n');
    if (o.nfc) { const n = t.normalize('NFC'); if (n !== t) count('NFC 정규화(자모 결합)', 1); t = n; }
    if (o.specialSpaces) {
      t = t.replace(SPECIAL_SPACES, () => { count('특수 공백→일반 공백', 1); return ' '; });
      t = t.replace(ZERO_WIDTH, () => { count('폭 없는 문자 제거', 1); return ''; });
    }
    if (o.quotes === 'curly') {
      const conv = (open, close) => (m, off, str) => {
        const prev = off ? str[off - 1] : '';
        count('따옴표 통일', 1);
        return !prev || /[\s(\[{—-]/.test(prev) ? open : close;
      };
      t = t.replace(/"/g, conv('“', '”')).replace(/'/g, conv('‘', '’'));
    } else if (o.quotes === 'straight') {
      t = t.replace(/[“”]/g, () => { count('따옴표 통일', 1); return '"'; }).replace(/[‘’]/g, () => { count('따옴표 통일', 1); return "'"; });
    }
    if (o.ellipsis === 'char') t = t.replace(/\.{3,}/g, () => { count('말줄임표 통일', 1); return '…'; });
    else if (o.ellipsis === 'dots') t = t.replace(/…/g, () => { count('말줄임표 통일', 1); return '...'; });
    if (o.trailing) t = t.replace(/[ \t]+$/gm, (m) => { count('줄 끝 공백 제거', 1); return ''; });
    if (o.blankLines === 'collapse') t = t.replace(/\n{3,}/g, () => { count('빈 줄 정리', 1); return '\n\n'; });
    else if (o.blankLines === 'remove') t = t.replace(/\n{2,}/g, () => { count('빈 줄 정리', 1); return '\n'; });
    return { text: t, changed: t !== before, report: rep };
  }

  /* ───────────── 장 나누기(가져오기) ───────────── */
  const HEAD_RES = [/^#{1,3}\s+(.+?)\s*#*\s*$/, /^(제\s*\d+\s*[장화부편].*)$/, /^((?:chapter|CHAPTER|Chapter)\s*\d+.*)$/, /^((?:프롤로그|에필로그|서장|종장|서막|후기)\s*.*)$/];
  function headingOf(line) {
    const t = line.trim();
    if (!t || t.length > 60) return null;
    for (const re of HEAD_RES) { const m = re.exec(t); if (m) return m[1].trim(); }
    return null;
  }
  // paras: [{text, heading?:bool}] 또는 문자열 줄 배열
  function splitChapters(lines, opts) {
    opts = opts || {};
    const items = lines.map((l) => (typeof l === 'string' ? { text: l } : l));
    const chapters = [];
    let cur = null;
    const startCh = (title) => { cur = { title, lines: [] }; chapters.push(cur); };
    for (const it of items) {
      const h = it.heading ? it.text.trim() : (opts.detect === false ? null : headingOf(it.text));
      if (h) { startCh(h); continue; }
      if (!cur) startCh(opts.firstTitle || '본문');
      cur.lines.push(it.text);
    }
    if (!chapters.length) chapters.push({ title: opts.firstTitle || '본문', lines: [] });
    // 장 앞뒤의 불필요한 빈 줄 제거
    chapters.forEach((c) => { while (c.lines.length && !c.lines[0].trim()) c.lines.shift(); while (c.lines.length && !c.lines[c.lines.length - 1].trim()) c.lines.pop(); });
    return chapters.map((c) => ({ title: c.title, text: c.lines.join('\n') }));
  }

  /* ───────────── 내보내기 텍스트 ───────────── */
  function toTxt(ver, o) {
    o = Object.assign({ workTitle: '', chapterTitles: true }, o || {});
    const parts = [];
    if (o.workTitle) parts.push(o.workTitle, '');
    ver.chapters.forEach((ch, i) => {
      if (o.chapterTitles && ch.title) parts.push(ch.title, '');
      parts.push(chapterText(ch));
      if (i < ver.chapters.length - 1) parts.push('');
    });
    return parts.join('\n').replace(/\n+$/, '') + '\n';
  }
  function toMarkdown(ver, o) {
    o = Object.assign({ workTitle: '' }, o || {});
    const parts = [];
    if (o.workTitle) parts.push('# ' + o.workTitle);
    for (const ch of ver.chapters) {
      if (ch.title) parts.push('## ' + ch.title);
      const body = ch.paragraphs.filter((p) => p.text.trim() !== '').map((p) => (isSceneBreak(p.text) ? '***' : p.text));
      parts.push(body.join('\n\n'));
    }
    return parts.join('\n\n') + '\n';
  }

  /* ───────────── 신상 정보 점검(응모용) ───────────── */
  function privacyScan(ver, names) {
    const rules = [
      ['휴대전화 번호', /01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/g],
      ['전화번호', /\b0(?:2|[3-6]\d|70|80)[-.\s]\d{3,4}[-.\s]\d{4}\b/g],
      ['이메일', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
      ['주민등록번호 형태', /\b\d{6}[-\s]?[1-4]\d{6}\b/g],
      ['주소 형태', /[가-힣]+(?:시|도)\s*[가-힣]+(?:구|군|시)\s*[가-힣0-9]+(?:로|길|동)\s*\d+/g],
    ];
    (names || []).filter(Boolean).forEach((n) => rules.push(['등록한 이름 "' + n + '"', new RegExp(escapeRe(n), 'g')]));
    const out = [];
    ver.chapters.forEach((ch, ci) => ch.paragraphs.forEach((p, pi) => {
      for (const [label, re] of rules) { re.lastIndex = 0; let m; while ((m = re.exec(p.text))) { out.push({ label, hit: m[0], chapterIndex: ci, chapterTitle: ch.title, paraIndex: pi }); if (m[0].length === 0) re.lastIndex++; } }
    }));
    return out;
  }

  /* ───────────── 문체 통계 (로컬 계산, 형태소 분석이 아닌 근사치) ───────────── */
  const SENT_RE = /[^.!?…。\n]+(?:[.!?…。]+["”’'」』)\]]*)?/g;
  function sentencesOf(text) {
    const out = [];
    for (const m of String(text).matchAll(SENT_RE)) {
      const s = m[0].trim();
      if (/[가-힣A-Za-z0-9]/.test(s)) out.push(s);
    }
    return out;
  }
  const JOSA = ['에게서', '으로서', '으로써', '에서는', '까지는', '이라고', '에게는', '에게', '에서', '으로', '까지', '부터', '처럼', '보다', '마다', '이나', '이며', '이고', '한테', '께서', '라고', '은', '는', '이', '가', '을', '를', '에', '의', '도', '로', '과', '와', '만', '나', '고', '며'];
  const STOP = new Set('그리고 하지만 그러나 그래서 그런데 그러면 그러자 그것 이것 저것 그녀 우리 자신 아니 하나 어떤 어느 모든 다시 이미 아직 바로 조금 계속 같은 같이 하는 하고 하며 했다 한다 있는 있다 없는 없다 있었다 없었다 되어 되는 된다 이런 그런 저런 이렇게 그렇게 어떻게 무슨 정말 너무 아주 매우 오래 먼저 다음 지금 때문 사람 생각'.split(' '));
  function stem(w) {
    for (const j of JOSA) if (w.length - j.length >= 2 && w.endsWith(j)) return w.slice(0, -j.length);
    return w;
  }
  function wordsOf(text) {
    const out = [];
    for (const m of String(text).matchAll(/[가-힣]{2,}/g)) { const w = stem(m[0]); if (w.length >= 2 && !STOP.has(w)) out.push({ w, at: m.index }); }
    return out;
  }
  function dialogueChars(text) {
    let n = 0;
    for (const m of String(text).matchAll(/[“"]([^”"\n]*)[”"]/g)) n += countNoSpaces(m[1]);
    return n;
  }
  const isDialogueLine = (t) => /^\s*[“"‘'「『]/.test(t) && /[”"’'」』]\s*[.!?…]*\s*$/.test(t);

  function styleStats(ver, o) {
    o = Object.assign({ shortMax: 12, shortRun: 4, dialogRun: 6, dialogShort: 24, nearWindow: 300, nearMin: 3, custom: ['것이다', '마치', '처럼'], names: [] }, o || {});
    const buckets = [[1, 10], [11, 20], [21, 30], [31, 45], [46, 70], [71, Infinity]];
    const hist = buckets.map(([lo, hi]) => ({ lo, hi, n: 0 }));
    const lens = [], endings = new Map(), freq = new Map();
    const shortRuns = [], dialogRuns = [], near = [], custom = {};
    o.custom.forEach((c) => (custom[c] = { count: 0, where: [] }));
    let totalNoSp = 0, dialogNoSp = 0;
    const chapters = [];

    ver.chapters.forEach((ch, ci) => {
      const text = chapterText(ch);
      const nsp = countNoSpaces(text), dch = dialogueChars(text);
      totalNoSp += nsp; dialogNoSp += dch;
      const nameCounts = {};
      o.names.forEach((nm) => { nameCounts[nm] = nm ? text.split(nm).length - 1 : 0; });
      chapters.push({ index: ci, title: ch.title, noSpaces: nsp, dialogRatio: nsp ? dch / nsp : 0, nameCounts });

      let dRun = [];
      const flushD = () => { if (dRun.length >= o.dialogRun) dialogRuns.push({ chapterIndex: ci, chapterTitle: ch.title, paraIndex: dRun[0].pi, count: dRun.length, sample: dRun[0].t.slice(0, 40) }); dRun = []; };
      // 근접 반복용: 장 전체에서 단어 위치를 단락 인덱스로 환산
      const offs = []; let acc = 0;
      ch.paragraphs.forEach((p) => { offs.push(acc); acc += p.text.length + 1; });
      const paraAt = (pos) => { let lo = 0, hi = offs.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offs[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };

      ch.paragraphs.forEach((p, pi) => {
        const t = p.text;
        if (!t.trim()) return;
        if (isDialogueLine(t) && countNoSpaces(t) <= o.dialogShort) dRun.push({ pi, t }); else flushD();
        const sents = sentencesOf(t);
        let run = [];
        const flushS = () => { if (run.length >= o.shortRun) shortRuns.push({ chapterIndex: ci, chapterTitle: ch.title, paraIndex: pi, count: run.length, sample: run.slice(0, 3).join(' ') }); run = []; };
        sents.forEach((s) => {
          const L = countNoSpaces(s);
          lens.push(L);
          const b = hist.find((h) => L >= h.lo && L <= h.hi); if (b) b.n++;
          if (L <= o.shortMax) run.push(s); else flushS();
          const e = /([가-힣]{1,2})["”’'」』)\]]*[.!?…。]*$/.exec(s.replace(/\s+$/, ''));
          if (e && !isDialogueLine(s)) endings.set(e[1], (endings.get(e[1]) || 0) + 1);
        });
        flushS();
      });
      flushD();

      const ws = wordsOf(text);
      const posByWord = new Map();
      ws.forEach((x) => { freq.set(x.w, (freq.get(x.w) || 0) + 1); if (!posByWord.has(x.w)) posByWord.set(x.w, []); posByWord.get(x.w).push(x.at); });
      posByWord.forEach((arr, w) => {
        if (o.names.some((nm) => nm && (nm === w || nm.startsWith(w) || w.startsWith(nm)))) return; // 인물 이름은 자연스럽게 반복되므로 제외
        for (let i = 0; i + o.nearMin - 1 < arr.length; i++) {
          if (arr[i + o.nearMin - 1] - arr[i] <= o.nearWindow) {
            let k = i + o.nearMin - 1;
            while (k + 1 < arr.length && arr[k + 1] - arr[i] <= o.nearWindow) k++;
            near.push({ word: w, count: k - i + 1, chapterIndex: ci, chapterTitle: ch.title, paraIndex: paraAt(arr[i]) });
            i = k;
          }
        }
      });
      o.custom.forEach((c) => {
        if (!c) return;
        ch.paragraphs.forEach((p, pi) => { let from = 0, idx; while ((idx = p.text.indexOf(c, from)) !== -1) { custom[c].count++; if (custom[c].where.length < 30) custom[c].where.push({ chapterIndex: ci, chapterTitle: ch.title, paraIndex: pi }); from = idx + c.length; } });
      });
    });

    const sorted = lens.slice().sort((a, b) => a - b);
    const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    near.sort((a, b) => b.count - a.count);
    return {
      sentenceCount: lens.length,
      avgLen: lens.length ? round1(lens.reduce((a, b) => a + b, 0) / lens.length) : 0,
      medianLen: sorted.length ? sorted[sorted.length >> 1] : 0,
      hist, shortRuns, dialogRuns,
      dialogRatio: totalNoSp ? dialogNoSp / totalNoSp : 0,
      topWords: top(freq, 20), topEndings: top(endings, 10),
      nearRepeats: near.slice(0, 20), custom, chapters,
      note: '형태소 분석이 아닌 단순 규칙 기반 근사치입니다.',
    };
  }

  // 작가 본인 원고 샘플에서 문체 통계 지문을 만든다(로컬 계산, 특정 작가 모방용이 아니다).
  function styleFingerprint(text) {
    const paras = splitLines(text).filter((t) => t.trim());
    if (!paras.length) return { text: '', stats: null };
    const st = styleStats({ chapters: [{ title: '', paragraphs: paras.map((t) => ({ text: t })) }] }, { custom: [], names: [] });
    const avgPara = round1(paras.reduce((a, t) => a + countNoSpaces(t), 0) / paras.length);
    const ends = st.topEndings.slice(0, 5).map(([k]) => k).join('·');
    return { text: `문장 평균 ${st.avgLen}자(중앙값 ${st.medianLen}자), 대화 비율 ${(st.dialogRatio * 100).toFixed(0)}%, 문단 평균 ${avgPara}자` + (ends ? `, 자주 쓰는 문장 끝: ${ends}` : ''), stats: { avgLen: st.avgLen, medianLen: st.medianLen, dialogRatio: st.dialogRatio, avgPara, sentences: st.sentenceCount } };
  }

  /* ───────────── 제안(edits) 검증·적용: 모델은 old/new/why 만 내고, 코드가 검증한다 ───────────── */
  const hangulWords = (text) => { const set = new Set(); for (const m of String(text).matchAll(/[가-힣]{2,}/g)) set.add(m[0]); return set; };
  const manuscriptWordSet = (ver) => hangulWords(versionText(ver));
  const editKey = (old, nw) => old + '\u0001' + nw;
  const SIMILE = /처럼|같이|듯이|듯|마치/g;
  const countMatches = (s, re) => (String(s).match(re) || []).length;
  // 한 장(chapter) 안에서 제안을 검증한다. old 는 그 장 본문에 정확히 한 번만 나와야 한다.
  function verifyEdits(edits, chapter, o) {
    o = Object.assign({ pass: '', maxEdits: 8, rejectedKeys: new Set(), shorten: false, maxGrow: 1.5, words: null, noveltyCheck: true }, o || {});
    const ok = [], rejected = [], taken = [];
    const reject = (e, reason) => rejected.push({ edit: e, reason });
    for (const e of edits) {
      const old = String(e.old == null ? '' : e.old), nw = String(e.new == null ? '' : e.new);
      if (!old) { reject(e, '원문 없음'); continue; }
      if (old === nw) { reject(e, '바뀐 것이 없음'); continue; }
      if (old.includes('\n') || nw.includes('\n')) { reject(e, '여러 단락에 걸침'); continue; }
      if (o.rejectedKeys.has(editKey(old, nw))) { reject(e, '이전에 거절한 제안'); continue; }
      let hits = [];
      chapter.paragraphs.forEach((p, pi) => { let from = 0, idx; while ((idx = p.text.indexOf(old, from)) !== -1) { hits.push({ paraId: p.id, paraIndex: pi, start: idx, end: idx + old.length, locked: p.locked }); from = idx + 1; } });
      if (hits.length === 0) { reject(e, '원고에서 찾을 수 없음'); continue; }
      if (hits.length > 1) { reject(e, '원고에 여러 번 나옴(앞뒤 글자를 늘려야 함)'); continue; }
      const h = hits[0];
      if (h.locked) { reject(e, '잠금 단락'); continue; }
      if (taken.some((t) => t.paraId === h.paraId && h.start < t.end && t.start < h.end)) { reject(e, '다른 제안과 겹침'); continue; }
      if (o.shorten && nw.length > old.length) { reject(e, '이 패스는 문장을 늘릴 수 없음'); continue; }
      if (nw.length > old.length * o.maxGrow + 20) { reject(e, '원문보다 지나치게 길어짐'); continue; }
      if (ok.length >= o.maxEdits) { reject(e, `한 패스 최대 ${o.maxEdits}곳 초과`); continue; }
      const warnings = [];
      if (o.noveltyCheck && o.words && nw) { const novel = [...hangulWords(nw)].filter((w) => !o.words.has(w) && !old.includes(w)); if (novel.length >= 2) warnings.push('원고에 없던 낱말: ' + novel.slice(0, 4).join(', ')); }
      if (countMatches(nw, SIMILE) > countMatches(old, SIMILE)) warnings.push('비유가 늘어남');
      if (!e.why || !String(e.why).trim()) warnings.push('이유가 적혀 있지 않음');
      taken.push(h);
      ok.push({ old, new: nw, tag: e.tag || o.pass, why: e.why || '', paraId: h.paraId, paraIndex: h.paraIndex, start: h.start, end: h.end, warnings, pass: o.pass });
    }
    return { ok, rejected };
  }
  // 모델이 낸 인용(quote)이 원고에 실제로 있는지 확인한다. 없는 인용은 버린다.
  function verifyQuotes(items, text, key) {
    key = key || 'quote'; const ok = [], dropped = [];
    (items || []).forEach((it) => { const q = String(it[key] || ''); if (q && String(text).includes(q)) ok.push(it); else dropped.push(it); });
    return { ok, dropped };
  }
  // 수락된 제안을 버전의 사본에 적용한다. 원본 버전은 건드리지 않는다.
  function applyProposals(ver, proposals) {
    const chapters = cloneChapters(ver.chapters), failed = []; let applied = 0;
    const byPara = new Map();
    proposals.forEach((p) => { if (!byPara.has(p.paraId)) byPara.set(p.paraId, []); byPara.get(p.paraId).push(p); });
    for (const ch of chapters) for (const para of ch.paragraphs) {
      const ps = byPara.get(para.id); if (!ps) continue;
      ps.sort((a, b) => b.start - a.start);
      for (const p of ps) {
        if (para.locked) { failed.push({ proposal: p, reason: '잠금 단락' }); continue; }
        let at = para.text.slice(p.start, p.end) === p.old ? p.start : -1;
        if (at < 0) { const first = para.text.indexOf(p.old); at = first >= 0 && para.text.indexOf(p.old, first + 1) < 0 ? first : -1; }
        if (at < 0) { failed.push({ proposal: p, reason: '원문이 바뀌어 위치를 찾지 못함' }); continue; }
        para.text = para.text.slice(0, at) + p.new + para.text.slice(at + p.old.length);
        if (para.source !== 'ai') para.source = 'ai-edit';
        applied++;
      }
    }
    return { chapters, applied, failed };
  }
  // AI가 쓴 글자 비율(공백 제외 글자 수 기준)
  function aiShare(ver) {
    let n = 0, t = 0;
    (ver.chapters || []).forEach((c) => c.paragraphs.forEach((p) => { const l = countNoSpaces(p.text); t += l; if (p.source === 'ai' || p.source === 'ai-edit') n += l; }));
    return t ? Math.round((n / t) * 1000) / 1000 : 0;
  }

  /* ───────────── 백업(JSON) ───────────── */
  const BACKUP_SCHEMA = 1;
  function makeBackup(works, versions, prefs) {
    return { app: '소설 작업실', schema: BACKUP_SCHEMA, exportedAt: nowIso(), works, versions, prefs: prefs || {} };
  }
  function validateBackup(obj) {
    const errs = [];
    if (!obj || typeof obj !== 'object') return ['JSON 객체가 아닙니다.'];
    if (obj.app !== '소설 작업실') errs.push('《소설 작업실》 백업 파일이 아닙니다.');
    if (obj.schema !== BACKUP_SCHEMA) errs.push('지원하지 않는 백업 형식 버전입니다: ' + obj.schema);
    if (!Array.isArray(obj.works) || !Array.isArray(obj.versions)) errs.push('works/versions 배열이 없습니다.');
    if (errs.length) return errs;
    const ids = new Set(obj.works.map((w) => w && w.id));
    obj.works.forEach((w, i) => { if (!w || !w.id || typeof w.title !== 'string') errs.push(`작품 ${i + 1}: id/title 누락`); });
    obj.versions.forEach((v, i) => {
      if (!v || !v.id || !ids.has(v.workId) || !Array.isArray(v.chapters)) errs.push(`버전 ${i + 1}: 구조 오류 또는 작품 없음`);
      else v.chapters.forEach((c) => { if (!Array.isArray(c.paragraphs)) errs.push(`버전 ${i + 1}: 장 구조 오류`); });
    });
    return errs.slice(0, 20);
  }
  // 이미 같은 ID의 작품이 있으면 모든 ID를 새로 부여해 복사본으로 들어오게 한다.
  function planImport(backup, existingWorkIds, existingVersionIds) {
    const works = [], versions = [], renamed = [];
    const wSet = new Set(existingWorkIds), vSet = new Set(existingVersionIds);
    for (const w of backup.works) {
      const vs = backup.versions.filter((v) => v.workId === w.id);
      const clash = wSet.has(w.id) || vs.some((v) => vSet.has(v.id));
      if (!clash) { works.push(w); vs.forEach((v) => versions.push(v)); continue; }
      const nw = JSON.parse(JSON.stringify(w)); nw.id = uid('w'); nw.title = w.title + ' (가져옴)';
      const map = new Map(); vs.forEach((v) => map.set(v.id, uid('v')));
      nw.currentVersionId = map.get(w.currentVersionId) || null;
      works.push(nw); renamed.push(w.title);
      vs.forEach((v) => { const nv = JSON.parse(JSON.stringify(v)); nv.id = map.get(v.id); nv.workId = nw.id; nv.parentId = map.get(v.parentId) || null; versions.push(nv); });
    }
    return { works, versions, renamed };
  }

  /* ───────────── 파일 텍스트 해석(가져오기) ───────────── */
  function decodeXmlEntities(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, g) => {
      if (g[0] === '#') { const cp = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10); try { return String.fromCodePoint(cp); } catch (e) { return ''; } }
      return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[g];
    });
  }
  // Word document.xml → [{text, heading}]
  function docxXmlToParas(xml) {
    const out = [];
    const paras = xml.split(/<\/w:p>/);
    for (const chunk of paras) {
      const start = Math.max(chunk.lastIndexOf('<w:p>'), chunk.lastIndexOf('<w:p '));
      if (start < 0) continue;
      const body = chunk.slice(start);
      const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(body);
      const heading = !!(style && /^(Heading|제목|Title)/i.test(style[1]));
      let text = '';
      for (const m of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:noBreakHyphen\s*\/>/g)) {
        if (m[1] !== undefined) text += decodeXmlEntities(m[1]);
        else if (m[0].startsWith('<w:tab')) text += ' ';
        else if (m[0].startsWith('<w:br')) text += '\n';
        else text += '-';
      }
      for (const l of text.split('\n')) out.push({ text: l, heading: heading && l.trim() !== '' });
    }
    return out;
  }
  // HWPX section XML → [{text}]  (실험적: 문단 <hp:p>, 글자 <hp:t>)
  function hwpxXmlToParas(xml) {
    const out = [];
    for (const m of xml.matchAll(/<hp:p\b[^>]*>([\s\S]*?)<\/hp:p>/g)) {
      let text = '';
      for (const t of m[1].matchAll(/<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>|<hp:t\s*\/>/g)) {
        if (t[1] !== undefined) text += decodeXmlEntities(t[1].replace(/<[^>]+>/g, ''));
      }
      out.push({ text });
    }
    return out;
  }
  function decodeBytes(buf) {
    const u = new Uint8Array(buf);
    if (u[0] === 0xEF && u[1] === 0xBB && u[2] === 0xBF) return { text: new TextDecoder('utf-8').decode(u.subarray(3)), encoding: 'UTF-8 (BOM)' };
    if (u[0] === 0xFF && u[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(u.subarray(2)), encoding: 'UTF-16LE' };
    if (u[0] === 0xFE && u[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(u.subarray(2)), encoding: 'UTF-16BE' };
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(u), encoding: 'UTF-8' }; }
    catch (e) { return { text: new TextDecoder('euc-kr').decode(u), encoding: 'EUC-KR/CP949 (자동 판별)' }; }
  }

  return {
    uid, nowIso, splitLines, cpLen,
    countWithSpaces, countNoSpaces, sheetSettings, DEFAULT_SHEET, simpleSheets, gridSheets, countText, aggregateCounts, sheetLabel,
    newParagraph, newChapter, chapterText, versionText, isSceneBreak, reconcileParagraphs,
    makeVersion, cloneChapters, flattenParas, diffVersions, inlineDiff,
    findAll, replaceMatches, cleanText, headingOf, splitChapters,
    toTxt, toMarkdown, privacyScan, sentencesOf, styleStats, styleFingerprint, verifyEdits, verifyQuotes, applyProposals, aiShare, manuscriptWordSet, editKey,
    makeBackup, validateBackup, planImport, BACKUP_SCHEMA,
    docxXmlToParas, hwpxXmlToParas, decodeBytes, decodeXmlEntities,
  };
});
