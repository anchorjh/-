/* 소설 작업실 — app.js (1단계: AI 없이 쓰고, 세고, 보존한다)
 * 화면(UI)만 담당한다. 계산·비교·정리는 NSCore, 저장은 NSStorage, 파일은 NSDocx. */
(function () {
  'use strict';
  const C = window.NSCore, D = window.NSDocx, ST = window.NSStorage;

  /* ───────────── 상태 ───────────── */
  const S = {
    storage: null, view: 'library', works: [], work: null, ver: null, versions: [], chIdx: 0,
    panelTab: 'para', saveState: 'saved', saveError: '', dirty: false, dirtySeq: 0, lastSaved: null,
    prefs: { font: 'serif', size: 17, lh: 1.9, width: 680 }, undo: [], cc: new Map(), composing: false,
    cmpA: null, cmpB: null, finder: { q: '', r: '', cs: false, matches: null, checked: new Set() },
    stats: null, otherWindow: false, focus: false, lastBackup: null,
  };
  const GENRES = ['단편', '중편', '장편', '역사소설', '기타'];
  const STATUSES = ['구상', '초고', '개고', '최종고', '응모 완료', '출간'];
  const KINDS = ['원문', '1고', '2고', '3고', '최종고', '기타'];
  const TAB = { id: 'novel-studio-' + Math.random().toString(36).slice(2) };
  let bc = null; try { bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('novel-studio') : null; } catch (e) { bc = null; }

  /* ───────────── DOM 도우미 ───────────── */
  // append/replaceChildren 에 null·false·배열이 들어가면 "null", "[object ...]" 가 글자로 찍힌다. 안전하게 거른다.
  ['append', 'replaceChildren'].forEach((m) => { const orig = Element.prototype[m]; Element.prototype[m] = function () { return orig.apply(this, Array.prototype.slice.call(arguments).flat(Infinity).filter((x) => x != null && x !== false)); }; });
  const $ = (s, r) => (r || document).querySelector(s);
  function h(tag, attrs) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else if (k === 'selected') el.selected = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const kids = Array.isArray(arguments[i]) ? arguments[i].flat(Infinity) : [arguments[i]];
      for (const kid of kids) { if (kid == null || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
    }
    return el;
  }
  const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');
  const pad = (n) => String(n).padStart(2, '0');
  function fmtDate(iso) { if (!iso) return '-'; const d = new Date(iso); if (isNaN(d)) return '-'; return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function toast(msg, kind) {
    const el = h('div', { class: 'toast' + (kind === 'err' ? ' err' : ''), role: kind === 'err' ? 'alert' : 'status' }, msg);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
  }
  // 모달. alert/confirm은 뷰어에서 막혀 있으므로 직접 만든다.
  function modal(opts) {
    const bg = h('div', { class: 'modal-bg' });
    const close = (v) => { document.removeEventListener('keydown', onKey, true); bg.remove(); if (opts.onClose) opts.onClose(v); };
    const onKey = (e) => { if (e.key === 'Escape' && !opts.noEsc) { e.stopPropagation(); close(null); } };
    const box = h('div', { class: 'modal' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
      h('header', {}, h('h2', {}, opts.title), h('button', { class: 'btn ghost sm', 'aria-label': '닫기', onclick: () => close(null) }, '닫기')),
      h('div', { class: 'mb' }, opts.body),
      opts.actions ? h('footer', {}, opts.actions(close)) : null);
    bg.append(box);
    bg.addEventListener('mousedown', (e) => { if (e.target === bg && !opts.noBgClose) close(null); });
    document.addEventListener('keydown', onKey, true);
    $('#modals').append(bg);
    const f = box.querySelector('input,textarea,select,button.primary'); if (f) setTimeout(() => f.focus(), 0);
    return { close, box };
  }
  function askConfirm(o) {
    return new Promise((resolve) => {
      let input = null;
      const body = [h('div', {}, o.message)];
      if (o.typeToConfirm) { input = h('input', { type: 'text', 'aria-label': '확인 입력', placeholder: o.typeToConfirm, autocomplete: 'off' }); body.push(h('label', { class: 'fld' }, `계속하려면 “${o.typeToConfirm}”을(를) 그대로 입력하세요`, input)); }
      let ok = null;
      const m = modal({
        title: o.title, body, noBgClose: true,
        onClose: (v) => resolve(v === true),
        actions: (close) => {
          ok = h('button', { class: 'btn ' + (o.danger ? 'danger fill' : 'primary'), disabled: !!o.typeToConfirm, onclick: () => close(true) }, o.confirmText || '확인');
          if (input) input.addEventListener('input', () => { ok.disabled = input.value !== o.typeToConfirm; });
          return [h('button', { class: 'btn', onclick: () => close(false) }, o.cancelText || '취소'), ok];
        },
      });
      return m;
    });
  }

  /* ───────────── 파일 저장(내려받기) ───────────── */
  async function saveFile(filename, data, mime) {
    let dl = null, inViewer = false;
    try { if (window.claude && window.claude.use) { inViewer = true; dl = await window.claude.use('downloads'); } } catch (e) { dl = null; }
    if (dl) {
      try { await dl.save({ filename, data }); toast('저장했습니다: ' + filename); return true; }
      catch (e) { if (e && e.code === 'declined') { toast('저장을 취소했습니다.'); return false; } toast('파일을 저장하지 못했습니다: ' + ((e && (e.message || e.code)) || '알 수 없는 오류'), 'err'); return false; }
    }
    if (!inViewer) {
      const a = h('a', { href: URL.createObjectURL(new Blob([data], { type: mime || 'application/octet-stream' })), download: filename });
      document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return true;
    }
    if (typeof data === 'string') {
      const ta = h('textarea', { class: 'field', rows: 12, readonly: true, 'aria-label': '내용', style: 'font-family: monospace' }); ta.value = data;
      modal({ title: '이 환경에서는 파일 저장이 막혀 있습니다', wide: true, body: [h('div', { class: 'muted' }, '아래 내용을 전체 복사해 직접 파일로 저장해 두세요: ' + filename), ta], actions: (close) => [h('button', { class: 'btn', onclick: async () => { ta.select(); try { await navigator.clipboard.writeText(data); toast('복사했습니다.'); } catch (e) { toast('선택된 내용을 Ctrl+C로 복사하세요.'); } } }, '전체 복사'), h('button', { class: 'btn primary', onclick: () => close() }, '닫기')] });
    } else toast('이 환경에서는 이진 파일(DOCX)을 저장할 수 없습니다. TXT나 Markdown으로 내보내 주세요.', 'err');
    return false;
  }

  /* ───────────── 작품·버전 기본 동작 ───────────── */
  function defaultWork(o) {
    const now = C.nowIso();
    return Object.assign({ id: C.uid('w'), title: '제목 없음', genre: '단편', status: '초고', createdAt: now, updatedAt: now, lastOpenedAt: now, currentVersionId: null,
      sheet: Object.assign({}, C.DEFAULT_SHEET), synopsis: '', setting: '', todo: '', memo: '', names: [], penName: '', realName: '', counts: { withSpaces: 0, noSpaces: 0, sheets: 0 }, cursor: {} }, o || {});
  }
  const chCounts = (ch) => { let c = S.cc.get(ch.id); if (!c) { c = C.countText(C.chapterText(ch), S.work.sheet); S.cc.set(ch.id, c); } return c; };
  const totalCounts = () => C.aggregateCounts(S.ver.chapters.map(chCounts), S.work.sheet);
  const verMeta = (v) => ST.metaOf(v);
  const curCh = () => S.ver.chapters[S.chIdx];

  async function loadWorks() {
    S.works = (await S.storage.listWorks()).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  async function openWork(id, tab, view) {
    await flushAndSave();
    const w = await S.storage.getWork(id);
    if (!w) { toast('작품을 찾을 수 없습니다.', 'err'); return; }
    let metas = await S.storage.listVersionMeta(id);
    let v = w.currentVersionId ? await S.storage.getVersion(w.currentVersionId) : null;
    if (!v && metas.length) { metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); v = await S.storage.getVersion(metas[0].id); }
    if (!v) { v = C.makeVersion({ workId: id, label: '초고', kind: '작업본', chapters: [C.newChapter('제1장', '')] }); await S.storage.putVersion(v); metas = [verMeta(v)]; }
    w.currentVersionId = v.id; w.lastOpenedAt = C.nowIso();
    S.work = w; S.ver = v; S.versions = metas; S.cc = new Map(); S.undo = []; S.dirty = false; S.saveState = 'saved'; S.otherWindow = false;
    const ci = v.chapters.findIndex((c) => c.id === (w.cursor && w.cursor.chapterId));
    S.chIdx = ci >= 0 ? ci : 0; S.finder.matches = null; S.stats = null; S.cmpA = S.cmpB = null;
    if (tab) S.panelTab = tab;
    await S.storage.putWork(w);
    go(view || 'write');
  }

  /* 저장: 입력이 멈춘 뒤 저장하고, 저장 중 입력이 더 들어오면 다시 저장한다. */
  let saveTimer = null, saving = Promise.resolve();
  function markDirty() { S.dirty = true; S.dirtySeq++; S.saveState = 'dirty'; refreshSaveState(); clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 800); }
  function saveNow() {
    clearTimeout(saveTimer);
    saving = saving.then(async () => {
      if (!S.dirty || !S.ver) return;
      const seq = S.dirtySeq;
      S.saveState = 'saving'; refreshSaveState();
      try {
        const t = totalCounts();
        S.ver.updatedAt = C.nowIso();
        S.ver.stats = { withSpaces: t.withSpaces, noSpaces: t.noSpaces, sheets: t.sheets };
        S.work.updatedAt = S.ver.updatedAt; S.work.currentVersionId = S.ver.id;
        S.work.counts = { withSpaces: t.withSpaces, noSpaces: t.noSpaces, sheets: t.sheets, simple: t.simple, grid: t.grid, chapters: S.ver.chapters.length, aiShare: C.aiShare(S.ver) };
        S.work.cursor = { chapterId: curCh() && curCh().id };
        await S.storage.putVersion(S.ver);
        await S.storage.putWork(S.work);
        const i = S.versions.findIndex((m) => m.id === S.ver.id);
        if (i >= 0) S.versions[i] = verMeta(S.ver); else S.versions.push(verMeta(S.ver));
        if (seq === S.dirtySeq) { S.dirty = false; S.saveState = 'saved'; } else { S.saveState = 'dirty'; saveTimer = setTimeout(saveNow, 300); }
        S.lastSaved = new Date(); S.saveError = '';
        if (bc) bc.postMessage({ from: TAB.id, versionId: S.ver.id });
      } catch (e) {
        S.saveState = 'error'; S.saveError = (e && e.message) || String(e);
      }
      refreshSaveState();
    });
    return saving;
  }
  async function flushAndSave() { if (S.view === 'write' && S.ver) processEditor(true); if (S.dirty) await saveNow(); else await saving; }

  // 고정된(저장된) 버전은 고치지 않는다. 편집이 시작되면 원본은 두고 새 작업본으로 분기한다.
  function ensureEditable() {
    if (!S.ver.frozen) return false;
    const parent = S.ver;
    let n = S.versions.filter((m) => m.kind === '작업본').length + 1;
    while (S.versions.some((m) => m.label === '작업본 ' + n)) n++;
    const nv = C.makeVersion({ workId: S.work.id, parentId: parent.id, label: '작업본 ' + n, kind: '작업본', chapters: C.cloneChapters(parent.chapters) });
    S.ver = nv; S.work.currentVersionId = nv.id; S.versions.push(verMeta(nv)); S.undo = [];
    toast(`“${parent.label}”은(는) 그대로 보존하고 새 작업본(${nv.label})에서 편집합니다.`);
    renderBanner();
    return true;
  }
  const snapshot = () => { S.undo.push({ chapters: JSON.stringify(S.ver.chapters), chIdx: S.chIdx, id: S.ver.id }); if (S.undo.length > 20) S.undo.shift(); refreshUndo(); };

  /* ───────────── 라우팅·뼈대 ───────────── */
  function go(view) {
    if (S.view === 'write' && view !== 'write') { processEditor(true); }
    S.view = view; render();
    window.scrollTo(0, 0);
  }
  function render() {
    document.body.classList.toggle('focus', S.focus && S.view === 'write');
    renderNav(); renderStorageBanner();
    const main = $('#main'); main.replaceChildren();
    if (S.view === 'library') renderLibrary(main);
    else if (S.view === 'wizard') NSApp.views.wizard(main);
    else if (S.view === 'settings') renderSettings(main);
    else if (S.view === 'profiles') NSApp.views.profiles(main);
    else if (!S.work) { go('library'); return; }
    else if (S.view === 'write') renderWrite(main);
    else if (S.view === 'compare') renderCompare(main);
    else if (S.view === 'stats') renderStats(main);
    else if (S.view === 'ai') NSApp.views.ai(main);
    else if (NSApp.views[S.view]) NSApp.views[S.view](main);
    if (NSApp.hooks.afterRender) NSApp.hooks.afterRender();
    refreshSaveState();
  }
  function renderNav() {
    const items = [['library', '작품 보관함'], ['wizard', 'AI로 새 작품'], ['write', '집필 공간'], ['ai', 'AI 작업실'], ['compare', '버전 비교'], ['stats', '문체 통계'], ['profiles', '문체 프로필'], ['settings', '설정·백업']];
    const nav = $('#nav'); nav.replaceChildren(...items.map(([k, t]) => h('button', { 'aria-current': S.view === k ? 'page' : null, disabled: k !== 'library' && !S.work && k !== 'settings' && k !== 'wizard' && k !== 'profiles', onclick: () => go(k) }, t)));
    $('#worktitle').textContent = S.work && S.view !== 'library' ? S.work.title : '';
  }
  function refreshSaveState() {
    const el = $('#savestate'); if (!el) return;
    const map = { saved: S.lastSaved ? `저장됨 ${pad(S.lastSaved.getHours())}:${pad(S.lastSaved.getMinutes())}:${pad(S.lastSaved.getSeconds())}` : '저장됨', dirty: '저장 대기 중…', saving: '저장 중…', error: '저장 실패: ' + S.saveError };
    el.dataset.s = S.saveState; el.replaceChildren(h('span', { class: 'dot' }), map[S.saveState]);
    el.hidden = !S.work || S.view === 'library';
  }
  function renderStorageBanner() {
    const el = $('#storagebanner'); el.replaceChildren();
    if (S.storage.kind !== 'indexeddb') el.append(h('div', { class: 'banner danger', role: 'alert' }, '이 환경에서는 브라우저 저장소를 쓸 수 없어, 창을 닫거나 새로고침하면 모든 원고가 사라집니다. 작업 중 수시로 “설정·백업”에서 JSON 백업을 내려받으세요.', S.storage.reason ? h('span', { class: 'small' }, '(' + S.storage.reason + ')') : null));
  }

  /* ───────────── 작품 보관함 ───────────── */
  function renderLibrary(main) {
    const recent = S.works.slice().sort((a, b) => (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || '')).slice(0, 3);
    const noBackup = S.works.length && !S.lastBackup;
    main.append(
      h('div', { class: 'page-head' }, h('h1', {}, '작품 보관함'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn primary', onclick: newWorkDialog }, '새 작품'),
          h('button', { class: 'btn', onclick: () => go('wizard') }, 'AI로 새 작품 쓰기'),
          h('button', { class: 'btn', onclick: () => pickFile('.txt,.md,.docx,.hwpx,.hwp,text/plain', async (f) => { const r = await importDialog(f, { mode: 'new' }); if (r) await createWorkFromImport(r); }) }, '파일로 새 작품 만들기'),
          h('button', { class: 'btn', onclick: () => pickFile('.json,application/json', restoreBackup) }, '백업 불러오기'))),
      noBackup ? h('div', { class: 'banner' }, '아직 백업한 적이 없습니다. 원고는 이 브라우저에만 저장되어, 브라우저 데이터를 지우면 함께 사라집니다.', h('button', { class: 'btn sm', onclick: () => go('settings') }, '백업하러 가기')) : null,
      ...(recent.length ? [h('h2', { class: 'small muted', style: 'margin-bottom:8px;font-weight:500' }, '최근 작업'), h('div', { class: 'recent' }, recent.map((w) => h('div', { class: 'card', tabindex: 0, role: 'button', onclick: () => openWork(w.id), onkeydown: (e) => { if (e.key === 'Enter') openWork(w.id); } },
        h('div', { style: 'font-weight:600;margin-bottom:4px' }, w.title), h('div', { class: 'small muted' }, `${w.genre} · ${w.status}`), h('div', { class: 'small mono', style: 'margin-top:6px' }, `${fmt(w.counts.withSpaces)}자 · ${w.counts.sheets}매`), h('div', { class: 'small muted' }, '수정 ' + fmtDate(w.updatedAt)))))] : []),
      h('div', { class: 'card' }, S.works.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['작품명', '장르', '상태', '현재 버전', '공백 포함', '공백 제외', '원고지', '수정'].map((t, i) => h('th', { class: i >= 4 && i <= 6 ? 'num' : '' }, t)), h('th', {}, ''))),
        h('tbody', {}, S.works.map(workRow)))) : h('div', { class: 'empty' }, '작품이 없습니다. “새 작품”을 눌러 시작하세요.')),
      h('p', { class: 'small muted', style: 'margin-top:12px' }, '글자 수·원고지 매수는 작품별 설정(설정·백업)의 계산 방식을 따릅니다. 원고지 열은 현재 버전 기준입니다.'));
    setTimeout(fillVersionLabels, 0);
  }
  function workRow(w) {
    const vmeta = null;
    return h('tr', {},
      h('td', {}, h('span', { class: 'title', tabindex: 0, onclick: () => openWork(w.id), onkeydown: (e) => { if (e.key === 'Enter') openWork(w.id); } }, w.title), w.format === 'script' ? h('span', { class: 'pill', style: 'margin-left:6px' }, '시나리오') : null, w.derivedFrom ? h('span', { class: 'pill', style: 'margin-left:6px', title: '다른 작품에서 변환해 만든 파생 작품' }, '파생') : null),
      h('td', {}, w.genre), h('td', {}, h('span', { class: 'pill accent' }, w.status)),
      h('td', { class: 'small', 'data-vlabel': w.id }, '…'),
      h('td', { class: 'num' }, fmt(w.counts.withSpaces)), h('td', { class: 'num' }, fmt(w.counts.noSpaces)), h('td', { class: 'num' }, String(w.counts.sheets) + '매'),
      h('td', { class: 'small muted' }, fmtDate(w.updatedAt)),
      h('td', {}, h('div', { class: 'btn-row', style: 'justify-content:flex-end;flex-wrap:nowrap' },
        h('button', { class: 'btn sm', onclick: () => openWork(w.id) }, '열기'),
        h('button', { class: 'btn sm', onclick: () => openWork(w.id, 'info') }, '정보'),
        h('button', { class: 'btn sm danger', onclick: () => deleteWorkFlow(w) }, '삭제'))));
  }
  async function fillVersionLabels() {
    for (const w of S.works) {
      const cell = document.querySelector(`[data-vlabel="${w.id}"]`); if (!cell) continue;
      const ms = await S.storage.listVersionMeta(w.id); const cur = ms.find((m) => m.id === w.currentVersionId);
      cell.textContent = cur ? `${cur.label}${cur.frozen ? ' (고정)' : ''} · 총 ${ms.length}개` : `총 ${ms.length}개`;
    }
  }
  function newWorkDialog() {
    const title = h('input', { type: 'text', placeholder: '작품명', 'aria-label': '작품명' });
    const genre = h('select', { 'aria-label': '장르' }, GENRES.map((g) => h('option', { value: g }, g)));
    const status = h('select', { 'aria-label': '집필 상태' }, STATUSES.map((g) => h('option', { value: g, selected: g === '초고' }, g)));
    modal({ title: '새 작품', body: [h('label', { class: 'fld' }, '작품명', title), h('div', { class: 'grid2' }, h('label', { class: 'fld' }, '장르', genre), h('label', { class: 'fld' }, '집필 상태', status))],
      actions: (close) => [h('button', { class: 'btn', onclick: () => close() }, '취소'), h('button', { class: 'btn primary', onclick: async () => {
        const w = defaultWork({ title: title.value.trim() || '제목 없음', genre: genre.value, status: status.value });
        const v = C.makeVersion({ workId: w.id, label: '작업본 1', kind: '작업본', chapters: [C.newChapter('제1장', '')] });
        w.currentVersionId = v.id; await S.storage.putVersion(v); await S.storage.putWork(w); close(); await loadWorks(); openWork(w.id);
      } }, '만들기')] });
  }
  async function deleteWorkFlow(w) {
    const ms = await S.storage.listVersionMeta(w.id);
    const ok = await askConfirm({ title: '작품 삭제', danger: true, confirmText: '영구 삭제', typeToConfirm: w.title,
      message: `“${w.title}”과(와) 저장된 버전 ${ms.length}개를 모두 삭제합니다. 되돌릴 수 없습니다. 삭제 전에 백업했는지 확인하세요.` });
    if (!ok) return;
    await S.storage.deleteWork(w.id);
    if (S.work && S.work.id === w.id) { S.work = null; S.ver = null; }
    await loadWorks(); render(); toast('삭제했습니다.');
  }
  function pickFile(accept, cb) {
    const inp = h('input', { type: 'file', accept, style: 'position:fixed;left:-9999px' });
    inp.addEventListener('change', async () => { const f = inp.files && inp.files[0]; inp.remove(); if (f) { try { await cb(f); } catch (e) { toast('파일을 처리하지 못했습니다: ' + (e.message || e), 'err'); } } });
    document.body.append(inp); inp.click();
  }

  /* ───────────── 가져오기 ───────────── */
  async function readImportFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'hwp') throw new Error('HWP(구형 형식)는 브라우저에서 읽을 수 없습니다. 한글에서 “다른 이름으로 저장”으로 HWPX, DOCX 또는 TXT로 저장한 뒤 올려 주세요.');
    if (ext === 'doc') throw new Error('구형 Word(.doc)는 지원하지 않습니다. DOCX나 TXT로 저장해 올려 주세요.');
    const buf = await file.arrayBuffer();
    let items, encoding = '';
    if (ext === 'docx' || ext === 'hwpx') {
      if (!window.JSZip) throw new Error('DOCX/HWPX를 읽는 라이브러리(JSZip)를 불러오지 못했습니다. TXT로 저장해 올려 주세요.');
      items = ext === 'docx' ? await D.readDocx(window.JSZip, buf) : await D.readHwpx(window.JSZip, buf);
    } else { const r = C.decodeBytes(buf); encoding = r.encoding; items = C.splitLines(r.text).map((t) => ({ text: t })); }
    return { name: file.name, ext, items, encoding };
  }
  function applyImportOptions(items, o) {
    const rep = {};
    let lines = items.map((it) => {
      const r = C.cleanText(it.text, { nfc: true, specialSpaces: o.spaces, quotes: o.quotes, ellipsis: o.ellipsis, trailing: o.trailing, blankLines: 'keep' });
      for (const k in r.report) rep[k] = (rep[k] || 0) + r.report[k];
      return { text: r.text, heading: o.detect ? it.heading : false };
    });
    if (o.blank === 'remove') lines = lines.filter((l) => l.text.trim() !== '');
    else if (o.blank === 'collapse') { const out = []; for (const l of lines) { if (!l.text.trim() && out.length && !out[out.length - 1].text.trim()) continue; out.push(l); } lines = out; }
    return { chapters: C.splitChapters(lines, { detect: o.detect, firstTitle: '본문' }), report: rep };
  }
  // 가져오기 옵션 대화상자. {title, chapters, fileName} 또는 null.
  async function importDialog(file, ctx) {
    const parsed = await readImportFile(file);
    return new Promise((resolve) => {
      const o = { spaces: true, trailing: true, quotes: 'keep', ellipsis: 'keep', blank: 'keep', detect: true };
      const title = h('input', { type: 'text', value: file.name.replace(/\.[^.]+$/, ''), 'aria-label': '작품명' });
      const preview = h('div', { class: 'small', style: 'display:flex;flex-direction:column;gap:4px' });
      let result = null;
      const sel = (key, opts) => h('select', { 'aria-label': key, onchange: (e) => { o[key] = e.target.value; update(); } }, opts.map(([v, t]) => h('option', { value: v, selected: o[key] === v }, t)));
      const chk = (key, label) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: o[key], onchange: (e) => { o[key] = e.target.checked; update(); } }), label);
      function update() {
        result = applyImportOptions(parsed.items, o);
        const total = result.chapters.reduce((a, c) => a + C.countWithSpaces(c.text), 0), totalN = result.chapters.reduce((a, c) => a + C.countNoSpaces(c.text), 0);
        preview.replaceChildren(
          h('div', {}, h('b', {}, `장 ${result.chapters.length}개`), ` · 공백 포함 ${fmt(total)}자 · 공백 제외 ${fmt(totalN)}자` + (parsed.encoding ? ` · 인코딩 ${parsed.encoding}` : '')),
          Object.keys(result.report).length ? h('div', { class: 'muted' }, '정리: ' + Object.entries(result.report).map(([k, n]) => `${k} ${fmt(n)}`).join(', ')) : h('div', { class: 'muted' }, '정리할 항목이 없었습니다.'),
          h('div', { class: 'list', style: 'margin-top:4px' }, result.chapters.slice(0, 8).map((c) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, c.title || '(제목 없음)')), h('span', { class: 'small muted mono' }, fmt(C.countWithSpaces(c.text)) + '자')))),
          result.chapters.length > 8 ? h('div', { class: 'muted' }, `… 외 ${result.chapters.length - 8}개 장`) : null);
      }
      update();
      modal({ title: '파일 가져오기', wide: true, noBgClose: true, onClose: (v) => resolve(v === 'ok' ? { title: title.value.trim() || '제목 없음', chapters: result.chapters, fileName: file.name } : null),
        body: [
          h('div', { class: 'muted' }, `${parsed.name}` + (parsed.ext === 'hwpx' ? ' · HWPX 가져오기는 실험적입니다. 결과를 꼭 확인하세요.' : '')),
          ctx.mode === 'new' ? h('label', { class: 'fld' }, '작품명', title) : null,
          h('div', { class: 'grid2' },
            h('div', { class: 'stack', style: 'gap:8px' }, chk('spaces', '특수 공백·폭 없는 문자 정리'), chk('trailing', '줄 끝 공백 제거'), chk('detect', '장 제목 자동 인식 (제N장, ##, 제목 스타일 등)')),
            h('div', { class: 'stack', style: 'gap:8px' },
              h('label', { class: 'fld' }, '따옴표', sel('quotes', [['keep', '그대로'], ['curly', '“ ” ‘ ’ 로 통일'], ['straight', '" \' 로 통일']])),
              h('label', { class: 'fld' }, '말줄임표', sel('ellipsis', [['keep', '그대로'], ['char', '… 로 통일'], ['dots', '... 로 통일']])),
              h('label', { class: 'fld' }, '빈 줄', sel('blank', [['keep', '그대로'], ['collapse', '연속된 빈 줄을 하나로'], ['remove', '모든 빈 줄 제거 (문단마다 빈 줄이 낀 원고용)']])))),
          h('div', { class: 'banner info' }, '원본 파일은 바꾸지 않습니다. 가져온 내용은 “원문” 버전으로 고정되어, 이후 편집은 새 작업본에서 이뤄집니다.'),
          preview],
        actions: (close) => [h('button', { class: 'btn', onclick: () => close(null) }, '취소'), h('button', { class: 'btn primary', onclick: () => close('ok') }, ctx.mode === 'new' ? '새 작품으로 만들기' : '현재 작품에 장으로 추가')] });
    });
  }
  async function createWorkFromImport(r) {
    const w = defaultWork({ title: r.title, genre: '기타', status: '초고' });
    const v = C.makeVersion({ workId: w.id, label: '원문', kind: '원문', frozen: true, note: `${r.fileName}에서 가져옴`, chapters: r.chapters.map((c) => C.newChapter(c.title, c.text)) });
    const t = C.aggregateCounts(v.chapters.map((ch) => C.countText(C.chapterText(ch), w.sheet)), w.sheet);
    v.stats = { withSpaces: t.withSpaces, noSpaces: t.noSpaces, sheets: t.sheets };
    w.currentVersionId = v.id; w.counts = { withSpaces: t.withSpaces, noSpaces: t.noSpaces, sheets: t.sheets, simple: t.simple, grid: t.grid, chapters: v.chapters.length };
    await S.storage.putVersion(v); await S.storage.putWork(w); await loadWorks(); await openWork(w.id);
    toast(`“${w.title}”을(를) 원문 버전으로 가져왔습니다.`);
  }
  async function appendImport(file) {
    const r = await importDialog(file, { mode: 'append' }); if (!r) return;
    processEditor(true); ensureEditable(); snapshot();
    r.chapters.forEach((c) => S.ver.chapters.push(C.newChapter(c.title, c.text)));
    S.cc = new Map(); S.chIdx = S.ver.chapters.length - r.chapters.length; markDirty(); render(); toast(`장 ${r.chapters.length}개를 추가했습니다. (되돌리기 가능)`);
  }

  /* ───────────── 백업 ───────────── */
  const dstamp = () => { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`; };
  async function exportBackup(workId) {
    await flushAndSave();
    const all = await S.storage.exportAll();
    let works = all.works, versions = all.versions;
    if (workId) { works = works.filter((w) => w.id === workId); versions = versions.filter((v) => v.workId === workId); }
    const json = JSON.stringify(C.makeBackup(works, versions, all.prefs), null, 1);
    const ok = await saveFile(`소설작업실-백업-${workId ? works[0].title.replace(/[\\/:*?"<>|]/g, '_') + '-' : ''}${dstamp()}.json`, json, 'application/json');
    if (ok && !workId) { S.lastBackup = C.nowIso(); await S.storage.setMeta('lastBackup', S.lastBackup); }
    return ok;
  }
  async function restoreBackup(file) {
    let obj; try { obj = JSON.parse(await file.text()); } catch (e) { toast('JSON 파일을 읽을 수 없습니다.', 'err'); return; }
    const errs = C.validateBackup(obj);
    if (errs.length) { modal({ title: '불러올 수 없는 백업', body: [h('div', {}, '이 파일은 《소설 작업실》 백업으로 사용할 수 없습니다.'), h('ul', {}, errs.map((e) => h('li', {}, e)))], actions: (c) => h('button', { class: 'btn primary', onclick: () => c() }, '닫기') }); return; }
    const exist = await S.storage.exportAll();
    const plan = C.planImport(obj, exist.works.map((w) => w.id), exist.versions.map((v) => v.id));
    const ok = await askConfirm({ title: '백업 불러오기', confirmText: '불러오기', message: `작품 ${plan.works.length}개, 버전 ${plan.versions.length}개를 추가합니다. 기존 작품은 바뀌지 않습니다.` + (plan.renamed.length ? ` 이미 있는 작품(${plan.renamed.join(', ')})은 “(가져옴)” 복사본으로 들어옵니다.` : '') });
    if (!ok) return;
    await S.storage.importAll(plan); await loadWorks(); render(); toast('백업을 불러왔습니다.');
  }

  /* ───────────── 내보내기 ───────────── */
  function exportDialog() {
    processEditor(true);
    const o = { fmt: 'txt', title: true, chTitles: true };
    const hits = C.privacyScan(S.ver, [S.work.penName, S.work.realName].filter(Boolean));
    const rad = (v, t, dis) => h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'fmt', value: v, checked: o.fmt === v, disabled: dis, onchange: () => (o.fmt = v) }), t);
    modal({ title: '내보내기', body: [
      h('div', { class: 'muted' }, `현재 버전: ${S.ver.label}${S.ver.frozen ? ' (고정)' : ''}`),
      h('div', { class: 'stack', style: 'gap:6px' }, rad('txt', 'TXT (문단마다 줄바꿈)'), rad('md', 'Markdown (장 제목 ##, 장면 구분 ***)'), rad('docx', 'DOCX (Word·한글에서 열기)' + (window.JSZip ? '' : ' — 이 환경에서는 사용할 수 없음'), !window.JSZip)),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (o.title = e.target.checked) }), '작품 제목을 맨 앞에 넣기'),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (o.chTitles = e.target.checked) }), '장 제목 넣기'),
      hits.length ? h('div', { class: 'banner' }, `본문에서 신상 정보로 보이는 곳 ${hits.length}곳이 있습니다. 공모전에 낼 원고라면 “문체 통계 → 응모 전 점검”에서 확인하세요.`) : null],
      actions: (close) => [h('button', { class: 'btn', onclick: () => close() }, '취소'), h('button', { class: 'btn primary', onclick: async () => {
        const base = `${S.work.title}_${S.ver.label}`.replace(/[\\/:*?"<>|]/g, '_');
        const wt = o.title ? S.work.title : '';
        const vv = o.chTitles ? S.ver : { chapters: S.ver.chapters.map((c) => Object.assign({}, c, { title: '' })) };
        close();
        if (o.fmt === 'txt') await saveFile(base + '.txt', C.toTxt(vv, { workTitle: wt, chapterTitles: o.chTitles }), 'text/plain');
        else if (o.fmt === 'md') await saveFile(base + '.md', C.toMarkdown(vv, { workTitle: wt }), 'text/markdown');
        else { try { await saveFile(base + '.docx', await D.buildDocx(window.JSZip, vv, wt), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); } catch (e) { toast('DOCX를 만들지 못했습니다: ' + e.message, 'err'); } }
      } }, '내보내기')] });
  }

  /* ───────────── 집필 공간 ───────────── */
  let procTimer = null, paraTimer = null, prefTimer = null, workTimer = null;
  S.editDirty = false; S.paraIdx = 0;

  function applyPrefs() {
    const r = document.documentElement.style, p = S.prefs;
    r.setProperty('--ed-size', p.size + 'px'); r.setProperty('--ed-lh', String(p.lh)); r.setProperty('--ed-width', p.width + 'px');
    r.setProperty('--ed-font', p.font === 'sans' ? 'var(--font-ui)' : 'var(--font-serif)');
  }
  function setPref(k, v) { S.prefs[k] = v; applyPrefs(); clearTimeout(prefTimer); prefTimer = setTimeout(() => S.storage.setMeta('prefs', S.prefs).catch(() => {}), 400); }

  function renderWrite(main) {
    const ta = h('textarea', { id: 'editor', spellcheck: 'false', lang: 'ko', 'aria-label': '본문 편집', placeholder: '여기에 소설을 씁니다. 문단은 줄바꿈으로 나뉩니다.' });
    const title = h('input', { type: 'text', id: 'chtitle', class: 'chtitle', 'aria-label': '장 제목', placeholder: '장 제목' });
    ta.addEventListener('input', (e) => { if (S.composing || e.isComposing) return; S.editDirty = true; clearTimeout(procTimer); procTimer = setTimeout(() => processEditor(false), 150); });
    ta.addEventListener('compositionstart', () => { S.composing = true; });
    ta.addEventListener('compositionend', () => { S.composing = false; S.editDirty = true; clearTimeout(procTimer); procTimer = setTimeout(() => processEditor(false), 50); });
    ta.addEventListener('blur', () => { S.composing = false; processEditor(true); });
    ['keyup', 'click', 'select'].forEach((ev) => ta.addEventListener(ev, schedulePara));
    title.addEventListener('input', () => { const t = title.value; ensureEditable(); curCh().title = t; refreshChapterList(); markDirty(); });
    main.append(
      h('div', { class: 'write' },
        h('aside', { class: 'chapters', 'aria-label': '장 목록' },
          h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: addChapter }, '장 추가'), h('button', { class: 'btn sm', onclick: () => moveChapter(-1), title: '현재 장을 위로' }, '↑'), h('button', { class: 'btn sm', onclick: () => moveChapter(1), title: '현재 장을 아래로' }, '↓')),
          h('div', { id: 'chlist', class: 'chlist' }),
          h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: splitChapter, title: '커서가 있는 단락부터 새 장으로 나눕니다' }, '여기서 장 나누기'), h('button', { class: 'btn sm', onclick: mergeChapter, title: '현재 장을 앞 장 끝에 붙입니다' }, '앞 장과 합치기'), h('button', { class: 'btn sm danger', onclick: deleteChapter }, '장 삭제'))),
        h('section', { class: 'editor-wrap' },
          h('div', { class: 'toolbar', id: 'toolbar' }),
          h('div', { id: 'banner' }),
          h('div', { class: 'sheet' }, h('div', { class: 'sheet-inner' }, title, ta)),
          h('div', { class: 'statusbar', id: 'statusbar', 'aria-live': 'off' })),
        h('aside', { class: 'panel', 'aria-label': '보조 패널' }, h('div', { class: 'tabs', role: 'tablist', id: 'tabs' }), h('div', { id: 'panelbody' }))),
      h('button', { class: 'btn focus-exit', onclick: () => toggleFocus(false) }, '집중 모드 끝내기 (Esc)'));
    renderToolbar(); renderBanner(); renderTabs(); refreshChapterList(); loadEditor(); renderPanel();
  }
  function renderToolbar() {
    const p = S.prefs, tb = $('#toolbar');
    const sel = (opts, cur, fn, label) => h('select', { 'aria-label': label, style: 'width:auto', onchange: (e) => fn(e.target.value) }, opts.map(([v, t]) => h('option', { value: v, selected: String(cur) === String(v) }, t)));
    tb.replaceChildren(
      h('button', { class: 'btn sm', id: 'undobtn', onclick: undo, title: '장 추가·삭제·바꾸기·정리 같은 작업을 되돌립니다. 타이핑은 Ctrl+Z' }, '작업 되돌리기'),
      h('span', { class: 'sep' }),
      sel([['serif', '명조체'], ['sans', '고딕체']], p.font, (v) => setPref('font', v), '글꼴'),
      sel([[15, '글자 작게'], [17, '글자 보통'], [19, '글자 크게'], [22, '글자 아주 크게']], p.size, (v) => setPref('size', +v), '글자 크기'),
      sel([[1.6, '줄 간격 좁게'], [1.9, '줄 간격 보통'], [2.2, '줄 간격 넓게']], p.lh, (v) => setPref('lh', +v), '줄 간격'),
      sel([[560, '본문 폭 좁게'], [680, '본문 폭 보통'], [820, '본문 폭 넓게']], p.width, (v) => setPref('width', +v), '본문 폭'),
      h('span', { class: 'sep' }),
      h('button', { class: 'btn sm', onclick: () => pickFile('.txt,.md,.docx,.hwpx,.hwp', appendImport) }, '파일에서 장 추가'),
      h('button', { class: 'btn sm', onclick: exportDialog }, '내보내기'),
      NSApp.sceneDialog ? h('button', { class: 'btn sm', onclick: () => NSApp.sceneDialog(), title: '커서가 있는 장면(또는 선택한 단락)에 AI 작업을 실행' }, '장면 AI 작업') : null,
      h('button', { class: 'btn sm', onclick: () => toggleFocus(true) }, '집중 모드'));
    refreshUndo();
  }
  function refreshUndo() { const b = $('#undobtn'); if (b) { b.disabled = !S.undo.length; b.textContent = S.undo.length ? `작업 되돌리기 (${S.undo.length})` : '작업 되돌리기'; } }
  function toggleFocus(on) { processEditor(true); S.focus = on; document.body.classList.toggle('focus', on); if (!on) { const t = $('#editor'); if (t) t.focus(); } }
  function renderBanner() {
    const b = $('#banner'); if (!b) return; b.replaceChildren();
    if (S.ver.frozen) b.append(h('div', { class: 'banner info' }, `“${S.ver.label}” 버전은 고정되어 있습니다. 글을 고치면 원본은 그대로 두고 새 작업본이 만들어집니다.`));
    if (S.otherWindow) b.append(h('div', { class: 'banner danger', role: 'alert' }, '다른 창에서 이 버전이 수정되었습니다. 이 창에서 계속 쓰면 그 내용을 덮어씁니다.', h('button', { class: 'btn sm', onclick: async () => { S.dirty = false; await openWork(S.work.id); } }, '다른 창 내용 불러오기')));
  }

  function refreshChapterList() {
    const el = $('#chlist'); if (!el) return;
    el.replaceChildren(...S.ver.chapters.map((ch, i) => {
      const c = chCounts(ch), locks = ch.paragraphs.filter((p) => p.locked).length;
      return h('button', { class: 'chitem', 'aria-current': i === S.chIdx ? 'true' : null, onclick: () => selectChapter(i) },
        h('span', { class: 't' }, ch.title || `(제목 없음 ${i + 1})`), h('span', { class: 'n' }, `${fmt(c.withSpaces)}자` + (locks ? ` · 잠금 ${locks}` : '')));
    }));
  }
  function selectChapter(i) { processEditor(true); S.chIdx = i; refreshChapterList(); loadEditor(); renderPanel(); }
  function loadEditor() {
    const ta = $('#editor'), ti = $('#chtitle'), ch = curCh(); if (!ta || !ch) return;
    ta.value = C.chapterText(ch); ti.value = ch.title || ''; S.editDirty = false; S.paraIdx = 0; ta.scrollTop = 0; refreshCounts();
  }
  function refreshCounts() {
    const sb = $('#statusbar'); if (!sb || !S.ver) return;
    const ch = chCounts(curCh()), t = totalCounts();
    sb.replaceChildren(
      h('span', {}, '이 장 ', h('b', {}, fmt(ch.withSpaces)), '자 (공백 제외 ', h('b', {}, fmt(ch.noSpaces)), ')'),
      h('span', {}, '전체 ', h('b', {}, fmt(t.withSpaces)), '자 (공백 제외 ', h('b', {}, fmt(t.noSpaces)), ')'),
      h('span', { title: t.sheetLabel }, '원고지 ', h('b', {}, String(t.sheets)), '매'),
      h('span', { class: 'hide-focus', title: '다른 계산 방식의 결과' }, `단순 ${t.simple.withSpaces}매 · 모사 ${t.grid.sheets}매(${t.grid.lines}줄)`),
      h('span', { class: 'hide-focus muted' }, `계산: ${t.sheetLabel}`),
      h('span', { class: 'hide-focus', style: 'margin-left:auto' }, `버전: ${S.ver.label}`));
  }
  function processEditor(force) {
    if (S.view !== 'write' || !S.ver) return;
    const ta = $('#editor'); if (!ta) return;
    if (S.composing && !force) return;
    if (!S.editDirty && !force) return;
    let ch = curCh(); if (!ch) return;
    if (ta.value === C.chapterText(ch)) { S.editDirty = false; return; }
    if (S.ver.frozen) { ensureEditable(); ch = curCh(); }
    ch.paragraphs = C.reconcileParagraphs(ch.paragraphs, ta.value);
    S.cc.delete(ch.id); S.editDirty = false;
    refreshCounts(); refreshChapterList(); markDirty(); schedulePara();
  }
  function schedulePara() {
    clearTimeout(paraTimer);
    paraTimer = setTimeout(() => {
      const ta = $('#editor'); if (!ta || S.view !== 'write') return;
      const idx = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
      if (idx !== S.paraIdx) {
        S.paraIdx = idx;
        const inPanel = document.activeElement && document.activeElement.closest && document.activeElement.closest('#panelbody');
        if (S.panelTab === 'para' && !inPanel) renderPanel();
      }
    }, 200);
  }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && S.work) { e.preventDefault(); processEditor(true); saveNow().then(() => toast(S.saveState === 'saved' ? '저장했습니다.' : '저장하지 못했습니다.', S.saveState === 'saved' ? '' : 'err')); }
    if (e.key === 'Escape' && S.focus && !document.querySelector('.modal-bg')) toggleFocus(false);
  });
  window.addEventListener('pagehide', () => { try { processEditor(true); saveNow(); } catch (e) { /* 마지막 저장 시도 */ } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { processEditor(true); saveNow(); } });

  /* 장 조작 — 모두 먼저 편집 내용을 반영하고, 고정 버전이면 분기한 뒤, 되돌리기 지점을 남긴다. */
  function prep() { processEditor(true); ensureEditable(); snapshot(); S.cc = new Map(); }
  function afterStructureChange() { markDirty(); refreshChapterList(); loadEditor(); renderPanel(); }
  function addChapter() { prep(); const n = S.ver.chapters.length + 1; S.ver.chapters.splice(S.chIdx + 1, 0, C.newChapter(`제${n}장`, '')); S.chIdx++; afterStructureChange(); $('#editor').focus(); }
  function moveChapter(d) { const j = S.chIdx + d; if (j < 0 || j >= S.ver.chapters.length) return; prep(); const a = S.ver.chapters; [a[S.chIdx], a[j]] = [a[j], a[S.chIdx]]; S.chIdx = j; afterStructureChange(); }
  async function deleteChapter() {
    if (S.ver.chapters.length < 2) { toast('장이 하나뿐이라 삭제할 수 없습니다.', 'err'); return; }
    processEditor(true); const ch = curCh(); const c = chCounts(ch);
    const ok = await askConfirm({ title: '장 삭제', danger: true, confirmText: '장 삭제', message: `“${ch.title || '제목 없음'}” (${fmt(c.withSpaces)}자)을(를) 현재 작업본에서 삭제합니다. 고정된 이전 버전에는 남아 있고, “작업 되돌리기”로도 복구할 수 있습니다.` });
    if (!ok) return;
    prep(); S.ver.chapters.splice(S.chIdx, 1); S.chIdx = Math.max(0, S.chIdx - 1); afterStructureChange(); toast('장을 삭제했습니다. (작업 되돌리기 가능)');
  }
  function splitChapter() {
    processEditor(true); const ta = $('#editor'); const k = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
    if (k <= 0) { toast('나눌 위치(두 번째 단락 이후)에 커서를 두세요.', 'err'); return; }
    prep(); const ch = curCh(); const moved = ch.paragraphs.splice(k);
    S.ver.chapters.splice(S.chIdx + 1, 0, { id: C.uid('c'), title: `제${S.ver.chapters.length + 1}장`, paragraphs: moved });
    S.chIdx++; afterStructureChange(); toast('커서가 있던 단락부터 새 장으로 나눴습니다.');
  }
  function mergeChapter() {
    if (S.chIdx === 0) { toast('첫 장은 앞 장이 없습니다.', 'err'); return; }
    prep(); const cur = S.ver.chapters.splice(S.chIdx, 1)[0]; S.chIdx--; const prev = curCh(); prev.paragraphs = prev.paragraphs.concat(cur.paragraphs);
    afterStructureChange(); toast('앞 장에 합쳤습니다. (작업 되돌리기 가능)');
  }
  function undo() {
    const s = S.undo.pop(); if (!s) return;
    if (s.id !== S.ver.id) { toast('다른 버전에서 한 작업은 되돌릴 수 없습니다.', 'err'); S.undo = []; refreshUndo(); return; }
    S.ver.chapters = JSON.parse(s.chapters); S.chIdx = Math.min(s.chIdx, S.ver.chapters.length - 1); S.cc = new Map();
    afterStructureChange(); refreshUndo(); toast('되돌렸습니다.');
  }

  function scrollToPos(ta, a, b) {
    const v = ta.value; ta.value = v.slice(0, a); ta.scrollTop = ta.scrollHeight; const st = ta.scrollTop; ta.value = v;
    ta.scrollTop = Math.max(0, st - ta.clientHeight / 3); ta.focus({ preventScroll: true }); ta.setSelectionRange(a, b);
    const r = ta.getBoundingClientRect(); if (r.top < 0 || r.top > innerHeight * 0.5) window.scrollTo({ top: window.scrollY + r.top - 120 });
  }
  async function jumpTo(ci, pi, start, end) {
    if (S.view !== 'write') { go('write'); }
    else processEditor(true);
    S.chIdx = ci; refreshChapterList(); loadEditor();
    const ch = curCh(); let off = 0; for (let i = 0; i < pi; i++) off += ch.paragraphs[i].text.length + 1;
    S.paraIdx = pi; scrollToPos($('#editor'), off + (start || 0), off + (end == null ? start || 0 : end)); renderPanel();
  }

  /* ── 보조 패널 ── */
  const TABS = [['para', '단락'], ['find', '찾기·바꾸기'], ['versions', '버전'], ['clean', '정리'], ['info', '작품 정보']];
  function renderTabs() {
    $('#tabs').replaceChildren(...TABS.map(([k, t]) => h('button', { role: 'tab', 'aria-selected': S.panelTab === k ? 'true' : 'false', onclick: () => { S.panelTab = k; renderTabs(); renderPanel(); } }, t)));
  }
  function renderPanel() {
    const pb = $('#panelbody'); if (!pb) return; pb.replaceChildren();
    ({ para: panelPara, find: panelFind, versions: panelVersions, clean: panelClean, info: panelInfo })[S.panelTab](pb);
  }
  function panelPara(pb) {
    const ch = curCh(), idx = Math.min(S.paraIdx, ch.paragraphs.length - 1), p = ch.paragraphs[idx];
    const locked = ch.paragraphs.map((q, i) => [q, i]).filter(([q]) => q.locked), memos = ch.paragraphs.map((q, i) => [q, i]).filter(([q]) => q.memo);
    const scenes = ch.paragraphs.filter((q) => C.isSceneBreak(q.text)).length;
    const item = ([q, i]) => h('div', { class: 'row hit', onclick: () => jumpTo(S.chIdx, i, 0, 0) }, h('div', { class: 'grow' }, h('div', { class: 'small muted' }, `${i + 1}번째 단락`), h('div', { class: 'ctx' }, (q.text.slice(0, 40) || '(빈 줄)') + (q.memo ? ' — ' + q.memo.slice(0, 40) : ''))));
    pb.append(h('div', { class: 'stack' },
      p ? h('div', { class: 'card stack', style: 'gap:8px' },
        h('div', { class: 'small muted' }, `현재 단락 ${idx + 1} / ${ch.paragraphs.length} · ${fmt(C.countNoSpaces(p.text))}자(공백 제외) · 출처: 작가 작성`),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: p.locked, onchange: (e) => { ensureEditable(); const q = curCh().paragraphs[idx]; q.locked = e.target.checked; markDirty(); refreshChapterList(); renderPanel(); } }), '이 단락 잠금'),
        h('div', { class: 'small muted' }, '잠금한 단락은 “찾기·바꾸기”에서 기본 제외되며, 이후 단계에서 추가될 AI 자동 작업도 바꾸지 않습니다. 직접 편집은 막지 않습니다.'),
        h('label', { class: 'fld' }, '단락 메모', (() => { const m = h('textarea', { class: 'field', rows: 3, 'aria-label': '단락 메모' }); m.value = p.memo || ''; m.addEventListener('input', () => { ensureEditable(); curCh().paragraphs[idx].memo = m.value; markDirty(); }); m.addEventListener('blur', () => renderPanel()); return m; })()),
        h('div', { class: 'small muted mono' }, 'ID ' + p.id)) : null,
      h('div', { class: 'card' }, h('h2', {}, '이 장'), h('dl', { class: 'kv' }, h('dt', {}, '단락'), h('dd', {}, fmt(ch.paragraphs.filter((q) => q.text.trim()).length) + '개'), h('dt', {}, '장면 구분선'), h('dd', {}, scenes + '개 (***, ◇◇◇ 등)'), h('dt', {}, '잠금'), h('dd', {}, locked.length + '개'), h('dt', {}, '메모'), h('dd', {}, memos.length + '개'))),
      locked.length ? h('div', {}, h('h2', { class: 'small muted' }, '잠금한 단락'), h('div', { class: 'list' }, locked.slice(0, 20).map(item))) : null,
      memos.length ? h('div', {}, h('h2', { class: 'small muted' }, '메모가 있는 단락'), h('div', { class: 'list' }, memos.slice(0, 20).map(item))) : null));
  }

  /* 찾기·바꾸기 */
  const mkey = (m) => `${m.paraId}:${m.start}:${m.end}`;
  function panelFind(pb) {
    const F = S.finder;
    const q = h('input', { type: 'search', value: F.q, placeholder: '찾을 말 (작품 전체)', 'aria-label': '찾을 말' });
    const r = h('input', { type: 'text', value: F.r, placeholder: '바꿀 말 (비우면 삭제)', 'aria-label': '바꿀 말' });
    const cs = h('input', { type: 'checkbox', checked: F.cs });
    const run = () => { processEditor(true); F.q = q.value; F.r = r.value; F.cs = cs.checked; F.matches = C.findAll(S.ver, F.q, { caseSensitive: F.cs }); F.checked = new Set(F.matches.map((m, i) => (m.locked ? null : i)).filter((i) => i != null)); renderPanel(); };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    const res = [];
    if (F.matches) {
      const ms = F.matches, nChk = F.checked.size;
      res.push(h('div', { class: 'small muted' }, ms.length ? `${ms.length >= 3000 ? '3000+' : ms.length}곳 발견 · ${nChk}곳 선택됨` + (ms.some((m) => m.locked) ? ' · 잠금 단락은 기본 제외' : '') : '찾는 말이 없습니다.'));
      if (ms.length) {
        res.push(h('div', { class: 'btn-row' }, h('button', { class: 'btn sm', onclick: () => { F.checked = new Set(ms.map((_, i) => i)); renderPanel(); } }, '모두 선택'), h('button', { class: 'btn sm', onclick: () => { F.checked = new Set(); renderPanel(); } }, '선택 해제'),
          h('button', { class: 'btn sm primary', disabled: !nChk, onclick: () => doReplace() }, `선택한 ${nChk}곳 바꾸기`)));
        res.push(h('div', { class: 'list' }, ms.slice(0, 300).map((m, i) => h('div', { class: 'row hit', onclick: (e) => { if (e.target.tagName !== 'INPUT') jumpTo(m.chapterIndex, m.paraIndex, m.start, m.end); } },
          h('input', { type: 'checkbox', 'aria-label': '선택', checked: F.checked.has(i), onchange: (e) => { e.target.checked ? F.checked.add(i) : F.checked.delete(i); renderPanel(); } }),
          h('div', { class: 'grow' }, h('div', { class: 'small muted' }, `${S.ver.chapters[m.chapterIndex].title || '장 ' + (m.chapterIndex + 1)} · ${m.paraIndex + 1}번째 단락` + (m.locked ? ' · 잠금' : '')), h('div', { class: 'ctx' }, m.before, h('mark', {}, m.hit), m.after))))));
        if (ms.length > 300) res.push(h('div', { class: 'small muted' }, '처음 300곳만 표시합니다. 찾는 말을 더 구체적으로 입력하세요.'));
      }
    }
    pb.append(h('div', { class: 'stack' }, h('div', { class: 'stack', style: 'gap:8px' }, q, r, h('label', { class: 'chk' }, cs, '대소문자 구분'), h('button', { class: 'btn primary', onclick: run }, '찾기')), res));
    async function doReplace() {
      processEditor(true);
      const fresh = C.findAll(S.ver, F.q, { caseSensitive: F.cs }), fk = new Set(fresh.map(mkey));
      const picked = F.matches.filter((m, i) => F.checked.has(i)), valid = picked.filter((m) => fk.has(mkey(m)));
      if (!valid.length) { toast('선택한 위치가 이미 바뀌었습니다. 다시 찾아 주세요.', 'err'); return; }
      const lockedHit = valid.filter((m) => m.locked).length;
      if (lockedHit && !(await askConfirm({ title: '잠금 단락 포함', message: `선택한 곳 중 ${lockedHit}곳이 잠금 단락입니다. 그래도 바꿀까요?`, confirmText: '바꾸기' }))) return;
      prep(); const n = C.replaceMatches(S.ver, valid.map((m) => ({ paraId: m.paraId, start: m.start, end: m.end })), F.r);
      F.matches = null; afterStructureChange(); toast(`${n}곳을 바꿨습니다. (작업 되돌리기 가능)` + (picked.length > valid.length ? ` ${picked.length - valid.length}곳은 이미 바뀌어 건너뜀.` : ''));
    }
  }

  /* 정리 */
  const cleanOpts = { nfc: true, specialSpaces: true, trailing: true, quotes: 'keep', ellipsis: 'keep', blankLines: 'keep', scope: 'chapter' };
  function panelClean(pb) {
    const o = cleanOpts, out = h('div', { class: 'stack' });
    const sel = (key, opts, label) => h('label', { class: 'fld' }, label, h('select', { onchange: (e) => { o[key] = e.target.value; out.replaceChildren(); } }, opts.map(([v, t]) => h('option', { value: v, selected: o[key] === v }, t))));
    const chk = (key, label) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: o[key], onchange: (e) => { o[key] = e.target.checked; out.replaceChildren(); } }), label);
    const targets = () => (o.scope === 'all' ? S.ver.chapters : [curCh()]);
    const compute = () => { processEditor(true); const rep = {}; let chg = 0; const res = targets().map((ch) => { const r = C.cleanText(C.chapterText(ch), o); for (const k in r.report) rep[k] = (rep[k] || 0) + r.report[k]; if (r.changed) chg++; return r; }); return { rep, chg, res }; };
    pb.append(h('div', { class: 'stack' },
      h('div', { class: 'small muted' }, '붙여넣은 원고의 특수 공백·따옴표·빈 줄을 정리합니다. 먼저 미리보기로 확인하세요.'),
      chk('nfc', '자모 결합(NFC) 정규화'), chk('specialSpaces', '특수 공백·폭 없는 문자 정리'), chk('trailing', '줄 끝 공백 제거'),
      sel('quotes', [['keep', '그대로'], ['curly', '“ ” ‘ ’ 로 통일'], ['straight', '" \' 로 통일']], '따옴표'),
      sel('ellipsis', [['keep', '그대로'], ['char', '… 로 통일'], ['dots', '... 로 통일']], '말줄임표'),
      sel('blankLines', [['keep', '그대로'], ['collapse', '연속된 빈 줄을 하나로'], ['remove', '모든 빈 줄 제거']], '빈 줄'),
      sel('scope', [['chapter', '현재 장만'], ['all', '작품 전체']], '범위'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => { const { rep, chg } = compute(); out.replaceChildren(Object.keys(rep).length ? h('div', { class: 'banner info' }, `${chg}개 장에서 바뀝니다: ` + Object.entries(rep).map(([k, n]) => `${k} ${fmt(n)}`).join(', ')) : h('div', { class: 'muted' }, '바꿀 내용이 없습니다.')); } }, '미리보기'),
        h('button', { class: 'btn primary', onclick: () => {
          const { rep, chg, res } = compute(); if (!chg) { out.replaceChildren(h('div', { class: 'muted' }, '바꿀 내용이 없습니다.')); return; }
          prep(); const t = targets(); t.forEach((ch, i) => { if (res[i].changed) ch.paragraphs = C.reconcileParagraphs(ch.paragraphs, res[i].text); });
          afterStructureChange(); toast(`${chg}개 장을 정리했습니다. (작업 되돌리기 가능)`); out.replaceChildren(h('div', { class: 'muted' }, '적용: ' + Object.entries(rep).map(([k, n]) => `${k} ${fmt(n)}`).join(', ')));
        } }, '적용')),
      out));
  }

  /* 작품 정보 */
  function panelInfo(pb) {
    const w = S.work;
    const save = () => { clearTimeout(workTimer); workTimer = setTimeout(async () => { w.updatedAt = C.nowIso(); try { await S.storage.putWork(w); } catch (e) { toast('작품 정보를 저장하지 못했습니다.', 'err'); } $('#worktitle').textContent = w.title; }, 500); };
    const txt = (k, label, rows) => { const el = rows ? h('textarea', { class: 'field', rows, 'aria-label': label }) : h('input', { type: 'text', 'aria-label': label }); el.value = w[k] || ''; el.addEventListener('input', () => { w[k] = el.value; save(); }); return h('label', { class: 'fld' }, label, el); };
    const sel = (k, label, opts) => h('label', { class: 'fld' }, label, h('select', { onchange: (e) => { w[k] = e.target.value; save(); } }, opts.map((o) => h('option', { value: o, selected: w[k] === o }, o))));
    const names = h('input', { type: 'text', 'aria-label': '주요 등장인물', placeholder: '쉼표로 구분: 정숙, 용석' }); names.value = (w.names || []).join(', ');
    names.addEventListener('input', () => { w.names = names.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean); save(); });
    pb.append(h('div', { class: 'stack' }, txt('title', '작품명'), h('div', { class: 'grid2' }, sel('genre', '장르', GENRES), sel('status', '집필 상태', STATUSES)),
      h('label', { class: 'fld' }, '주요 등장인물 (문체 통계의 인물 등장 분석에 쓰입니다)', names), txt('synopsis', '줄거리', 4), txt('setting', '핵심 설정', 3), txt('todo', '집필하면서 확인할 사항', 3), txt('memo', '수정 메모', 3), txt('styleGuide', '문체 지침 (AI 작업에 쓰임. 비워 두면 “한국적 현실주의” 기본값)', 5),
      h('div', { class: 'grid2' }, txt('penName', '필명 (응모 점검용)'), txt('realName', '본명 (응모 점검용)')),
      NSApp.profileSelect ? NSApp.profileSelect(w, save) : null,
      h('div', { class: 'small muted' }, `AI 기여 비율(현재 버전, 글자 수 기준 대략): ${Math.round(C.aiShare(S.ver) * 100)}%`),
      h('div', { class: 'small muted' }, `만든 날 ${fmtDate(w.createdAt)} · 수정 ${fmtDate(w.updatedAt)}`)));
  }

  /* 버전 */
  async function panelVersions(pb) {
    const kind = h('select', { 'aria-label': '버전 종류' }, KINDS.map((k) => h('option', { value: k }, k)));
    const label = h('input', { type: 'text', placeholder: '이름 (비우면 종류 이름)', 'aria-label': '버전 이름' });
    const note = h('input', { type: 'text', placeholder: '메모 (선택)', 'aria-label': '버전 메모' });
    const list = h('div', { class: 'list' });
    pb.append(h('div', { class: 'stack' },
      h('div', { class: 'card stack', style: 'gap:8px' }, h('h2', {}, '지금 상태를 버전으로 고정'),
        S.ver.frozen ? h('div', { class: 'small muted' }, `현재 “${S.ver.label}”은(는) 이미 고정되어 있습니다. 글을 고친 뒤 저장하면 새 버전이 됩니다.`) : [h('div', { class: 'grid2' }, kind, label), note,
          h('button', { class: 'btn primary', onclick: async () => {
            processEditor(true);
            S.ver.kind = kind.value; S.ver.label = label.value.trim() || kind.value; S.ver.note = note.value.trim(); S.ver.frozen = true;
            markDirty(); await saveNow(); renderBanner(); refreshCounts(); renderPanel(); toast(`“${S.ver.label}”로 고정했습니다. 이후 편집은 새 작업본에서 이뤄집니다.`);
          } }, '버전 고정')]),
      h('div', { class: 'small muted' }, '버전은 나무 구조입니다. 고정된 버전은 절대 바뀌지 않고, 열어서 고치면 새 작업본이 갈라져 나옵니다.'), list));
    const metas = await S.storage.listVersionMeta(S.work.id); S.versions = metas;
    const kids = new Map(); metas.forEach((m) => { const k = m.parentId && metas.some((x) => x.id === m.parentId) ? m.parentId : ''; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(m); });
    kids.forEach((a) => a.sort((x, y) => x.createdAt.localeCompare(y.createdAt)));
    const rows = []; const walk = (pid, d) => (kids.get(pid) || []).forEach((m) => { rows.push([m, d]); walk(m.id, d + 1); }); walk('', 0);
    list.replaceChildren(...rows.map(([m, d]) => {
      const cur = m.id === S.ver.id;
      return h('div', { class: 'row' + (cur ? ' cur' : ''), style: `margin-left:${Math.min(d, 5) * 12}px` },
        h('div', { class: 'grow' }, h('div', { class: 't' }, m.label, ' ', h('span', { class: 'pill' }, m.kind), m.frozen ? h('span', { class: 'pill accent', style: 'margin-left:4px' }, '고정') : h('span', { class: 'pill warn', style: 'margin-left:4px' }, '작업 중'), cur ? h('span', { class: 'pill', style: 'margin-left:4px' }, '현재') : null, m.ai ? h('span', { class: 'pill', style: 'margin-left:4px' }, 'AI' + (m.aiChars ? ' ' + Math.round(m.aiChars * 100) + '%' : '')) : null, m.ai && m.ai.status !== 'complete' ? h('span', { class: 'pill warn', style: 'margin-left:4px' }, m.ai.status === 'partial' ? '미완성' : '일부 미처리') : null),
          h('div', { class: 'small muted mono' }, `${fmtDate(m.updatedAt)} · ${m.stats ? fmt(m.stats.withSpaces) + '자' : '-'}` + (m.note ? ' · ' + m.note : ''))),
        h('div', { class: 'btn-row', style: 'flex-wrap:nowrap' },
          cur ? null : h('button', { class: 'btn sm', onclick: () => openVersion(m.id) }, '열기'),
          cur ? null : h('button', { class: 'btn sm', onclick: () => { S.cmpA = m.id; S.cmpB = S.ver.id; go('compare'); } }, '비교'),
          h('button', { class: 'btn sm', onclick: () => renameVersion(m) }, '이름'),
          cur ? null : h('button', { class: 'btn sm danger', onclick: () => deleteVersion(m, metas) }, '삭제')));
    }));
  }
  async function openVersion(id) {
    await flushAndSave(); const v = await S.storage.getVersion(id); if (!v) { toast('버전을 불러오지 못했습니다.', 'err'); return; }
    S.ver = v; S.work.currentVersionId = id; S.cc = new Map(); S.undo = []; S.chIdx = 0; S.dirty = false; S.work.cursor = {}; await S.storage.putWork(S.work); render(); toast(`“${v.label}” 버전을 열었습니다.`);
  }
  async function renameVersion(m) {
    const inp = h('input', { type: 'text', value: m.label, 'aria-label': '새 이름' });
    modal({ title: '버전 이름 바꾸기', body: h('label', { class: 'fld' }, '이름', inp), actions: (close) => [h('button', { class: 'btn', onclick: () => close() }, '취소'), h('button', { class: 'btn primary', onclick: async () => {
      const name = inp.value.trim() || m.label; close();
      if (m.id === S.ver.id) { S.ver.label = name; markDirty(); await saveNow(); refreshCounts(); } else { const v = await S.storage.getVersion(m.id); v.label = name; await S.storage.putVersion(v); }
      renderPanel();
    } }, '바꾸기')] });
  }
  async function deleteVersion(m, metas) {
    const children = metas.filter((x) => x.parentId === m.id);
    const ok = await askConfirm({ title: '버전 삭제', danger: true, confirmText: '버전 삭제', typeToConfirm: m.label,
      message: `“${m.label}” 버전을 영구 삭제합니다.` + (children.length ? ` 여기서 갈라진 버전 ${children.length}개는 한 단계 위 버전에 이어 붙습니다.` : '') + (m.kind === '원문' ? ' 이 버전은 “원문”입니다. 삭제하면 처음 상태로 돌아갈 방법이 없어집니다.' : '') });
    if (!ok) return;
    for (const c of children) { const v = await S.storage.getVersion(c.id); v.parentId = m.parentId || null; await S.storage.putVersion(v); }
    await S.storage.deleteVersion(m.id); renderPanel(); toast('버전을 삭제했습니다.');
  }

  /* ───────────── 버전 비교 ───────────── */
  async function renderCompare(main) {
    await flushAndSave();
    const metas = await S.storage.listVersionMeta(S.work.id); S.versions = metas;
    metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!S.cmpB || !metas.some((m) => m.id === S.cmpB)) S.cmpB = S.ver.id;
    if (!S.cmpA || !metas.some((m) => m.id === S.cmpA)) { const curM = metas.find((m) => m.id === S.cmpB); S.cmpA = (curM && curM.parentId && metas.some((m) => m.id === curM.parentId)) ? curM.parentId : (metas.find((m) => m.id !== S.cmpB) || {}).id; }
    const selOf = (key, label) => h('label', { class: 'fld' }, label, h('select', { 'aria-label': label, onchange: (e) => { S[key] = e.target.value; render(); } }, metas.map((m) => h('option', { value: m.id, selected: S[key] === m.id }, `${m.label} · ${m.kind}${m.frozen ? ' · 고정' : ''} · ${fmtDate(m.createdAt)}`))));
    const only = { v: true }, out = h('div', {});
    main.append(h('div', { class: 'page-head' }, h('h1', {}, '버전 비교'), h('div', { class: 'small muted' }, '왼쪽이 이전, 오른쪽이 이후입니다.')),
      h('div', { class: 'grid2', style: 'margin-bottom:12px' }, selOf('cmpA', '이전 버전 (A)'), selOf('cmpB', '이후 버전 (B)')), out);
    if (metas.length < 2 || !S.cmpA) { out.append(h('div', { class: 'card empty' }, '비교하려면 버전이 둘 이상 필요합니다. 집필 공간의 “버전” 탭에서 현재 상태를 고정한 뒤 글을 고치면 새 작업본이 생깁니다.')); return; }
    const load = async (id) => (id === S.ver.id ? S.ver : S.storage.getVersion(id));
    const [A, B] = await Promise.all([load(S.cmpA), load(S.cmpB)]);
    if (!A || !B) { out.append(h('div', { class: 'banner danger' }, '버전을 불러오지 못했습니다.')); return; }
    const d = C.diffVersions(A, B);
    const ta = C.aggregateCounts(A.chapters.map((c) => C.countText(C.chapterText(c), S.work.sheet)), S.work.sheet), tb = C.aggregateCounts(B.chapters.map((c) => C.countText(C.chapterText(c), S.work.sheet)), S.work.sheet);
    const delta = tb.withSpaces - ta.withSpaces;
    const canRevert = true;
    const revertRow = async (kind, r) => {
      let target;
      if (B.id === S.ver.id) { if (S.ver.frozen) { ensureEditable(); S.cmpB = S.ver.id; } target = S.ver; }
      else if (B.frozen) {
        let n = metas.filter((m) => m.kind === '작업본').length + 1; while (metas.some((m) => m.label === '작업본 ' + n)) n++;
        target = C.makeVersion({ workId: S.work.id, parentId: B.id, label: '작업본 ' + n, kind: '작업본', note: '비교 화면에서 단락을 되돌림', chapters: C.cloneChapters(B.chapters) });
        S.cmpB = target.id; toast(`“${B.label}”은(는) 그대로 두고 새 작업본(${target.label})에 반영합니다.`);
      } else target = B;
      const findPara = (id) => { for (const ch of target.chapters) { const i = ch.paragraphs.findIndex((p) => p.id === id); if (i >= 0) return [ch, i]; } return null; };
      if (kind === 'mod') { const f = findPara(r.b.id); if (f) { f[0].paragraphs[f[1]] = Object.assign({}, f[0].paragraphs[f[1]], { text: r.a.text, source: 'author' }); } }
      else if (kind === 'add') { const f = findPara(r.b.id); if (f) { f[0].paragraphs.splice(f[1], 1); if (!f[0].paragraphs.length) f[0].paragraphs.push(C.newParagraph('')); } }
      else if (kind === 'del') {
        const aCh = A.chapters.find((c) => c.id === r.a.chapterId) || A.chapters[r.a.chapterIndex];
        const tCh = target.chapters.find((c) => c.id === (aCh && aCh.id)) || target.chapters[Math.min(r.a.chapterIndex, target.chapters.length - 1)];
        const ai = aCh.paragraphs.findIndex((p) => p.id === r.a.id); let at = 0;
        for (let k = ai - 1; k >= 0; k--) { const j = tCh.paragraphs.findIndex((p) => p.id === aCh.paragraphs[k].id); if (j >= 0) { at = j + 1; break; } }
        tCh.paragraphs.splice(at, 0, Object.assign({}, aCh.paragraphs[ai]));
      }
      S.cc = new Map();
      if (target === S.ver) { markDirty(); await saveNow(); } else await S.storage.putVersion(target);
      render();
    };
    const drawBody = () => {
      const grid = h('div', { class: 'diff' }, h('div', { class: 'h' }, `A · ${A.label}`), h('div', { class: 'h' }, `B · ${B.label}`));
      let shown = 0, run = 0, lastChap = null;
      const flushRun = () => { if (run) { grid.append(h('div', { class: 'skip' }, `변경 없는 단락 ${run}개`)); run = 0; } };
      for (const r of d.rows) {
        if (only.v && r.type === 'same') { run++; continue; }
        if (!only.v && r.type === 'same' && (r.a.text || '').trim() === '') continue;
        flushRun();
        if (shown >= 500) { grid.append(h('div', { class: 'skip' }, '표시 한도(500개)를 넘었습니다. 나머지는 생략되었습니다.')); break; }
        const chapName = (r.b || r.a).chapterTitle || `장 ${(r.b || r.a).chapterIndex + 1}`;
        if (chapName !== lastChap) { grid.append(h('div', { class: 'chap' }, chapName)); lastChap = chapName; }
        let L, R;
        if (r.type === 'mod') {
          const segs = C.inlineDiff(r.a.text, r.b.text);
          L = h('div', { class: 'c l mod' }, segs.filter((s) => s.t !== 'ins').map((s) => (s.t === 'del' ? h('span', { class: 'd' }, s.s) : s.s)));
          R = h('div', { class: 'c r mod' }, segs.filter((s) => s.t !== 'del').map((s) => (s.t === 'ins' ? h('span', { class: 'i' }, s.s) : s.s)));
        } else if (r.type === 'del') { L = h('div', { class: 'c l del' }, r.a.text || '(빈 줄)'); R = h('div', { class: 'c r' }, h('span', { class: 'empty-cell' }, '삭제됨')); }
        else if (r.type === 'add') { L = h('div', { class: 'c l' }, h('span', { class: 'empty-cell' }, '없음')); R = h('div', { class: 'c r add' }, r.b.text || '(빈 줄)'); }
        else { L = h('div', { class: 'c l' }, r.a.text); R = h('div', { class: 'c r' }, r.b.text); }
        if (canRevert) {
          const act = (label, fn) => h('div', { style: 'margin-top:6px' }, h('button', { class: 'btn sm', onclick: fn }, label));
          if (r.type === 'mod') R.append(act('이 단락을 A(이전)로 되돌리기', () => revertRow('mod', r)));
          else if (r.type === 'add') R.append(act('이 단락 삭제', () => revertRow('add', r)));
          else if (r.type === 'del') L.append(act('삭제된 단락 복원', () => revertRow('del', r)));
        }
        grid.append(L, R); shown++;
      }
      flushRun();
      if (!shown && only.v) grid.append(h('div', { class: 'skip' }, '두 버전의 내용이 같습니다.'));
      return grid;
    };
    const body = h('div', {}, drawBody());
    out.append(
      h('div', { class: 'card', style: 'margin-bottom:12px' }, h('div', { class: 'btn-row', style: 'justify-content:space-between' },
        h('div', { class: 'btn-row' }, h('span', { class: 'pill' }, `같음 ${d.summary.same}`), h('span', { class: 'pill warn' }, `수정 ${d.summary.mod}`), h('span', { class: 'pill accent' }, `추가 ${d.summary.add}`), h('span', { class: 'pill', style: 'background:var(--del-bg);color:var(--del-fg)' }, `삭제 ${d.summary.del}`),
          h('span', { class: 'small muted mono' }, `공백 포함 ${fmt(ta.withSpaces)} → ${fmt(tb.withSpaces)}자 (${delta >= 0 ? '+' : ''}${fmt(delta)}) · ${ta.sheets} → ${tb.sheets}매`)),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { only.v = e.target.checked; body.replaceChildren(drawBody()); } }), '변경된 단락만 보기')),
        d.byText ? h('div', { class: 'small muted', style: 'margin-top:6px' }, '두 버전이 같은 원고에서 갈라진 것이 아니어서, 단락 내용이 같은 것끼리 맞춰 비교했습니다.') : null),
      body);
  }

  /* ───────────── 문체 통계 ───────────── */
  const statOpts = { custom: '것이다, 마치, 처럼' };
  function renderStats(main) {
    processEditor(true);
    const out = h('div', { class: 'stack' }), custom = h('input', { type: 'text', value: statOpts.custom, 'aria-label': '경계 표현' });
    const chars = C.versionText(S.ver).length;
    main.append(h('div', { class: 'page-head' }, h('h1', {}, '문체 통계'), h('div', { class: 'small muted' }, '대상: ' + S.ver.label)),
      h('div', { class: 'card stack', style: 'margin-bottom:14px' },
        h('div', { class: 'muted' }, 'AI를 쓰지 않고 이 기기에서 바로 계산합니다. 단어·어미 분석은 형태소 분석이 아닌 단순 규칙 기반의 근사치이므로, 참고용으로 보세요.'),
        h('label', { class: 'fld' }, '점검할 표현 (쉼표로 구분, 작가가 경계하는 습관적 표현)', custom),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: () => run() }, '분석 실행'), h('span', { class: 'small muted' }, `${fmt(chars)}자`))), out);
    function run() {
      statOpts.custom = custom.value; out.replaceChildren(h('div', { class: 'muted' }, '분석 중…'));
      setTimeout(() => {
        const names = S.work.names || [];
        const r = C.styleStats(S.ver, { names, custom: custom.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) });
        const priv = C.privacyScan(S.ver, [S.work.penName, S.work.realName].filter(Boolean));
        out.replaceChildren(...statsCards(r, priv, names));
      }, 30);
    }
    if (chars < 80000) run();
  }
  function statsCards(r, priv, names) {
    const jump = (ci, pi, label, sub) => h('div', { class: 'row hit jump', onclick: () => jumpTo(ci, pi, 0, 0) }, h('div', { class: 'grow' }, h('div', { class: 'small muted' }, `${label}`), h('div', { class: 'ctx' }, sub)));
    const barList = (arr, max, alt) => h('div', { class: 'bars' }, arr.map(([k, n]) => h('div', { class: 'bar' + (alt ? ' alt' : '') }, h('span', {}, k), h('i', { style: `width:${Math.max(1, (n / max) * 100)}%` }), h('span', { class: 'mono' }, fmt(n)))));
    const maxH = Math.max(1, ...r.hist.map((x) => x.n));
    const where = (c) => `${c.chapterTitle || '장 ' + (c.chapterIndex + 1)} · ${c.paraIndex + 1}번째 단락`;
    return [
      h('div', { class: 'cols' },
        h('div', { class: 'card' }, h('h2', {}, '요약'), h('dl', { class: 'kv' }, h('dt', {}, '문장 수'), h('dd', {}, fmt(r.sentenceCount)), h('dt', {}, '문장 평균 길이'), h('dd', {}, r.avgLen + '자 (공백 제외)'), h('dt', {}, '문장 길이 중앙값'), h('dd', {}, r.medianLen + '자'), h('dt', {}, '대화 비율'), h('dd', {}, (r.dialogRatio * 100).toFixed(1) + '%'))),
        h('div', { class: 'card' }, h('h2', {}, '문장 길이 분포'), h('div', { class: 'bars' }, r.hist.map((x) => h('div', { class: 'bar' }, h('span', {}, x.hi === Infinity ? `${x.lo}자 이상` : `${x.lo}–${x.hi}자`), h('i', { style: `width:${Math.max(1, (x.n / maxH) * 100)}%` }), h('span', { class: 'mono' }, fmt(x.n))))))),
      h('div', { class: 'cols' },
        h('div', { class: 'card' }, h('h2', {}, '짧은 문장이 이어진 문단'), h('div', { class: 'small muted', style: 'margin-bottom:8px' }, '12자 이하 문장이 4번 이상 연속된 곳입니다. 리듬이 단조로운지 눈으로 확인해 보세요. 의도한 속도감이면 그대로 두면 됩니다.'),
          r.shortRuns.length ? h('div', { class: 'list' }, r.shortRuns.slice(0, 25).map((x) => jump(x.chapterIndex, x.paraIndex, `${where(x)} · ${x.count}문장 연속`, x.sample))) : h('div', { class: 'muted' }, '없습니다.')),
        h('div', { class: 'card' }, h('h2', {}, '짧게 끊긴 대사가 이어진 곳'), h('div', { class: 'small muted', style: 'margin-bottom:8px' }, '24자 이하의 대사만 6줄 이상 연속된 구간입니다(문답식 대화 후보).'),
          r.dialogRuns.length ? h('div', { class: 'list' }, r.dialogRuns.slice(0, 25).map((x) => jump(x.chapterIndex, x.paraIndex, `${where(x)} · ${x.count}줄 연속`, x.sample))) : h('div', { class: 'muted' }, '없습니다.'))),
      h('div', { class: 'cols' },
        h('div', { class: 'card' }, h('h2', {}, '가까운 거리의 단어 반복'), h('div', { class: 'small muted', style: 'margin-bottom:8px' }, '300자 안에서 같은 단어가 3번 이상 나온 곳입니다.'),
          r.nearRepeats.length ? h('div', { class: 'list' }, r.nearRepeats.map((x) => jump(x.chapterIndex, x.paraIndex, `${where(x)}`, `“${x.word}” ${x.count}회`))) : h('div', { class: 'muted' }, '없습니다.')),
        h('div', { class: 'card' }, h('h2', {}, '표현 점검'), Object.keys(r.custom).length ? h('div', { class: 'list' }, Object.entries(r.custom).map(([k, v]) => h('div', {}, h('div', { class: 'row' }, h('b', {}, `“${k}”`), h('span', { class: 'mono' }, v.count + '회')), v.where.slice(0, 5).map((c) => jump(c.chapterIndex, c.paraIndex, where(c), '')) ))) : h('div', { class: 'muted' }, '점검할 표현이 없습니다.'))),
      h('div', { class: 'cols' },
        h('div', { class: 'card' }, h('h2', {}, '자주 쓴 단어 (조사 제거 근사)'), r.topWords.length ? barList(r.topWords.slice(0, 15), r.topWords[0][1]) : h('div', { class: 'muted' }, '없습니다.')),
        h('div', { class: 'card' }, h('h2', {}, '문장 끝 글자 (지문 문장)'), r.topEndings.length ? barList(r.topEndings, r.topEndings[0][1], true) : h('div', { class: 'muted' }, '없습니다.'))),
      h('div', { class: 'card' }, h('h2', {}, '장별 대화 비율' + (names.length ? ' · 인물 등장 횟수' : '')), names.length ? null : h('div', { class: 'small muted', style: 'margin-bottom:6px' }, '“작품 정보”에 주요 등장인물을 적으면 장별 등장 횟수도 볼 수 있습니다.'),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl', style: 'min-width:0' }, h('thead', {}, h('tr', {}, h('th', {}, '장'), h('th', { class: 'num' }, '공백 제외'), h('th', { class: 'num' }, '대화'), names.map((n) => h('th', { class: 'num' }, n)))),
          h('tbody', {}, r.chapters.map((c) => h('tr', {}, h('td', {}, c.title || '장 ' + (c.index + 1)), h('td', { class: 'num' }, fmt(c.noSpaces)), h('td', { class: 'num' }, (c.dialogRatio * 100).toFixed(0) + '%'), names.map((n) => h('td', { class: 'num', style: c.nameCounts[n] === 0 ? 'color:var(--warn-fg);background:var(--warn-bg)' : '' }, String(c.nameCounts[n]))))))))),
      h('div', { class: 'card' }, h('h2', {}, '응모 전 점검 — 본문 속 신상 정보'), h('div', { class: 'small muted', style: 'margin-bottom:8px' }, '전화번호·이메일·주민등록번호·주소 형태와, “작품 정보”에 적은 필명·본명을 본문에서 찾습니다. 완벽하지 않으니 마지막에는 직접 읽어 보세요.'),
        priv.length ? h('div', { class: 'list' }, priv.slice(0, 40).map((x) => jump(x.chapterIndex, x.paraIndex, `${x.label} · ${where(x)}`, x.hit))) : h('div', { class: 'muted' }, '발견되지 않았습니다.')),
    ];
  }

  /* ───────────── 설정·백업 ───────────── */
  async function renderSettings(main) {
    if (S.work) await flushAndSave();
    const w = S.work, est = await S.storage.estimate(), pers = await S.storage.persisted();
    main.append(h('div', { class: 'page-head' }, h('h1', {}, '설정·백업')), h('div', { class: 'cols' },
      w ? sheetCard(w) : null,
      h('div', { class: 'card stack' }, h('h2', {}, '저장소'),
        h('dl', { class: 'kv' }, h('dt', {}, '저장 위치'), h('dd', {}, S.storage.kind === 'indexeddb' ? '이 브라우저 안(IndexedDB) — 이 기기·이 브라우저에서만 보입니다' : '저장되지 않음(메모리)'),
          h('dt', {}, '영구 저장'), h('dd', {}, S.storage.kind === 'indexeddb' ? (pers ? '허용됨' : '브라우저가 용량 부족 때 지울 수 있음') : '해당 없음'),
          h('dt', {}, '사용량'), h('dd', {}, est ? `${(est.usage / 1048576).toFixed(2)} MB / ${(est.quota / 1048576).toFixed(0)} MB` : '알 수 없음'),
          h('dt', {}, '마지막 백업'), h('dd', {}, S.lastBackup ? fmtDate(S.lastBackup) : '없음')),
        S.storage.kind === 'indexeddb' && !pers ? h('button', { class: 'btn', onclick: async () => { const ok = await S.storage.requestPersist(); toast(ok ? '영구 저장이 허용되었습니다.' : '브라우저가 허용하지 않았습니다. 백업을 자주 받아 두세요.'); render(); } }, '영구 저장 요청') : null,
        h('div', { class: 'small muted' }, '이 앱은 다른 기기와 동기화되지 않습니다. 이 기기의 브라우저 데이터를 지우면 원고도 사라지므로, 정기적으로 JSON 백업을 받아 보관하세요. 편집·계산·비교·문체 통계는 이 기기 안에서만 처리됩니다. 단, “AI 작업”을 실행하면 해당 원고와 설정이 Claude로 전송되어 처리됩니다.')),
      h('div', { class: 'card stack' }, h('h2', {}, '백업과 복원'),
        h('div', { class: 'small muted' }, 'JSON 백업에는 모든 작품의 작품 정보, 전체 버전(원문·고정본·작업본), 단락 잠금·메모가 들어 있습니다. 불러올 때는 기존 작품을 덮어쓰지 않고 추가합니다. AI 작업의 결과 버전과 심사 기록은 작품에 들어 있어 함께 백업되지만, 작업 목록(호출 기록)은 백업에 포함되지 않습니다.'),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: async () => { await exportBackup(null); render(); } }, '전체 백업 내려받기'), w ? h('button', { class: 'btn', onclick: () => exportBackup(w.id) }, '이 작품만 백업') : null, h('button', { class: 'btn', onclick: () => pickFile('.json,application/json', restoreBackup) }, '백업 불러오기'))),
      ...(NSApp.hooks.settings || []).map((fn) => fn()),
      h('div', { class: 'card stack' }, h('h2', {}, '이 버전에서 제공하지 않는 것'),
        h('ul', { class: 'small muted', style: 'margin:0;padding-left:18px' }, ['AI 교열 단독 실행, 장면별 AI 작업실, 장르 전환, 결말 재구성 (다음 단계)', '인물·설정 관리 화면, 역사 고증, 공모전 관리, 문체 프로필 화면 (다음 단계)', '다른 기기와의 동기화, 계정, 클라우드 저장', 'HWP(구형) 파일 읽기 — HWPX·DOCX·TXT로 저장해 올려 주세요', '한글(HWPX) 내보내기 — DOCX로 내보낸 뒤 한글에서 열 수 있습니다'].map((t) => h('li', {}, t))))));
  }
  function sheetCard(w) {
    const o = C.sheetSettings(w.sheet), box = h('div', {});
    const apply = async () => { S.cc = new Map(); const t = totalCounts(); w.counts = Object.assign({}, w.counts, { withSpaces: t.withSpaces, noSpaces: t.noSpaces, sheets: t.sheets, simple: t.simple, grid: t.grid }); await S.storage.putWork(w); draw(); };
    const num = (k, label, min, max) => h('label', { class: 'fld' }, label, h('input', { type: 'number', min, max, value: o[k], onchange: (e) => { w.sheet[k] = Math.min(max, Math.max(min, parseInt(e.target.value, 10) || o[k])); Object.assign(o, C.sheetSettings(w.sheet)); apply(); } }));
    const rad = (k, v, t) => h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'sheet-' + k, checked: o[k] === v, onchange: () => { w.sheet[k] = v; Object.assign(o, C.sheetSettings(w.sheet)); apply(); } }), t);
    function draw() {
      const t = totalCounts();
      box.replaceChildren(h('dl', { class: 'kv' },
        h('dt', {}, '공백 포함'), h('dd', {}, fmt(t.withSpaces) + '자'), h('dt', {}, '공백 제외'), h('dd', {}, fmt(t.noSpaces) + '자'),
        h('dt', {}, '단순 환산'), h('dd', {}, `공백 포함 ${t.simple.withSpaces}매 · 공백 제외 ${t.simple.noSpaces}매`),
        h('dt', {}, '원고지 모사'), h('dd', {}, `${t.grid.lines}줄 → ${t.grid.sheets}매 (올림 ${t.grid.sheetsCeil}매)`),
        h('dt', {}, '현재 기준'), h('dd', {}, h('b', {}, t.sheets + '매'), ' — ' + t.sheetLabel)));
    }
    draw();
    return h('div', { class: 'card stack' }, h('h2', {}, `원고지 계산 — ${w.title}`),
      h('div', { class: 'small muted' }, '공모전은 요강에 적힌 계산 기준을 따르세요. 두 방식의 결과가 다르면 요강을 확인하고 맞는 쪽을 고르면 됩니다.'),
      h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'small muted' }, '매수 방식'), rad('mode', 'simple', '단순 환산: 글자 수 ÷ (한 줄 칸 수 × 한 면 줄 수)'), rad('mode', 'grid', '원고지 모사: 문단마다 줄을 바꾸고 첫 칸을 비워 실제 원고지처럼 채움')),
      h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'small muted' }, '단순 환산의 글자 수 기준'), rad('basis', 'with', '공백 포함 (줄바꿈 제외)'), rad('basis', 'without', '공백 제외')),
      h('div', { class: 'grid2' }, num('cellsPerLine', '한 줄 칸 수', 5, 60), num('linesPerSheet', '한 면 줄 수', 5, 40)),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: o.indent, onchange: (e) => { w.sheet.indent = e.target.checked; Object.assign(o, C.sheetSettings(w.sheet)); apply(); } }), '원고지 모사에서 문단 첫 칸 비우기'),
      box,
      h('div', { class: 'small muted' }, '글자 수는 줄바꿈을 뺀 글자(이모지는 1자)를 셉니다. 공백 제외는 띄어쓰기·탭·전각 공백·폭 없는 문자를 뺍니다. 원고지 모사는 줄 끝의 띄어쓰기를 생략하고, 줄 첫 칸에 올 수 없는 문장부호는 앞 줄 끝에 붙이며, 숫자·영문 소문자는 한 칸에 두 자를 넣습니다.'));
  }

  /* ───────────── 예시 작품 ───────────── */
  async function seedSample() {
    const w = defaultWork({ title: '[예시] 새벽 시장', genre: '단편', status: '개고', synopsis: '새벽 시장의 부부가 석 달 치 외상을 받으러 가는 날의 이야기. (기능을 눌러 볼 수 있는 예시 작품입니다.)', memo: '예시 작품입니다. 편집·비교·내보내기를 마음껏 해 보시고, 필요 없으면 삭제하세요.', names: ['정숙', '용석'] });
    const chs = [
      ['제1장 새벽 시장', ['새벽 네 시가 되기 전에 정숙은 가게 셔터를 반쯤 올려 두었다. 불은 켜지 않았다. 냉장고 돌아가는 소리가 어둠 속에서 먼저 들렸다.', '골목 끝에서 트럭 문 닫히는 소리가 났다. 용석은 늘 문을 한 번에 닫지 못했다. 쾅, 하고 닫았다가 다시 열고, 또 쾅 닫았다. 정숙은 한 번 더 닫으라고 말해 본 적이 없었다.', '“오늘 대파가 좀 비싸요.”', '용석이 상자를 내려놓으며 말했다. 정숙은 대꾸하지 않고 상자 모서리의 물기를 행주로 닦았다. 대파가 비싼 건 지난주부터였다. 용석도 그걸 알았다.', '“그럼 반 상자만 둘까요?”', '“두 상자 둬. 저쪽 식당에서 가져간다니까.”', '“그 식당, 이번 달엔 외상 말고는 가져간 적이 없는데.”', '정숙은 행주를 접어 상자 위에 올려놓았다. 접은 행주는 금방 다시 젖었다.']],
      ['제2장 외상장부', ['외상장부는 계산대 서랍 맨 아래에 있었다. 표지가 닳아서 글씨가 거의 지워진 공책이었는데, 정숙은 어느 쪽이 위인지 보지 않고도 꺼냈다.', '식당 이름 옆에 날짜가 세 줄 적혀 있었다. 첫 줄은 용석의 글씨였고 나머지 두 줄은 정숙의 글씨였다. 금액은 같았다. 같은 금액이 석 달째 같은 자리에 적혀 있었다.', '“받으러 가요, 오늘.”', '정숙이 말했다. 용석은 장갑을 벗다가 멈췄다.', '“오늘은 말고.”', '“그럼 언제요.”', '“……”', '“언제냐고요.”', '용석은 장갑을 마저 벗어 상자 위에 올렸다. 장갑에서 파 냄새가 났다.']],
      ['제3장 셔터', ['해가 올라오자 시장은 금세 시끄러워졌다. 정숙은 셔터를 끝까지 올리고 가게 앞에 물을 뿌렸다.', '식당 주인은 점심 전에 왔다. 현금이 아니라 흰 봉투를 들고 왔는데, 봉투 안에는 가게 이름이 인쇄된 상품권이 들어 있었다. 정숙은 그걸 한참 쳐다보았다.', '“이건 어디서 쓰라고요.”', '“우리 가게에서 쓰시면 되죠.”', '정숙은 상품권을 장부 사이에 끼웠다. 웃지는 않았다. 용석이 뒤에서 헛기침을 했다.']],
    ];
    const v1 = C.makeVersion({ workId: w.id, label: '원문', kind: '원문', frozen: true, note: '예시 원문', chapters: chs.map(([t, ps]) => C.newChapter(t, ps.join('\n'))) });
    const ch2 = C.cloneChapters(v1.chapters);
    const edit = (ci, from, to) => { const p = ch2[ci].paragraphs.find((q) => q.text.includes(from)); if (p) p.text = p.text.replace(from, to); };
    edit(0, ' 불은 켜지 않았다.', ''); edit(1, '같은 금액이 석 달째 같은 자리에 적혀 있었다.', '같은 금액이 석 달째 그 자리에 있었다.');
    ch2[1].paragraphs = ch2[1].paragraphs.filter((q) => q.text !== '“……”');
    const i = ch2[2].paragraphs.findIndex((q) => q.text.startsWith('식당 주인은')); ch2[2].paragraphs.splice(i + 1, 0, C.newParagraph('봉투는 얇았다.'));
    const v2 = C.makeVersion({ workId: w.id, parentId: v1.id, label: '1고', kind: '1고', frozen: true, note: '예시 개고본', chapters: ch2 });
    for (const v of [v1, v2]) { const t = C.aggregateCounts(v.chapters.map((c) => C.countText(C.chapterText(c), w.sheet)), w.sheet); v.stats = { withSpaces: t.withSpaces, noSpaces: t.noSpaces, sheets: t.sheets }; if (v === v2) w.counts = { withSpaces: t.withSpaces, noSpaces: t.noSpaces, sheets: t.sheets, simple: t.simple, grid: t.grid, chapters: v.chapters.length }; }
    w.currentVersionId = v2.id;
    await S.storage.putVersion(v1); await S.storage.putVersion(v2); await S.storage.putWork(w);
  }

  /* ───────────── 다른 모듈(AI 화면)에 열어 주는 것 ───────────── */
  const NSApp = {
    S, h, $, fmt, pad, fmtDate, toast, modal, askConfirm, saveFile, go, render, openWork, loadWorks, defaultWork, flushAndSave, pickFile, importDialog, createWorkFromImport,
    markDirty, saveNow, jumpTo, openVersion, prepEdit: () => prep(), afterStructureChange: () => afterStructureChange(), processEditor: (f) => processEditor(f), KINDS, GENRES, STATUSES, TAB, verMeta, views: {}, hooks: { settings: [] },
    get storage() { return S.storage; },
    getWork: async (id) => (S.work && S.work.id === id ? JSON.parse(JSON.stringify(S.work)) : S.storage.getWork(id)),
    updateWork: async (id, fn) => { if (S.work && S.work.id === id) { fn(S.work); await S.storage.putWork(S.work); return S.work; } const w = await S.storage.getWork(id); fn(w); await S.storage.putWork(w); return w; },
    afterVersionsChanged: async () => { if (S.work) { try { S.versions = await S.storage.listVersionMeta(S.work.id); } catch (e) { /* 다음에 다시 읽는다 */ } } },
  };
  window.NSApp = NSApp;

  /* ───────────── 시작 ───────────── */
  async function boot() {
    $('#app').replaceChildren(
      h('div', { class: 'top' }, h('div', { class: 'brand' }, '《소설 작업실》'), h('nav', { class: 'nav', id: 'nav', 'aria-label': '주 메뉴' }), h('div', { class: 'small muted', id: 'worktitle', style: 'font-weight:600' }), h('div', { class: 'spacer' }), h('div', { id: 'aistatus' }), h('div', { class: 'savestate', id: 'savestate', 'data-s': 'saved' })),
      h('div', { id: 'storagebanner' }), h('main', { id: 'main' }), h('div', { id: 'modals' }), h('div', { id: 'toasts', 'aria-live': 'polite' }));
    S.storage = await ST.createStorage();
    try { Object.assign(S.prefs, (await S.storage.getMeta('prefs')) || {}); S.lastBackup = (await S.storage.getMeta('lastBackup')) || null; } catch (e) { /* 기본값 사용 */ }
    applyPrefs();
    try { if (!(await S.storage.getMeta('seeded'))) { await seedSample(); await S.storage.setMeta('seeded', true); } } catch (e) { /* 예시 작품은 없어도 된다 */ }
    if (window.NSAIUI) { try { await window.NSAIUI.init(NSApp); } catch (e) { console.error('AI 화면 초기화 실패', e); } }
    await loadWorks(); render();
    if (S.storage.kind === 'indexeddb') S.storage.requestPersist();
    if (bc) bc.onmessage = (e) => { const m = e.data; if (m && m.from !== TAB.id && S.ver && m.versionId === S.ver.id && !S.otherWindow) { S.otherWindow = true; if (S.view === 'write') renderBanner(); } };
    window.__NS = { S, C, ST }; // 점검용
  }
  boot().catch((e) => { $('#app').replaceChildren(h('div', { class: 'banner danger', role: 'alert' }, '시작하지 못했습니다: ' + (e && e.message || e))); });
})();
