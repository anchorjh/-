/* 소설 작업실 — ai-ui.js
 * AI 화면: 새 작품 마법사, AI 작업실(개고·원클릭·변환·심사), 작업 패널·보고서.
 * 실제 호출은 NSAI(엔진)가 하고, 여기서는 시작 전 확인·진행 표시·결과 보여 주기만 한다. */
(function () {
  'use strict';
  const C = window.NSCore, A = window.NSAI, P = window.NSPrompts;
  let N, h, S, $, fmt, fmtDate, toast, modal, askConfirm;
  const U = { sample: null, avail: null, running: false, ctl: null, job: null, last: 0, timer: null, wiz: { stage: 'form', workId: null, chain: [], form: null }, ui: {} };

  const TIER_LABEL = { quick: '빠름', default: '보통', complex: '정밀' };
  const AUTOS = ['보수적', '균형형', '적극형', '전면형'];
  const AUTO_LEVEL = { 보수적: 2, 균형형: 3, 적극형: 4, 전면형: 5 };
  const MODES = [['원작 충실형', '원작의 사건과 인물, 대사를 최대한 유지'], ['문학적 확장형', '원작의 핵심을 유지하면서 장면과 심리를 확장'], ['상업적 각색형', '서사의 속도와 극적 재미를 강화'], ['자유 각색형', '핵심 소재만 유지하고 구조를 새롭게 구성']];
  const SCRIPT_FORMATS = ['영화 시나리오', '단편영화 시나리오', 'TV 드라마 대본', 'OTT 시리즈 대본', '웹드라마 대본'];
  const STATUS_TXT = { pending: '대기', running: '진행 중', paused: '멈춤', done: '완료', partial: '일부 미처리', failed: '실패', cancelled: '취소' };
  const STEP_TXT = { pending: '대기', running: '진행 중', done: '완료', failed: '실패', refused: '미처리(거부)', skipped: '건너뜀' };

  /* ───────────── 설정 ───────────── */
  function aiPrefs() {
    const p = S.prefs.ai = S.prefs.ai || {};
    p.tiers = Object.assign({}, A.DEFAULT_CONFIG.tiers, p.tiers || {});
    p.chunkChars = p.chunkChars || A.DEFAULT_CONFIG.chunkChars; p.loopMax = p.loopMax || 2; p.automation = p.automation || '균형형';
    return p;
  }
  const savePrefs = () => N.storage.setMeta('prefs', S.prefs).catch(() => {});
  const cfgFromPrefs = () => { const p = aiPrefs(); return { chunkChars: p.chunkChars, reviseChunkChars: Math.round(p.chunkChars * 0.93), tiers: p.tiers }; };

  async function getSample() {
    if (U.avail === null) { try { U.sample = window.claude && window.claude.use ? await window.claude.use('sample') : null; } catch (e) { U.sample = null; } U.avail = !!U.sample; }
    return U.sample;
  }
  const availBanner = () => (U.avail === false ? h('div', { class: 'banner danger', role: 'alert', id: 'aiunavail' }, '이 환경에서는 AI를 쓸 수 없습니다. Claude에 로그인한 상태로 이 페이지를 열었는지, 조직 설정에서 AI 사용이 허용되어 있는지 확인하세요. 편집·비교·통계 같은 기본 기능은 그대로 쓸 수 있습니다.') : h('div', { hidden: true }));

  /* ───────────── 작업 실행 ───────────── */
  async function execJob(job) {
    if (U.running) { toast('이미 진행 중인 AI 작업이 있습니다.', 'err'); return job; }
    const sample = await getSample();
    if (!sample) { toast('이 환경에서는 AI를 사용할 수 없습니다.', 'err'); return job; }
    const engine = A.createEngine({ sample, config: cfgFromPrefs() });
    try { const lim = sample.limits ? await sample.limits() : null; if (lim && lim.modelTiers) engine.setAllowedTiers(lim.modelTiers); } catch (e) { /* 기본 등급 사용 */ }
    const runner = A.createRunner({ engine, storage: N.storage, getWork: N.getWork, updateWork: N.updateWork, onEvent: (e) => { U.job = e.job; refreshJobUI(); } });
    U.running = true; U.runs = (U.runs || 0) + 1; U.ctl = new AbortController(); U.job = job; U.t0 = Date.now(); refreshJobUI(true);
    U.timer = setInterval(() => refreshJobUI(), 1000);
    try { await runner.run(job, { signal: U.ctl.signal }); }
    catch (e) { job.status = 'failed'; job.pausedReason = '예기치 않은 오류: ' + ((e && e.message) || e); try { await N.storage.putJob(job); } catch (_) { /* 저장 실패는 화면에만 표시 */ } }
    finally { U.running = false; U.ctl = null; clearInterval(U.timer); }
    await learnAvg(job);
    await N.afterVersionsChanged(); await N.loadWorks();
    refreshJobUI(true); notifyDone(job);
    if (job.status === 'done' && job.chainTag === 'wizard') await continueChain(job);
    return job;
  }
  function notifyDone(job) {
    const label = A.TYPE_LABEL[job.type] || job.type;
    if (job.status === 'done') toast(`${label}이(가) 끝났습니다.`);
    else if (job.status === 'partial') toast(`${label}이(가) 끝났지만 일부는 처리되지 않았습니다. 보고서를 확인하세요.`, 'err');
    else if (job.status === 'paused') toast(job.pausedReason || '작업이 멈췄습니다.', job.pausedReason && /중지/.test(job.pausedReason) ? '' : 'err');
    else if (job.status === 'failed') toast(job.pausedReason || '작업이 실패했습니다.', 'err');
  }
  async function learnAvg(job) {
    try {
      const prev = (await N.storage.getMeta('aiAvg')) || {};
      (job.log || []).forEach((l) => { if (l.ok && l.tier) { const e = prev[l.tier] = prev[l.tier] || { n: 0, ms: 0 }; if (e.n < 200) { e.n++; e.ms += l.ms; } } });
      await N.storage.setMeta('aiAvg', prev);
    } catch (e) { /* 추정만 덜 정확해진다 */ }
  }
  async function avgHistory() { const m = (await N.storage.getMeta('aiAvg')) || {}; const o = {}; Object.keys(m).forEach((k) => { if (m[k].n >= 3) o[k] = m[k].ms / m[k].n; }); return o; }

  /* 시작 전 확인: 예상 호출 수·시간, 전송·사용량 고지, 되돌릴 수 있음 */
  async function confirmRun(job, o) {
    if (!(await N.storage.getMeta('aiNoticeAck'))) {
      const ok = await new Promise((resolve) => modal({ title: 'AI 작업을 쓰기 전에', noBgClose: true, onClose: (v) => resolve(v === 'ok'),
        body: [h('ul', { class: 'stack', style: 'margin:0;padding-left:18px;gap:8px' }, [
          'AI 작업을 실행하면 해당 원고·설정집·메모가 Claude로 전송되어 처리됩니다.',
          '호출은 지금 보고 계신 분의 Claude 사용량을 씁니다. 처음 호출할 때 허용 여부를 묻는 창이 뜹니다.',
          '데이터 보존·학습 활용 정책은 Anthropic의 공식 문서에서 직접 확인하세요. 이 앱이 대신 보증하지 않습니다.',
          '모든 AI 작업은 새 버전으로 저장되고 원본은 바뀌지 않습니다. 결과는 “초고”이며 완성작이 아닙니다.'].map((t) => h('li', {}, t)))],
        actions: (close) => [h('button', { class: 'btn', onclick: () => close(null) }, '취소'), h('button', { class: 'btn primary', onclick: () => close('ok') }, '이해했습니다')] }));
      if (!ok) return false; await N.storage.setMeta('aiNoticeAck', true);
    }
    const est = A.estimateJob(job, cfgFromPrefs(), await avgHistory());
    const tiers = aiPrefs().tiers;
    return new Promise((resolve) => modal({ title: `${o.title} — 시작 전 확인`, noBgClose: true, onClose: (v) => resolve(v === 'ok'),
      body: [
        o.target ? h('div', {}, o.target) : null,
        h('dl', { class: 'kv' }, h('dt', {}, '예상 호출'), h('dd', {}, `약 ${fmt(est.calls)}회`), h('dt', {}, '예상 시간'), h('dd', {}, `약 ${est.minMinutes}~${est.maxMinutes}분 (추정, 실제는 다를 수 있음)`),
          h('dt', {}, '모델 등급'), h('dd', {}, `집필·개고·심사 ${TIER_LABEL[tiers.소설가]}/${TIER_LABEL[tiers.심사위원]}, 요약 ${TIER_LABEL[tiers.요약자]} (설정에서 바꿀 수 있음)`)),
        ...(o.notes || []).map((t) => h('div', { class: 'banner info' }, t)),
        h('div', { class: 'banner' }, '작업 중 이 창을 닫거나 새로고침하면 멈춥니다. 저장된 지점부터 이어서 진행할 수 있습니다. 호출은 보시는 분의 Claude 사용량을 쓰고, 원고가 Claude로 전송됩니다.')],
      actions: (close) => [h('button', { class: 'btn', onclick: () => close(null) }, '취소'), h('button', { class: 'btn primary', onclick: () => close('ok') }, '시작')] }));
  }
  async function launch(job, o) { if (!(await confirmRun(job, o))) return null; await N.storage.putJob(job); return execJob(job); }

  /* ───────────── 진행 표시 ───────────── */
  function refreshJobUI(force) {
    const now = Date.now(); if (!force && now - U.last < 400) return; U.last = now;
    updateStrip();
    document.querySelectorAll('[data-jobslot]').forEach((el) => { const j = jobForSlot(el); el.replaceChildren(...(j ? [jobPanel(j)] : [])); });
  }
  function jobForSlot(el) { const j = U.job; if (!j) return null; const want = el.getAttribute('data-jobslot'); return want === 'any' || want === j.workId ? j : null; }
  function updateStrip() {
    const el = $('#aistatus'); if (!el) return; el.replaceChildren();
    const j = U.job; if (!j) return;
    if (U.running) { const done = j.steps.filter((s) => ['done', 'refused', 'skipped'].includes(s.status)).length; el.append(h('div', { class: 'savestate', style: 'gap:8px' }, h('span', { class: 'dot', style: 'background:var(--accent)' }), `AI 작업 중 ${done}/${j.steps.length}`, h('button', { class: 'btn sm', onclick: () => { N.go(j.type === 'draft' || j.type === 'phase' ? 'wizard' : 'ai'); } }, '보기'), h('button', { class: 'btn sm', onclick: () => U.ctl && U.ctl.abort() }, '중지'))); }
  }
  const fmtSec = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`; };

  function jobPanel(job) {
    const total = job.steps.length, done = job.steps.filter((s) => ['done', 'refused', 'skipped'].includes(s.status)).length;
    const live = U.running && U.job && U.job.id === job.id;
    const cur = job.steps.find((s) => s.status === 'running') || job.steps.find((s) => s.status === 'pending' || s.status === 'failed');
    const failed = job.steps.find((s) => s.status === 'failed');
    const pct = total ? Math.round((done / total) * 100) : 0;
    const st = h('span', { class: 'pill ' + (job.status === 'done' ? 'accent' : job.status === 'failed' || job.status === 'partial' ? 'warn' : ''), style: 'margin-left:6px' }, live ? '진행 중' : STATUS_TXT[job.status] || job.status);
    const unp = (job.report && job.report.unprocessed) || [];
    return h('div', { class: 'card stack', style: 'gap:10px;border-color:var(--accent)', 'data-jobid': job.id },
      h('div', { class: 'btn-row', style: 'justify-content:space-between' }, h('div', {}, h('b', {}, A.TYPE_LABEL[job.type] || job.type), st, h('span', { class: 'small muted', style: 'margin-left:8px' }, fmtDate(job.createdAt))),
        h('div', { class: 'small muted mono' }, `호출 ${job.stats ? job.stats.calls : 0}회` + (live ? ` · 경과 ${fmtSec(Date.now() - U.t0)}` : ''))),
      h('div', { style: 'height:8px;background:var(--surface-2);border-radius:99px;overflow:hidden' }, h('div', { style: `height:100%;width:${pct}%;background:var(--accent)` })),
      h('div', { class: 'small' }, live && cur ? `지금: ${cur.label} (${done}/${total} 단계 완료)` : `${done}/${total} 단계 완료` + (job.status === 'done' ? ' — 모든 단계를 마쳤습니다' : '')),
      job.pausedReason && !live ? h('div', { class: 'banner' + (job.status === 'failed' ? ' danger' : '') }, job.pausedReason) : null,
      unp.length ? h('div', { class: 'banner danger' }, `처리하지 못한 곳 ${unp.length}곳: ` + unp.slice(0, 6).map((u) => u.step).join(', ')) : null,
      job.status === 'done' && (job.report.warnings || []).length ? h('div', { class: 'banner' }, `주의 ${(job.report.warnings || []).length}건 — 보고서에서 확인하세요.`) : null,
      h('div', { class: 'btn-row' },
        live ? h('button', { class: 'btn danger', onclick: () => U.ctl && U.ctl.abort() }, '중지') : null,
        !live && ['paused', 'failed', 'pending'].includes(job.status) ? h('button', { class: 'btn primary', onclick: () => execJob(job) }, '이어서 진행') : null,
        !live && failed ? h('button', { class: 'btn', onclick: async () => { failed.status = 'skipped'; await N.storage.putJob(job); execJob(job); } }, '이 단계 건너뛰고 계속') : null,
        ['done', 'partial'].includes(job.status) || job.report && job.resultVersionId ? h('button', { class: 'btn', onclick: () => showReport(job) }, '결과 보고서') : null,
        job.resultVersionId && !live ? h('button', { class: 'btn', onclick: () => openResult(job) }, job.type === 'convert' ? '변환본 열기' : '결과 버전 열기') : null),
      h('details', {}, h('summary', { class: 'small muted', style: 'cursor:pointer' }, '단계와 호출 기록'),
        h('div', { class: 'list', style: 'margin-top:8px;max-height:260px;overflow:auto' }, job.steps.map((s) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, s.label), s.error ? h('div', { class: 'small', style: 'color:var(--danger)' }, s.error) : null), h('span', { class: 'small muted' }, STEP_TXT[s.status] || s.status)))),
        job.log && job.log.length ? h('div', { class: 'tbl-wrap', style: 'margin-top:8px;max-height:240px;overflow:auto' }, h('table', { class: 'tbl', style: 'min-width:0;font-size:12px' }, h('thead', {}, h('tr', {}, ['역할', '작업', '등급', '입력자', '출력자', '시간', '결과'].map((t) => h('th', {}, t)))), h('tbody', {}, job.log.slice(-60).map((l) => h('tr', {}, h('td', {}, l.role), h('td', {}, l.label || l.task), h('td', {}, TIER_LABEL[l.tier] || l.tier), h('td', { class: 'num' }, fmt(l.inChars)), h('td', { class: 'num' }, fmt(l.outChars)), h('td', { class: 'num' }, fmtSec(l.ms)), h('td', {}, l.ok ? '성공' : l.code || '실패')))))) : null));
  }
  async function openResult(job) {
    const v = await N.storage.getVersion(job.resultVersionId); if (!v) { toast('결과 버전을 찾을 수 없습니다.', 'err'); return; }
    if (v.workId !== (S.work && S.work.id)) { await N.openWork(v.workId); return; }
    await N.openVersion(v.id);
  }

  /* ───────────── 설정 카드 ───────────── */
  function settingsCard() {
    const p = aiPrefs();
    const sel = (role) => h('label', { class: 'fld' }, role, h('select', { onchange: (e) => { p.tiers[role] = e.target.value; savePrefs(); } }, ['quick', 'default', 'complex'].map((t) => h('option', { value: t, selected: p.tiers[role] === t }, TIER_LABEL[t]))));
    return h('div', { class: 'card stack' }, h('h2', {}, 'AI 설정'),
      h('div', { class: 'small muted' }, '역할마다 쓸 모델 등급을 정합니다. 정밀할수록 느리고 사용량이 많습니다. 집필·개고·심사는 정밀, 요약은 빠름이 기본입니다. 이 환경에서 지원하지 않는 등급은 자동으로 보통으로 바뀝니다.'),
      h('div', { class: 'grid2' }, Object.keys(P.ROLES).map(sel)),
      h('div', { class: 'grid2' },
        h('label', { class: 'fld' }, '한 번에 쓰게 할 장면 길이(자)', h('input', { type: 'number', min: 800, max: 6000, step: 100, value: p.chunkChars, onchange: (e) => { p.chunkChars = Math.min(6000, Math.max(800, +e.target.value || 2800)); savePrefs(); } })),
        h('label', { class: 'fld' }, '자기 교정 최대 반복', h('select', { onchange: (e) => { p.loopMax = +e.target.value; savePrefs(); } }, [1, 2, 3].map((n) => h('option', { value: n, selected: p.loopMax === n }, n + '회'))))),
      h('label', { class: 'fld' }, '기본 자동화 정도', h('select', { onchange: (e) => { p.automation = e.target.value; savePrefs(); } }, AUTOS.map((a) => h('option', { value: a, selected: p.automation === a }, a + ' — ' + P.AUTOMATION[a])))),
      h('div', { class: 'small muted' }, `프롬프트 버전 ${P.PROMPT_VERSION}. 출력 길이에는 상한이 있어 긴 글은 장면·묶음 단위로 나눠 호출합니다. 호출이 너무 잦으면 한도에 걸려 작업이 멈출 수 있고, 그때는 “이어서 진행”을 누르면 됩니다.`));
  }

  /* ───────────── 작업 준비 도구 ───────────── */
  const stamp = () => { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()} ${N.pad(d.getHours())}:${N.pad(d.getMinutes())}`; };
  // 자동 작업 전에 기준 버전을 고정(스냅숏)한다. 작업 중 버전이면 지금 상태 그대로 고정.
  async function ensureFrozen(versionId) {
    await N.flushAndSave();
    if (S.ver.id === versionId) {
      if (!S.ver.frozen) { S.ver.frozen = true; S.ver.kind = '기타'; S.ver.label = `자동 작업 전 (${stamp()})`; S.ver.note = 'AI 작업 직전 상태를 자동으로 고정함'; S.dirty = true; await N.saveNow(); N.render(); }
      return S.ver;
    }
    const v = await N.storage.getVersion(versionId);
    if (!v.frozen) { v.frozen = true; await N.storage.putVersion(v); }
    return v;
  }
  const syncSel = (selEl, obj, key) => { if (![...selEl.options].some((o) => o.value === obj[key])) obj[key] = selEl.value; return selEl; };
  async function versionOptions(sel) {
    const metas = (await N.storage.listVersionMeta(S.work.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return metas.map((m) => h('option', { value: m.id, selected: m.id === sel }, `${m.label}${m.frozen ? '' : ' (작업 중)'} · ${m.stats ? fmt(m.stats.withSpaces) + '자' : ''}`));
  }
  const chapterChars = (ver) => Object.fromEntries(ver.chapters.map((c, i) => [i, C.countWithSpaces(C.chapterText(c))]));

  /* ───────────── 새 작품 마법사 ───────────── */
  const GENRE_LIST = ['순문학(현실주의)', '역사', '미스터리', '스릴러', '로맨스', 'SF', '판타지', '호러', '무협', '청소년', '동화', '기타'];
  const FORM_PRESET = { 엽편: [8, 1], 단편: [60, 4], 중편: [200, 10], 장편: [500, 12], '연재(회차)': [120, 12] };
  const STYLE_NAMES = Object.keys(P.STYLE_PRESETS);
  const POVS = Object.keys(P.POV_TEXT);
  const defaultForm = () => ({ title: '', keywords: '', storyline: '', form: '단편', genres: ['순문학(현실주의)'], unit: 'sheets', amount: 60, chapterCount: 4, pov: '3인칭 제한', tense: '과거형', style: '한국적 현실주의', styleFree: '', tone: { weight: 5, humor: 4, tension: 5 }, era: '', place: '', season: '', ending: 'AI에게 맡김', forbidden: '', mode: 'step', polish: false, sampleText: '', fingerprint: '' });
  const saveWiz = () => N.storage.setMeta('wizard', { stage: U.wiz.stage, workId: U.wiz.workId, chain: U.wiz.chain, form: U.wiz.form }).catch(() => {});
  const resetWizard = () => { U.wiz = { stage: 'form', workId: null, chain: [], form: U.wiz.form || defaultForm() }; saveWiz(); };
  function makeBrief(F) {
    const chars = F.unit === 'sheets' ? Math.round(F.amount * 200) : Math.round(F.amount);
    return { keywords: F.keywords.trim(), storyline: F.storyline.trim(), form: F.form, genres: F.genres, target: { unit: F.unit, value: F.amount, chars }, chapterCount: F.chapterCount, pov: F.pov, tense: F.tense, style: F.style, styleFree: F.styleFree, tone: F.tone, setting: { era: F.era, place: F.place, season: F.season }, ending: F.ending === 'AI에게 맡김' ? '' : F.ending, forbidden: F.forbidden, mode: F.mode };
  }
  function chainEstimateJob(F, brief) {
    const n = brief.chapterCount, per = brief.target.chars / n;
    const fake = { id: 'x', bible: { design: { chapters: Array.from({ length: n }, () => ({ title: '', targetChars: per, scenes: [{}, {}] })) } } };
    const job = A.buildJob('draft', fake, { sceneCounts: Object.fromEntries(Array.from({ length: n }, (_, i) => [i, 2])), chapterChars: Object.fromEntries(Array.from({ length: n }, (_, i) => [i, per])) });
    job.steps = [A.step('idea', null, '구상'), A.step('design', null, '설계')].concat(job.steps);
    if (F.polish) { const oc = A.buildJob('oneclick', fake, { level: 4, automation: '적극형', loop: { on: true, max: aiPrefs().loopMax }, chapterChars: job.params.chapterChars }, { chapterCount: n }); job.steps = job.steps.concat(oc.steps); job.params.level = 4; job.params.loop = { on: true, max: aiPrefs().loopMax }; }
    return job;
  }

  async function renderWizard(main) {
    await getSample();
    if (!U.wiz.form) { const m = await N.storage.getMeta('wizard'); if (m) U.wiz = Object.assign(U.wiz, m); if (!U.wiz.form) U.wiz.form = defaultForm(); }
    const wrap = h('div', { class: 'stack' });
    main.append(h('div', { class: 'page-head' }, h('h1', {}, 'AI로 새 작품 쓰기'), h('div', { class: 'small muted' }, '재료 → 구상 → 시놉시스·구조 → 초고. 결과는 “초고”이며, 직접 고치거나 AI 개고로 이어가세요.')), availBanner(), wrap);
    await drawWizard(wrap);
  }
  async function drawWizard(wrap) {
    const W = U.wiz; wrap.replaceChildren();
    let work = W.workId ? await N.storage.getWork(W.workId) : null;
    if (W.workId && !work) { resetWizard(); work = null; }
    const stages = [['form', '① 재료'], ['idea', '② 구상'], ['design', '③ 시놉시스·구조'], ['draft', '④ 초고'], ['done', '완료']];
    const order = stages.map((s) => s[0]);
    wrap.append(h('div', { class: 'btn-row' }, stages.map(([k, t]) => h('span', { class: 'pill' + (W.stage === k ? ' accent' : ''), style: 'padding:4px 12px;font-size:13px' + (order.indexOf(k) < order.indexOf(W.stage) ? ';opacity:.6' : '') }, t)), W.workId ? h('button', { class: 'btn sm', style: 'margin-left:auto', onclick: async () => { if (U.running) { toast('AI 작업이 진행 중입니다. 먼저 중지하세요.', 'err'); return; } if (await askConfirm({ title: '새로 시작', message: '이 마법사를 처음 단계로 되돌립니다. 만들어 둔 작품과 버전은 보관함에 그대로 남습니다.', confirmText: '새로 시작' })) { resetWizard(); N.render(); } } }, '새로 시작') : null));
    wrap.append(h('div', { 'data-jobslot': W.workId || 'none' }, U.job && U.job.workId === W.workId && W.workId ? jobPanel(U.job) : null));
    if (W.stage === 'form' || !work) return wrap.append(wizardForm());
    if (W.stage === 'idea') return wrap.append(ideaStage(work));
    if (W.stage === 'design') return wrap.append(designStage(work));
    if (W.stage === 'draft') return wrap.append(await draftStage(work));
    if (W.stage === 'done') return wrap.append(await doneStage(work));
  }

  function wizardForm() {
    const F = U.wiz.form; let timer;
    const keep = () => { clearTimeout(timer); timer = setTimeout(saveWiz, 500); };
    const inp = (k, label, o) => { o = o || {}; const el = o.rows ? h('textarea', { class: 'field', rows: o.rows, placeholder: o.ph || '' }) : h('input', { type: 'text', placeholder: o.ph || '' }); el.value = F[k] || ''; el.setAttribute('aria-label', label); el.addEventListener('input', () => { F[k] = el.value; keep(); }); return h('label', { class: 'fld' }, label, el); };
    const sel = (k, label, opts, onch) => h('label', { class: 'fld' }, label, h('select', { 'aria-label': label, onchange: (e) => { F[k] = e.target.value; if (onch) onch(); keep(); } }, opts.map((o) => h('option', { value: o, selected: F[k] === o }, o))));
    const amount = h('input', { type: 'number', min: 1, 'aria-label': '분량', value: F.amount, onchange: (e) => { F.amount = Math.max(1, +e.target.value || 1); keep(); update(); } });
    const chapters = h('input', { type: 'number', min: 1, max: 12, 'aria-label': '장 수', value: F.chapterCount, onchange: (e) => { F.chapterCount = Math.min(12, Math.max(1, +e.target.value || 1)); e.target.value = F.chapterCount; keep(); update(); } });
    const unit = h('select', { 'aria-label': '분량 단위', onchange: (e) => { F.unit = e.target.value; keep(); update(); } }, [['sheets', '원고지 매수(200자)'], ['chars', '글자 수(공백 포함)']].map(([v, t]) => h('option', { value: v, selected: F.unit === v }, t)));
    const info = h('div', { class: 'small muted' });
    const update = () => { const chars = F.unit === 'sheets' ? F.amount * 200 : F.amount; info.textContent = `약 ${fmt(Math.round(chars))}자 · 장당 약 ${fmt(Math.round(chars / F.chapterCount))}자. ` + (chars > 60000 ? '긴 작품은 호출이 매우 많아집니다(수십~수백 회). 이번 버전은 최대 12장까지 한 번에 설계합니다.' : ''); };
    update();
    const formSel = h('select', { 'aria-label': '형식', onchange: (e) => { F.form = e.target.value; const p = FORM_PRESET[F.form]; if (p) { F.unit = 'sheets'; F.amount = p[0]; F.chapterCount = p[1]; amount.value = F.amount; chapters.value = F.chapterCount; unit.value = 'sheets'; } keep(); update(); } }, Object.keys(FORM_PRESET).map((k) => h('option', { value: k, selected: F.form === k }, k)));
    const tone = (k, label) => h('label', { class: 'fld' }, `${label}: ${F.tone[k]}`, (() => { const r = h('input', { type: 'range', min: 1, max: 10, value: F.tone[k], 'aria-label': label }); r.addEventListener('input', () => { F.tone[k] = +r.value; r.parentElement.firstChild.textContent = `${label}: ${r.value}`; keep(); }); return r; })());
    const fp = h('div', { class: 'small muted' }, F.fingerprint ? '문체 지문: ' + F.fingerprint : '');
    const startBtn = h('button', { class: 'btn primary', onclick: startWizard }, F.mode === 'auto' ? '완전 자동으로 시작' : '구상 만들기');
    const setMode = (m) => { F.mode = m; startBtn.textContent = m === 'auto' ? '완전 자동으로 시작' : '구상 만들기'; keep(); };
    const sample = h('textarea', { class: 'field', rows: 4, 'aria-label': '내 원고 샘플', placeholder: '내가 쓴 소설 몇 문단(500자 이상 권장)을 붙여 넣으면, 이 기기에서 문장 길이·대화 비율 같은 통계 지문만 뽑아 AI에게 알려 줍니다. 원고 전문은 저장하지 않습니다.' }); sample.value = F.sampleText || '';
    const genreBox = h('div', { class: 'btn-row' }, GENRE_LIST.map((g) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: F.genres.includes(g), onchange: (e) => { F.genres = e.target.checked ? F.genres.concat([g]) : F.genres.filter((x) => x !== g); keep(); } }), g)));
    return h('div', { class: 'card stack' },
      inp('title', '작품명 (비우면 AI 구상 뒤 정하세요)'), inp('keywords', '키워드 (짧게)', { ph: '예: 새벽 시장, 외상장부, 부부' }), inp('storyline', '스토리라인 / 시놉시스 / 트리트먼트 (아무 형태나, 길어도 됩니다)', { rows: 6 }),
      h('div', { class: 'grid2' }, h('label', { class: 'fld' }, '형식', formSel), h('label', { class: 'fld' }, '장 수 (최대 12)', chapters)),
      h('div', { class: 'grid2' }, h('label', { class: 'fld' }, '분량', amount), h('label', { class: 'fld' }, '단위', unit)), info,
      h('div', {}, h('div', { class: 'small muted', style: 'margin-bottom:4px' }, '장르 (복수 선택)'), genreBox),
      h('div', { class: 'grid2' }, sel('pov', '시점', POVS), h('label', { class: 'fld' }, '시제', h('select', { 'aria-label': '시제', onchange: (e) => { F.tense = e.target.value; keep(); } }, ['과거형', '현재형'].map((t) => h('option', { value: t, selected: F.tense === t }, t))))),
      h('div', { class: 'grid2' }, sel('style', '문체 스타일', STYLE_NAMES), inp('styleFree', '문체 추가 설명 (선택)', { ph: '예: 문장은 담담하게, 대화는 길게 이어서' })),
      h('details', {}, h('summary', { class: 'small', style: 'cursor:pointer' }, '내 문체를 AI에게 알리기 (선택)'), h('div', { class: 'stack', style: 'margin-top:8px' }, sample, h('button', { class: 'btn sm', onclick: () => { F.sampleText = sample.value; const r = C.styleFingerprint(sample.value); F.fingerprint = r.text; fp.textContent = r.text ? '문체 지문: ' + r.text : '샘플이 너무 짧거나 비었습니다.'; saveWiz(); } }, '문체 지문 만들기'), fp)),
      h('div', { class: 'grid2' }, tone('weight', '무게감'), tone('humor', '유머 비중')), tone('tension', '긴장도'),
      h('div', { class: 'grid2' }, inp('era', '배경: 시대'), inp('place', '배경: 장소')), inp('season', '배경: 계절'),
      sel('ending', '결말 방향', ['AI에게 맡김', '열린 결말', '닫힌 결말', '반전']), inp('forbidden', '쓰지 말아야 할 장치·소재·표현', { rows: 2 }),
      h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'small muted' }, '진행 방식'),
        h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'wizmode', checked: F.mode === 'step', onchange: () => setMode('step') }), '단계별 확인 — 구상과 시놉시스·구조를 직접 고친 뒤 초고를 씁니다 (권장)'),
        h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'wizmode', checked: F.mode === 'auto', onchange: () => setMode('auto') }), '완전 자동 — 구상부터 초고까지 멈추지 않고 진행'),
        h('label', { class: 'chk', style: 'margin-left:22px' }, h('input', { type: 'checkbox', checked: F.polish, onchange: (e) => { F.polish = e.target.checked; keep(); } }), '완전 자동일 때, 초고 뒤에 “원클릭 AI 완성”까지 이어서 실행')),
      h('div', { class: 'btn-row' }, startBtn));
  }
  async function startWizard() {
    const F = U.wiz.form;
    if (!F.storyline.trim() && !F.keywords.trim()) { toast('키워드나 스토리라인 중 하나는 적어 주세요.', 'err'); return; }
    if (U.running) { toast('AI 작업이 진행 중입니다.', 'err'); return; }
    const brief = makeBrief(F);
    const work = N.defaultWork({ title: F.title.trim() || '제목 없음 (AI 구상)', genre: F.genres.includes('역사') ? '역사소설' : F.form === '중편' ? '중편' : F.form === '장편' || F.form === '연재(회차)' ? '장편' : '단편', status: '구상', brief, aiGenerated: true, automation: '적극형', styleFingerprint: F.fingerprint, bible: {}, memo: 'AI 새 작품 마법사로 만든 작품입니다.' });
    const job = A.buildJob('phase', work, { phases: ['idea'] });
    const chain = F.mode === 'auto' ? ['design', 'draft'].concat(F.polish ? ['oneclick'] : []) : [];
    const est = F.mode === 'auto' ? chainEstimateJob(F, brief) : job;
    if (!(await confirmRun(est, { title: F.mode === 'auto' ? '완전 자동 집필' : 'AI 구상', target: `목표 분량 약 ${fmt(brief.target.chars)}자 · ${brief.chapterCount}개 장` + (F.mode === 'auto' ? ' · 구상부터' + (F.polish ? ' 원클릭 완성까지' : ' 초고까지') + ' 멈추지 않고 진행' : ''), notes: F.mode === 'auto' ? ['완전 자동에서도 결과는 “초고”입니다. 중간에 오류가 나면 그 지점에서 멈추고, 이어서 진행할 수 있습니다.'] : [] }))) return;
    const v = C.makeVersion({ workId: work.id, label: '작업본 1', kind: '작업본', chapters: [C.newChapter('제1장', '')] }); work.currentVersionId = v.id;
    await N.storage.putVersion(v); await N.storage.putWork(work); await N.loadWorks();
    U.wiz.workId = work.id; U.wiz.stage = 'idea'; U.wiz.chain = chain; saveWiz();
    if (chain.length) job.chainTag = 'wizard';
    N.render(); await N.storage.putJob(job); await execJob(job); N.render();
  }
  async function continueChain(prev) {
    const W = U.wiz; if (W.workId !== prev.workId) return;
    if (!W.chain.length) { if (prev.type === 'oneclick' || prev.type === 'draft') { W.stage = 'done'; saveWiz(); if (S.view === 'wizard') N.render(); } return; }
    const next = W.chain.shift(); const work = await N.storage.getWork(W.workId); let job;
    if (next === 'design') { W.stage = 'design'; job = A.buildJob('phase', work, { phases: ['design'] }); }
    else if (next === 'draft') { W.stage = 'draft'; job = buildDraftJob(work); }
    else { const dj = (await N.storage.listJobs(W.workId)).filter((j) => j.type === 'draft').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; const base = await N.storage.getVersion(dj.resultVersionId); job = A.buildJob('oneclick', work, { level: 4, automation: '적극형', baseVersionId: base.id, loop: { on: true, max: aiPrefs().loopMax }, chapterChars: chapterChars(base) }, { chapterCount: base.chapters.length }); W.stage = 'draft'; }
    job.chainTag = 'wizard'; saveWiz(); await N.storage.putJob(job); if (S.view === 'wizard') N.render();
    await execJob(job); if (S.view === 'wizard') N.render();
  }
  function buildDraftJob(work) {
    const chs = work.bible.design.chapters;
    return A.buildJob('draft', work, { sceneCounts: Object.fromEntries(chs.map((c, i) => [i, c.scenes.length])), chapterChars: Object.fromEntries(chs.map((c, i) => [i, c.targetChars])) });
  }

  /* 구상 단계 */
  const dbSave = (() => { let t; return (fn) => { clearTimeout(t); t = setTimeout(fn, 500); }; })();
  function ideaStage(work) {
    const idea = (work.bible && work.bible.idea) || null;
    if (!idea) return h('div', { class: 'card stack' }, h('div', {}, U.running ? '구상을 만드는 중입니다…' : '아직 구상이 없습니다.'), !U.running ? h('button', { class: 'btn primary', onclick: () => runIdea(work) }, '구상 만들기') : null);
    const edit = (k, label, rows) => { const el = h('textarea', { class: 'field', rows: rows || 2, 'aria-label': label }); el.value = idea[k] || ''; el.addEventListener('input', () => { idea[k] = el.value; dbSave(() => N.updateWork(work.id, (w) => { w.bible.idea[k] = el.value; })); }); return h('label', { class: 'fld' }, label, el); };
    const diff = h('textarea', { class: 'field', rows: 3, 'aria-label': '차별점' }); diff.value = (idea.differentiators || []).join('\n'); diff.addEventListener('input', () => { dbSave(() => N.updateWork(work.id, (w) => { w.bible.idea.differentiators = diff.value.split('\n').map((s) => s.trim()).filter(Boolean); })); });
    return h('div', { class: 'card stack' }, h('h2', {}, '구상'),
      idea.similar && idea.similar.length ? h('div', { class: 'banner' }, h('div', {}, h('b', {}, '알려진 작품과 닮은 점이 있다고 AI가 밝혔습니다. '), '이 점검은 완전하지 않으며 표절 검사기가 아닙니다.', h('ul', { style: 'margin:6px 0 0;padding-left:18px' }, idea.similar.map((s) => h('li', {}, `${s.title}: ${s.overlap}` + (s.differentiate ? ` → 차별화: ${s.differentiate}` : '')))))) : h('div', { class: 'small muted' }, 'AI가 닮은 작품을 찾지 못했다고 답했습니다(완전한 검사는 아닙니다).'),
      idea.assumed && idea.assumed.length ? h('div', { class: 'banner info' }, 'AI가 임의로 정한 값: ' + idea.assumed.join(' / ')) : null,
      edit('logline', '로그라인'), edit('coreIdea', '핵심 발상', 3), h('div', { class: 'grid2' }, edit('protagonistDesire', '주인공의 욕망', 3), edit('mainConflict', '주요 갈등', 3)), h('div', { class: 'grid2' }, edit('cause', '사건의 발생 원인', 3), edit('expectedEnding', '예상 결말', 3)),
      h('label', { class: 'fld' }, '작품의 차별점 (한 줄에 하나)', diff),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', disabled: U.running, onclick: () => runIdea(work) }, '구상 다시 만들기'), h('button', { class: 'btn primary', disabled: U.running, onclick: () => runDesign(work, '') }, '이 구상으로 시놉시스·구조 만들기')));
  }
  async function runIdea(work) {
    if (U.running) return;
    if (work.bible && work.bible.idea && !(await askConfirm({ title: '구상 다시 만들기', message: '지금의 구상(직접 고친 내용 포함)이 새 결과로 바뀝니다. 계속할까요?', confirmText: '다시 만들기' }))) return;
    const job = A.buildJob('phase', work, { phases: ['idea'] }); if (!(await confirmRun(job, { title: 'AI 구상' }))) return;
    await N.storage.putJob(job); N.render(); await execJob(job); N.render();
  }
  async function runDesign(work, feedback) {
    if (U.running) return;
    const fresh = await N.storage.getWork(work.id);
    const job = A.buildJob('phase', fresh, { phases: ['design'], authorEdits: feedback }); if (!(await confirmRun(job, { title: 'AI 시놉시스·구조 설계', notes: feedback ? ['입력한 수정 요청을 반영해 다시 설계합니다. 지금 화면에서 직접 고친 내용은 새 결과로 바뀝니다.'] : [] }))) return;
    U.wiz.stage = 'design'; saveWiz(); await N.storage.putJob(job); N.render(); await execJob(job); N.render();
  }

  /* 시놉시스·구조 단계 */
  function designStage(work) {
    const d = work.bible && work.bible.design;
    if (!d) return h('div', { class: 'card stack' }, h('div', {}, U.running ? '시놉시스와 구조를 만드는 중입니다…' : '아직 설계안이 없습니다.'), !U.running ? h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: () => runDesign(work, '') }, '시놉시스·구조 만들기'), h('button', { class: 'btn', onclick: () => { U.wiz.stage = 'idea'; saveWiz(); N.render(); } }, '구상으로 돌아가기')) : null);
    const target = work.brief.target.chars; const total = d.chapters.reduce((a, c) => a + c.targetChars, 0);
    const upd = (fn) => { dbSave(() => N.updateWork(work.id, (w) => fn(w.bible.design, w))); };
    const syn = h('textarea', { class: 'field', rows: 5, 'aria-label': '시놉시스' }); syn.value = d.synopsis; syn.addEventListener('input', () => { d.synopsis = syn.value; upd((dd) => { dd.synopsis = syn.value; }); });
    const sumLine = h('div', { class: 'small' });
    const drawSum = () => { const t = d.chapters.reduce((a, c) => a + (+c.targetChars || 0), 0); sumLine.textContent = `장별 목표 합계 ${fmt(t)}자 / 전체 목표 ${fmt(target)}자` + (Math.abs(t - target) / target > 0.1 ? ' — 10% 넘게 다릅니다. 장별 분량을 조정하세요.' : ''); sumLine.style.color = Math.abs(t - target) / target > 0.1 ? 'var(--warn-fg)' : ''; }; drawSum();
    const charRows = d.characters.map((c, i) => h('div', { class: 'card stack', style: 'gap:6px;padding:10px' }, h('div', { class: 'grid2' }, ...['name', 'age', 'role', 'desire'].map((k) => { const el = h('input', { type: 'text', 'aria-label': `인물 ${i + 1} ${k}`, placeholder: { name: '이름', age: '나이', role: '역할', desire: '욕망' }[k] }); el.value = c[k] || ''; el.addEventListener('input', () => { c[k] = el.value; upd((dd) => { dd.characters[i][k] = el.value; }); }); return el; })), (() => { const el = h('input', { type: 'text', 'aria-label': `인물 ${i + 1} 말투`, placeholder: '말투' }); el.value = c.speech || ''; el.addEventListener('input', () => { c.speech = el.value; upd((dd) => { dd.characters[i].speech = el.value; }); }); return el; })()));
    const chRows = d.chapters.map((c, i) => h('div', { class: 'card stack', style: 'gap:6px;padding:10px' },
      h('div', { class: 'btn-row' }, h('b', {}, `${i + 1}장`), (() => { const el = h('input', { type: 'text', style: 'flex:1;min-width:160px', 'aria-label': `${i + 1}장 제목` }); el.value = c.title; el.addEventListener('input', () => { c.title = el.value; upd((dd) => { dd.chapters[i].title = el.value; }); }); return el; })(),
        (() => { const el = h('input', { type: 'number', min: 100, style: 'width:110px', 'aria-label': `${i + 1}장 목표 글자 수` }); el.value = c.targetChars; el.addEventListener('change', () => { const v = Math.max(100, +el.value || 100), k = v / (c.targetChars || v); c.targetChars = v; c.scenes.forEach((s) => { s.targetChars = Math.round(s.targetChars * k); }); drawSum(); upd((dd) => { dd.chapters[i].targetChars = v; dd.chapters[i].scenes.forEach((s) => { s.targetChars = Math.round(s.targetChars * k); }); }); }); return el; })(), h('span', { class: 'small muted' }, '자')),
      (() => { const el = h('textarea', { class: 'field', rows: 2, 'aria-label': `${i + 1}장 요약` }); el.value = c.summary; el.addEventListener('input', () => { c.summary = el.value; upd((dd, w) => { dd.chapters[i].summary = el.value; w.bible.chapterSummaries[i] = el.value; }); }); return el; })(),
      h('div', { class: 'small muted' }, `시점 ${c.pov || '-'} · 핵심 사건: ${(c.keyEvents || []).join(', ') || '-'} · 장면 ${c.scenes.length}개: ` + c.scenes.map((s) => `${clipS(s.summary, 24)}(${fmt(s.targetChars)}자)`).join(' / '))));
    const fb = h('textarea', { class: 'field', rows: 2, 'aria-label': '수정 요청', placeholder: '예: 2장과 3장의 순서를 바꾸고, 결말은 열어 둬 주세요.' });
    return h('div', { class: 'stack' },
      h('div', { class: 'card stack' }, h('h2', {}, '시놉시스'), syn, d.twists && d.twists.length ? h('div', { class: 'small muted' }, '반전·복선: ' + d.twists.join(' / ')) : null),
      h('div', { class: 'card stack' }, h('h2', {}, '등장인물'), ...charRows, d.relations.length ? h('div', { class: 'small muted' }, '관계: ' + d.relations.map((r) => `${r.a}↔${r.b} ${r.relation}`).join(', ')) : null),
      h('div', { class: 'card stack' }, h('h2', {}, '장별 구성'), sumLine, ...chRows),
      h('div', { class: 'card stack' }, h('label', { class: 'fld' }, 'AI에게 구조 수정 요청 (선택) — 직접 고치지 않고 다시 설계하게 할 때', fb),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn', disabled: U.running, onclick: () => runDesign(work, fb.value) }, '다시 설계'), h('button', { class: 'btn', onclick: () => { U.wiz.stage = 'idea'; saveWiz(); N.render(); } }, '구상으로 돌아가기'),
          h('button', { class: 'btn primary', disabled: U.running, onclick: () => runDraft(work) }, '확정하고 초고 집필'))));
  }
  const clipS = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  async function runDraft(work) {
    if (U.running) return;
    await N.flushAndSave(); const fresh = await N.storage.getWork(work.id);
    const job = buildDraftJob(fresh); const chars = fresh.bible.design.chapters.reduce((a, c) => a + c.targetChars, 0);
    if (!(await confirmRun(job, { title: 'AI 초고 집필', target: `${fresh.bible.design.chapters.length}개 장 · 목표 약 ${fmt(chars)}자`, notes: ['장마다 장면 단위로 쓰고, 끝나면 AI가 다시 읽어 문제를 고칩니다. 분량이 목표와 크게 어긋나면 그 사실을 보고서에 적습니다.'] }))) return;
    U.wiz.stage = 'draft'; saveWiz(); await N.storage.putJob(job); N.render(); await execJob(job);
    if (job.status === 'done' || job.status === 'partial') { U.wiz.stage = 'done'; saveWiz(); }
    N.render();
  }
  async function draftJobOf(work) { return (await N.storage.listJobs(work.id)).filter((j) => j.type === 'draft').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; }
  async function draftStage(work) {
    const j = await draftJobOf(work);
    return h('div', { class: 'stack' }, !j && !U.running ? h('div', { class: 'card' }, '아직 집필을 시작하지 않았습니다.', h('div', { class: 'btn-row', style: 'margin-top:8px' }, h('button', { class: 'btn primary', onclick: () => runDraft(work) }, '초고 집필 시작'), h('button', { class: 'btn', onclick: () => { U.wiz.stage = 'design'; saveWiz(); N.render(); } }, '구조로 돌아가기'))) : null,
      j && !(U.job && U.job.id === j.id) ? jobPanel(j) : null);
  }
  async function doneStage(work) {
    const j = await draftJobOf(work); const oc = (await N.storage.listJobs(work.id)).filter((x) => x.type === 'oneclick').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const lengths = j && j.report && j.report.lengths;
    return h('div', { class: 'card stack' }, h('h2', {}, '초고가 만들어졌습니다'),
      h('div', { class: 'muted' }, '이것은 “초고”입니다. 자동 검토를 거쳤지만 완성작이 아니므로, 직접 읽고 고치거나 AI 개고·원클릭 완성으로 이어가세요.'),
      lengths ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl', style: 'min-width:0' }, h('thead', {}, h('tr', {}, h('th', {}, '장'), h('th', { class: 'num' }, '목표'), h('th', { class: 'num' }, '실제'))), h('tbody', {}, lengths.map((l) => h('tr', {}, h('td', {}, l.chapter + '장'), h('td', { class: 'num' }, fmt(l.target)), h('td', { class: 'num', style: l.actual < l.target * 0.7 || l.actual > l.target * 1.4 ? 'color:var(--warn-fg);font-weight:600' : '' }, fmt(l.actual))))))) : null,
      j && j.report.final && j.report.target ? h('div', { class: 'small' }, `전체 ${fmt(j.report.final.chars)}자 / 목표 ${fmt(j.report.target)}자 (${Math.round(j.report.final.ratio * 100)}%)`) : null,
      j && j.report.unprocessed.length ? h('div', { class: 'banner danger' }, '처리되지 못한 장: ' + j.report.unprocessed.map((u) => u.step).join(', ')) : null,
      oc ? h('div', { class: 'banner info' }, `원클릭 AI 완성(${STATUS_TXT[oc.status]})까지 실행했습니다. 완성본은 “AI 작업실”의 작업 목록에서 열 수 있습니다.`) : null,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onclick: async () => { const dj = j && j.resultVersionId; if (dj) await N.updateWork(work.id, (w) => { w.currentVersionId = dj; }); await N.openWork(work.id); } }, '집필 공간에서 열기'), h('button', { class: 'btn', onclick: () => N.openWork(work.id, null, 'ai') }, 'AI 개고·원클릭 완성으로 이어가기'), j ? h('button', { class: 'btn', onclick: () => showReport(j) }, '집필 보고서') : null));
  }

  /* ───────────── AI 작업실 (작품을 연 상태) ───────────── */
  function uiState() {
    if (U.ui.workId !== S.work.id) {
      const p = aiPrefs(), ai = !!S.work.aiGenerated; const auto = ai ? '적극형' : p.automation;
      U.ui = { workId: S.work.id, rev: { level: AUTO_LEVEL[auto], automation: auto, loop: true, loopMax: p.loopMax, extra: '', scopeAll: true, scope: new Set(), base: S.ver.id }, one: { automation: auto, loop: true, loopMax: p.loopMax, base: S.ver.id }, conv: { dir: S.work.format === 'script' ? 'script2novel' : 'novel2script', format: SCRIPT_FORMATS[1], mode: MODES[0][0], minutes: 20, scenes: 12, chars: 0, title: '', base: S.ver.id }, judge: { base: S.ver.id, chance: false } };
    }
    return U.ui;
  }
  async function renderAI(main) {
    await getSample(); await N.flushAndSave();
    const w = S.work, ui = uiState();
    const jobsEl = h('div', { class: 'stack' }), slot = h('div', { 'data-jobslot': w.id }, U.job && U.job.workId === w.id ? jobPanel(U.job) : null);
    main.append(h('div', { class: 'page-head' }, h('h1', {}, 'AI 작업실'), h('div', { class: 'small muted' }, `${w.title} · 현재 버전 ${S.ver.label}${S.ver.frozen ? '(고정)' : ''}`)), availBanner(),
      h('div', { class: 'banner info' }, 'AI 작업은 모두 새 버전으로 저장되고 원본은 바뀌지 않습니다. 작업 직전에 기준 버전을 자동으로 고정합니다. 잠금한 단락은 바꾸지 않습니다.'), slot,
      h('div', { class: 'cols', style: 'margin-top:12px;align-items:start' }, await reviseCard(ui), await oneclickCard(ui), await convertCard(ui), await judgeCard(ui)),
      h('div', { class: 'card stack', style: 'margin-top:14px' }, h('h2', {}, '작업 목록'), jobsEl),
      h('p', { class: 'small muted' }, '이번 버전에 없는 것: AI 교열 단독 실행, 장면별 AI 작업실, 장르 전환, 결말 재구성(다음 단계). 원클릭 완성에는 교열이 포함되어 있습니다.'));
    await drawJobs(jobsEl);
  }
  async function drawJobs(el) {
    const jobs = (await N.storage.listJobs(S.work.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    el.replaceChildren(...(jobs.length ? jobs.map((j) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, (A.TYPE_LABEL[j.type] || j.type) + ' ', h('span', { class: 'pill' }, STATUS_TXT[j.status] || j.status)), h('div', { class: 'small muted' }, `${fmtDate(j.createdAt)} · 호출 ${j.stats ? j.stats.calls : 0}회` + (j.pausedReason ? ' · ' + j.pausedReason : ''))),
      h('div', { class: 'btn-row', style: 'flex-wrap:nowrap' }, ['paused', 'failed', 'pending'].includes(j.status) && !(U.running) ? h('button', { class: 'btn sm primary', onclick: async () => { const r = await execJob(j); if (S.view === 'ai') N.render(); } }, '이어서') : null,
        h('button', { class: 'btn sm', onclick: () => showReport(j) }, '보고서'),
        h('button', { class: 'btn sm danger', disabled: U.running && U.job && U.job.id === j.id, onclick: async () => { if (await askConfirm({ title: '작업 기록 삭제', message: '이 작업의 기록(보고서·호출 기록)만 지웁니다. 결과로 만들어진 버전은 지워지지 않습니다.', confirmText: '기록 삭제', danger: true })) { await N.storage.deleteJob(j.id); if (U.job && U.job.id === j.id) U.job = null; N.render(); } } }, '삭제')))) : [h('div', { class: 'muted' }, '아직 실행한 AI 작업이 없습니다.')]));
  }
  const lockCount = (ver) => ver.chapters.reduce((a, c) => a + c.paragraphs.filter((p) => p.locked).length, 0);

  async function reviseCard(ui) {
    const R = ui.rev, base = h('select', { 'aria-label': '기준 버전', onchange: (e) => { R.base = e.target.value; } }, await versionOptions(R.base)); syncSel(base, R, 'base');
    const autoSel = h('select', { 'aria-label': '자동화 정도', onchange: (e) => { R.automation = e.target.value; R.level = AUTO_LEVEL[R.automation]; N.render(); } }, AUTOS.map((a) => h('option', { value: a, selected: R.automation === a }, `${a} — ${P.AUTOMATION[a]}`)));
    const chBox = h('div', { class: 'btn-row', hidden: R.scopeAll }, S.ver.chapters.map((c, i) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: R.scope.has(i), onchange: (e) => { e.target.checked ? R.scope.add(i) : R.scope.delete(i); } }), `${i + 1}장`)));
    const extra = h('textarea', { class: 'field', rows: 2, 'aria-label': '추가 지시', placeholder: '예: 2장의 대화를 더 길게 이어서, 설명은 줄여 주세요.' }); extra.value = R.extra; extra.addEventListener('input', () => { R.extra = extra.value; });
    return h('div', { class: 'card stack' }, h('h2', {}, 'AI 자동 개고'),
      h('div', { class: 'small muted' }, '원고를 읽고 문제를 진단한 뒤 실제로 고쳐 쓴 새 버전을 만듭니다. 수정 근거는 보고서에, 변경은 비교 화면에서 단락별로 되돌릴 수 있습니다.'),
      h('label', { class: 'fld' }, '기준 버전', base),
      h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'small muted' }, '개고 수준'), ...[1, 2, 3, 4, 5].map((n) => h('label', { class: 'chk', style: 'align-items:flex-start' }, h('input', { type: 'radio', name: 'revlevel', checked: R.level === n, onchange: () => { R.level = n; } }), h('span', {}, h('b', {}, `${n}. ${P.LEVELS[n].name}`), h('span', { class: 'small muted' }, ' — ' + P.LEVELS[n].rule.split('.')[0] + '.'))))),
      h('label', { class: 'fld' }, '자동화 정도', autoSel),
      h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'revscope', checked: R.scopeAll, onchange: () => { R.scopeAll = true; chBox.hidden = true; } }), '작품 전체'), h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'revscope', checked: !R.scopeAll, onchange: () => { R.scopeAll = false; chBox.hidden = false; } }), '선택한 장만'), chBox,
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: R.loop, onchange: (e) => { R.loop = e.target.checked; } }), '자기 교정 루프 — 고친 뒤 독립적으로 다시 진단하고, 나빠지면 그 회차를 버림 (최대 ' + R.loopMax + '회)'),
      h('label', { class: 'fld' }, '추가 지시 (선택)', extra),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', disabled: U.running, onclick: runRevise }, '개고 시작')));
  }
  async function runRevise() {
    const ui = uiState(), R = ui.rev, w = S.work;
    if (U.running) return;
    if (!R.scopeAll && !R.scope.size) { toast('개고할 장을 하나 이상 고르세요.', 'err'); return; }
    const base = await ensureFrozen(R.base || S.ver.id);
    const scope = R.scopeAll ? base.chapters.map((_, i) => i) : [...R.scope].sort((a, b) => a - b);
    const params = { level: R.level, automation: R.automation, baseVersionId: base.id, scope, loop: { on: R.loop, max: R.loopMax }, extra: R.extra.trim(), levelFixed: true, chapterChars: chapterChars(base) };
    const job = A.buildJob('revise', w, params, { chapterCount: base.chapters.length });
    const lk = lockCount(base);
    await launch(job, { title: 'AI 자동 개고', target: `기준 “${base.label}” · ${scope.length}개 장 · ${P.LEVELS[R.level].name} · ${R.automation}`, notes: [`기준 버전 “${base.label}”은(는) 고정되어 그대로 보존됩니다. 결과는 새 버전으로 저장됩니다.`, lk ? `잠금한 단락 ${lk}개는 바뀌지 않습니다.` : null, R.level >= 4 ? '이 수준에서는 장면이 삭제·추가·재배치될 수 있습니다. 결과는 비교 화면에서 단락별로 되돌릴 수 있습니다.' : null].filter(Boolean) });
    if (S.view === 'ai') N.render();
  }

  async function oneclickCard(ui) {
    const O = ui.one, base = h('select', { 'aria-label': '기준 버전(원클릭)', onchange: (e) => { O.base = e.target.value; } }, await versionOptions(O.base)); syncSel(base, O, 'base');
    const autoSel = h('select', { 'aria-label': '자동화 정도(원클릭)', onchange: (e) => { O.automation = e.target.value; } }, AUTOS.map((a) => h('option', { value: a, selected: O.automation === a }, `${a} — ${P.AUTOMATION[a]}`)));
    return h('div', { class: 'card stack' }, h('h2', {}, '원클릭 AI 완성'),
      h('div', { class: 'small muted' }, '읽기·구조 분석 → 결함·개연성 분석 → 개고 전략 → 개고 → 문장·대화 재검토 → 문체 일관성 → 교열 → 연속성 검증 → 최종 원고 → 최종 심사까지 순서대로 실행합니다. 개고 수준은 전략 단계에서 AI가 정하되 자동화 정도가 허용하는 범위 안에서만 움직입니다.'),
      h('label', { class: 'fld' }, '기준 버전', base), h('label', { class: 'fld' }, '자동화 정도', autoSel),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: O.loop, onchange: (e) => { O.loop = e.target.checked; } }), `자기 교정 루프 (최대 ${O.loopMax}회)`),
      h('div', { class: 'small muted' }, '교열은 AI의 판단이라 오류가 있을 수 있습니다. 명백한 오류만 반영하고 나머지는 목록으로 남깁니다. 응모 전에는 사람이나 전문 검사기로 한 번 더 확인하세요.'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', disabled: U.running, onclick: runOneclick }, '원클릭 완성 시작')));
  }
  async function runOneclick() {
    const ui = uiState(), O = ui.one, w = S.work; if (U.running) return;
    const base = await ensureFrozen(O.base || S.ver.id);
    const params = { level: AUTO_LEVEL[O.automation], automation: O.automation, baseVersionId: base.id, loop: { on: O.loop, max: O.loopMax }, chapterChars: chapterChars(base) };
    const job = A.buildJob('oneclick', w, params, { chapterCount: base.chapters.length });
    const lk = lockCount(base);
    await launch(job, { title: '원클릭 AI 완성', target: `기준 “${base.label}” · ${base.chapters.length}개 장 · ${O.automation}`, notes: [`기준 버전 “${base.label}”은(는) 그대로 보존됩니다. 결과는 새 버전, 심사 결과는 별도 기록으로 남습니다.`, lk ? `잠금한 단락 ${lk}개는 바뀌지 않습니다.` : null, '일부 단계에서 모델이 처리를 거부하거나 오류가 나면 그 부분은 원문을 유지하고 보고서에 “미처리”로 표시합니다.'].filter(Boolean) });
    if (S.view === 'ai') N.render();
  }

  async function convertCard(ui) {
    const V = ui.conv, base = h('select', { 'aria-label': '원작 버전', onchange: (e) => { V.base = e.target.value; } }, await versionOptions(V.base)); syncSel(base, V, 'base');
    const box = h('div', { class: 'stack' });
    const draw = () => {
      const n2s = V.dir === 'novel2script';
      box.replaceChildren(
        n2s ? h('label', { class: 'fld' }, '시나리오 형식', h('select', { 'aria-label': '시나리오 형식', onchange: (e) => { V.format = e.target.value; } }, SCRIPT_FORMATS.map((f) => h('option', { value: f, selected: V.format === f }, f)))) : null,
        n2s ? h('div', { class: 'grid2' }, h('label', { class: 'fld' }, '목표 러닝타임(분)', h('input', { type: 'number', min: 1, value: V.minutes, 'aria-label': '러닝타임', onchange: (e) => { V.minutes = Math.max(1, +e.target.value || 20); } })), h('label', { class: 'fld' }, '목표 장면 수', h('input', { type: 'number', min: 1, value: V.scenes, 'aria-label': '장면 수', onchange: (e) => { V.scenes = Math.max(1, +e.target.value || 10); } }))) : h('label', { class: 'fld' }, '목표 분량(글자, 0이면 원작에 맞춤)', h('input', { type: 'number', min: 0, value: V.chars, 'aria-label': '목표 글자 수', onchange: (e) => { V.chars = Math.max(0, +e.target.value || 0); } })),
        h('div', { class: 'stack', style: 'gap:4px' }, h('div', { class: 'small muted' }, '변환 방식'), ...MODES.map(([k, d]) => h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'convmode', checked: V.mode === k, onchange: () => { V.mode = k; } }), h('span', {}, h('b', {}, k), h('span', { class: 'small muted' }, ' — ' + d))))));
    };
    draw();
    const dirRad = (v, t) => h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'convdir', checked: V.dir === v, onchange: () => { V.dir = v; draw(); } }), t);
    const title = h('input', { type: 'text', 'aria-label': '새 작품 이름', placeholder: `${S.work.title} — ${V.dir === 'novel2script' ? '시나리오' : '소설'}` }); title.value = V.title; title.addEventListener('input', () => { V.title = title.value; });
    return h('div', { class: 'card stack' }, h('h2', {}, '시나리오 ↔ 소설 변환'),
      h('div', { class: 'small muted' }, '원작은 그대로 두고 새 작품(파생)으로 저장합니다. 원작과 변환본의 장면 대응표와, 핵심 사건·인물 관계를 바꾼 곳의 표시가 보고서에 나옵니다.'),
      h('div', { class: 'btn-row' }, dirRad('novel2script', '소설 → 시나리오'), dirRad('script2novel', '시나리오 → 소설')),
      h('label', { class: 'fld' }, '원작 버전', base), box, h('label', { class: 'fld' }, '새 작품 이름 (비우면 자동)', title),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', disabled: U.running, onclick: runConvert }, '변환 시작')));
  }
  async function runConvert() {
    const ui = uiState(), V = ui.conv, w = S.work; if (U.running) return;
    const base = await ensureFrozen(V.base || S.ver.id);
    const n2s = V.dir === 'novel2script', srcChars = C.countWithSpaces(C.versionText(base));
    const nw = N.defaultWork({ title: V.title.trim() || `${w.title} — ${n2s ? '시나리오' : '소설'}`, genre: '기타', status: '초고', format: n2s ? 'script' : 'novel', derivedFrom: { workId: w.id, versionId: base.id, kind: V.dir, title: w.title }, brief: w.brief, styleGuide: w.styleGuide, styleFingerprint: w.styleFingerprint, aiGenerated: true, memo: `「${w.title}」(${base.label})에서 AI로 변환한 작품입니다.` });
    const params = { direction: V.dir, baseVersionId: base.id, format: n2s ? V.format : '', modeText: `${V.mode} — ${MODES.find((m) => m[0] === V.mode)[1]}`, target: n2s ? { minutes: V.minutes, scenes: V.scenes } : { chars: V.chars || Math.round(srcChars * 2.5) }, newWork: nw };
    const chunks = A.convertChunks(base, Math.round(cfgFromPrefs().chunkChars * 1.3)).length;
    const job = A.buildJob('convert', w, params, { chunks }); job.params.chapterChars = chapterChars(base);
    await launch(job, { title: n2s ? '소설 → 시나리오' : '시나리오 → 소설', target: `원작 “${base.label}” (${fmt(srcChars)}자) → ${nw.title}`, notes: ['변환 결과는 새 작품으로 저장되고 원작은 바뀌지 않습니다. 핵심 사건이나 인물 관계를 바꾼 곳은 보고서에 따로 표시됩니다.'] });
    await N.loadWorks(); if (S.view === 'ai') N.render();
  }

  async function judgeCard(ui) {
    const J = ui.judge, base = h('select', { 'aria-label': '평가할 버전', onchange: (e) => { J.base = e.target.value; } }, await versionOptions(J.base)); syncSel(base, J, 'base');
    const rv = (S.work.reviews || []).slice().reverse();
    return h('div', { class: 'card stack' }, h('h2', {}, '전체 작품 진단 — 심사위원'),
      h('div', { class: 'small muted' }, '냉정한 심사위원 역할로 다섯 항목을 평가합니다. 점수는 참고이며 등급은 평균으로 계산합니다. 분량이 길어 전체를 읽지 못하면 읽은 범위를 보고서에 밝힙니다.'),
      h('label', { class: 'fld' }, '평가할 버전', base),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: J.chance, onchange: (e) => { J.chance = e.target.checked; } }), '당선 가능성 추정도 보기 (주관적 추정)'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', disabled: U.running, onclick: runJudge }, '진단 시작')),
      rv.length ? h('div', { class: 'list' }, h('div', { class: 'small muted' }, '지난 심사'), rv.slice(0, 6).map((r) => h('div', { class: 'row hit', onclick: () => showJudge(r, { chance: true }) }, h('div', { class: 'grow' }, h('div', { class: 't' }, `${r.verdict.grade} · ${r.verdict.label} (평균 ${r.verdict.avg})`), h('div', { class: 'small muted' }, `${fmtDate(r.createdAt)} · ${r.versionLabel}`))))) : null);
  }
  async function runJudge() {
    const ui = uiState(), J = ui.judge; if (U.running) return;
    const base = await ensureFrozen(J.base || S.ver.id);
    const job = A.buildJob('judge', S.work, { versionId: base.id, chance: J.chance });
    const done = await launch(job, { title: '심사위원 진단', target: `“${base.label}” (${fmt(C.countWithSpaces(C.versionText(base)))}자)`, notes: ['평가는 원고에 근거해 냉정하게 이뤄지고, 등급과 확률은 문학적 추정입니다.'] });
    if (done && done.report && done.report.judge) { showJudge(done.report.judge, { chance: J.chance }); if (S.view === 'ai') N.render(); }
  }

  /* ───────────── 보고서 ───────────── */
  const sec = (t, ...kids) => h('div', { class: 'card stack', style: 'gap:8px' }, h('h2', {}, t), ...kids);
  const textOf = (s) => h('div', { style: 'white-space:pre-wrap;overflow-wrap:anywhere' }, s || '(없음)');
  function showJudge(rec, o) {
    modal({ title: '심사위원 보고서', wide: true, body: judgeEl(rec, o || {}), actions: (close) => h('button', { class: 'btn primary', onclick: () => close() }, '닫기') });
  }
  function judgeEl(rec, o) {
    const R = rec.report, v = rec.verdict, prev = (S.work && S.work.reviews || []).filter((x) => x.createdAt < rec.createdAt && x.id !== rec.id).slice(-1)[0];
    const bar = (k) => { const s = R.scores[k]; const pv = prev && prev.report.scores[k]; return h('div', { class: 'stack', style: 'gap:2px' }, h('div', { class: 'bar' }, h('span', {}, k), h('i', { style: `width:${s.score * 10}%` }), h('span', { class: 'mono' }, s.score + (pv ? ` (${s.score - pv.score >= 0 ? '+' : ''}${s.score - pv.score})` : ''))), h('div', { class: 'small' }, s.reason), s.evidence && s.evidence.length ? h('div', { class: 'small muted' }, '근거: ' + s.evidence.join(' / ')) : null); };
    const rebuttals = h('div', { class: 'stack' }, ...((rec.rebuttals || []).map((r) => h('div', { class: 'card', style: 'padding:10px' }, h('div', { class: 'small muted' }, '작가 반론: ' + r.objection), textOf(r.answer)))));
    const ta = h('textarea', { class: 'field', rows: 3, 'aria-label': '반론', placeholder: '동의하지 않는 지적과 이유를 적으면, 심사위원이 반론을 검토해 평가를 유지하거나 고칩니다.' });
    return h('div', { class: 'stack' },
      h('div', { class: 'card stack' }, h('div', { style: 'display:flex;gap:16px;align-items:center;flex-wrap:wrap' }, h('div', { style: 'font-size:44px;font-weight:700;line-height:1;color:var(--accent)' }, v.grade), h('div', {}, h('div', { style: 'font-size:16px;font-weight:600' }, `종합 판정: ${v.label}`), h('div', { class: 'small muted' }, `다섯 항목 평균 ${v.avg}점 · ${rec.versionLabel} · ${fmtDate(rec.createdAt)}`))),
        h('div', { class: 'banner' + (rec.full ? ' info' : '') }, '읽은 범위: ' + rec.coverage), h('div', { class: 'small muted' }, rec.disclaimer + (prev ? ' 괄호는 직전 심사 대비 점수 변화입니다.' : ''))),
      sec('항목별 점수', ...A.JUDGE_KEYS.map(bar)),
      sec('2. 작품의 가장 큰 장점', textOf(R.strengths)), sec('3. 작품의 가장 치명적인 약점', textOf(R.fatalWeakness)), sec('4. 서사 구조 분석', textOf(R.structure)), sec('5. 인물 분석', textOf(R.characters)), sec('6. 문장 분석', textOf(R.prose)), sec('7. 결말 분석', textOf(R.ending)), sec('8. 당선 경쟁에서 불리한 요소', textOf(R.disadvantages)),
      sec('9. 개고가 필요한 부분', R.revisionNeeds.length ? h('ul', { style: 'margin:0;padding-left:18px' }, R.revisionNeeds.map((x) => h('li', {}, `${x.where}: ${x.what}`))) : textOf('')), sec('10. 최종 심사평', textOf(R.finalReview)),
      o.chance && R.winChancePercent != null ? h('div', { class: 'banner' }, `당선 가능성 추정: 약 ${R.winChancePercent}% — ${R.winChanceBasis || ''} 실제 통계가 아니라 문학적 판단에 근거한 주관적 추정입니다.`) : null,
      sec('작가 반론', rebuttals, ta, h('div', { class: 'btn-row' }, h('button', { class: 'btn', disabled: U.running, onclick: async (e) => { if (!ta.value.trim()) return; e.target.disabled = true; try { const ans = await rebut(rec, ta.value.trim()); rec.rebuttals = (rec.rebuttals || []).concat([{ objection: ta.value.trim(), answer: ans, at: C.nowIso() }]); await N.updateWork(S.work.id, (w) => { const t = (w.reviews || []).find((x) => x.id === rec.id); if (t) t.rebuttals = rec.rebuttals; }); rebuttals.append(h('div', { class: 'card', style: 'padding:10px' }, h('div', { class: 'small muted' }, '작가 반론: ' + ta.value.trim()), textOf(ans))); ta.value = ''; } catch (err) { toast('반론을 검토하지 못했습니다: ' + (err.message || err.code), 'err'); } e.target.disabled = false; } }, '반론 검토 요청'))));
  }
  async function rebut(rec, objection) {
    const sample = await getSample(); if (!sample) throw new Error('AI를 사용할 수 없습니다.');
    const engine = A.createEngine({ sample, config: cfgFromPrefs() });
    const base = await N.storage.getVersion(rec.versionId);
    const excerpt = base ? A.buildJudgeInput(base, S.work, 60000).text : '';
    const r = await engine.call({ role: '심사위원', task: 'rebuttal', label: '반론 검토', prompt: P.T.rebuttal({ report: JSON.stringify(rec.report), objection, excerpt }) });
    return r.text;
  }

  function showReport(job) {
    const r = job.report || {}, body = [];
    body.push(h('dl', { class: 'kv' }, h('dt', {}, '작업'), h('dd', {}, A.TYPE_LABEL[job.type] || job.type), h('dt', {}, '상태'), h('dd', {}, STATUS_TXT[job.status] || job.status), h('dt', {}, '호출'), h('dd', {}, `${job.stats ? job.stats.calls : 0}회 · 입력 ${fmt(job.stats ? job.stats.inChars : 0)}자 · 출력 ${fmt(job.stats ? job.stats.outChars : 0)}자`), h('dt', {}, '프롬프트 버전'), h('dd', {}, P.PROMPT_VERSION)));
    if ((r.unprocessed || []).length) body.push(h('div', { class: 'banner danger' }, h('div', {}, h('b', {}, '처리하지 못한 곳 (원문·빈칸 그대로 남아 있음)'), h('ul', { style: 'margin:6px 0 0;padding-left:18px' }, r.unprocessed.map((u) => h('li', {}, `${u.step} — ${u.reason}`))))));
    if ((r.warnings || []).length) body.push(sec('주의', h('ul', { style: 'margin:0;padding-left:18px' }, r.warnings.map((x) => h('li', {}, x)))));
    if (job.type === 'draft') {
      if (r.lengths) body.push(sec('분량', h('div', { class: 'small' }, `목표 ${fmt(r.target)}자 → 실제 ${fmt(r.final.chars)}자 (${Math.round(r.final.ratio * 100)}%)`), h('table', { class: 'tbl', style: 'min-width:0' }, h('thead', {}, h('tr', {}, h('th', {}, '장'), h('th', { class: 'num' }, '목표'), h('th', { class: 'num' }, '실제'))), h('tbody', {}, r.lengths.map((l) => h('tr', {}, h('td', {}, l.chapter + '장'), h('td', { class: 'num' }, fmt(l.target)), h('td', { class: 'num' }, fmt(l.actual))))))));
      if (r.reviews) body.push(sec('자동 검토', h('table', { class: 'tbl', style: 'min-width:0' }, h('thead', {}, h('tr', {}, h('th', {}, '장'), h('th', { class: 'num' }, '지적'), h('th', { class: 'num' }, '중요 이상'), h('th', {}, '반영'))), h('tbody', {}, r.reviews.filter(Boolean).map((x) => h('tr', {}, h('td', {}, x.chapter + '장'), h('td', { class: 'num' }, x.issues), h('td', { class: 'num' }, x.serious), h('td', {}, x.fixed ? '새 판에 반영' : x.serious ? '반영 못함' : '-')))))));
    }
    if (job.type === 'revise' || job.type === 'oneclick') reviseSections(job, body);
    if (job.type === 'convert') {
      body.push(sec('결과', h('div', {}, `변환본 ${fmt((r.final || {}).chars)}자` + (r.final && r.final.scenes ? ` · 장면 ${r.final.scenes}개` : '')), job.state && job.state.newWorkId ? h('button', { class: 'btn', onclick: () => N.openWork(job.state.newWorkId) }, '변환본 작품 열기') : null));
      if ((r.coreChanges || []).length) body.push(sec('핵심 사건·인물 관계를 바꾼 곳', h('ul', { style: 'margin:0;padding-left:18px' }, r.coreChanges.map((c) => h('li', {}, `${c.target} ← ${c.source}: ${c.note || '변경'}`)))));
      if ((r.sceneMap || []).length) body.push(sec('원작 ↔ 변환본 장면 대응표', h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl', style: 'min-width:0' }, h('thead', {}, h('tr', {}, ['변환본', '원작', '관계', '비고'].map((t) => h('th', {}, t)))), h('tbody', {}, r.sceneMap.map((s) => h('tr', {}, h('td', {}, s.target), h('td', {}, s.source), h('td', {}, h('span', { class: 'pill ' + (s.relation === '유지' ? '' : s.relation === '신규' ? 'accent' : 'warn') }, s.relation), s.coreChange ? h('span', { class: 'pill warn', style: 'margin-left:4px' }, '핵심 변경') : null), h('td', {}, s.note))))))));
    }
    if (job.type === 'judge' && r.judge) body.push(judgeEl(r.judge, { chance: job.params.chance }));
    modal({ title: `결과 보고서 — ${A.TYPE_LABEL[job.type] || job.type}`, wide: true, body: h('div', { class: 'stack' }, body),
      actions: (close) => [job.resultVersionId && job.params.baseVersionId && job.type !== 'convert' ? h('button', { class: 'btn', onclick: () => { close(); S.cmpA = job.params.baseVersionId; S.cmpB = job.resultVersionId; N.go('compare'); } }, '원본과 비교') : null, job.resultVersionId ? h('button', { class: 'btn', onclick: () => { close(); openResult(job); } }, '결과 버전 열기') : null, h('button', { class: 'btn primary', onclick: () => close() }, '닫기')] });
  }
  function reviseSections(job, body) {
    const r = job.report;
    if (r.diff) body.push(sec('원본 대비 변경', h('div', { class: 'btn-row' }, h('span', { class: 'pill' }, `같음 ${r.diff.same}`), h('span', { class: 'pill warn' }, `수정 ${r.diff.mod}`), h('span', { class: 'pill accent' }, `추가 ${r.diff.add}`), h('span', { class: 'pill', style: 'background:var(--del-bg);color:var(--del-fg)' }, `삭제 ${r.diff.del}`)), r.base && r.final ? h('div', { class: 'small muted' }, `${fmt(r.base.chars)}자 → ${fmt(r.final.chars)}자 (기준 “${r.base.label}”)`) : null));
    if ((r.deleted || []).length) body.push(sec('삭제된 단락', ...r.deleted.slice(0, 15).map((d) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'small muted' }, d.chapter), h('div', { class: 'ctx' }, clipS(d.text, 160)))))));
    if ((r.added || []).length) body.push(sec('추가된 단락', ...r.added.slice(0, 15).map((d) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'small muted' }, d.chapter), h('div', { class: 'ctx' }, clipS(d.text, 160)))))));
    if ((r.examples || []).length) body.push(sec('주요 문장 수정 사례', ...r.examples.slice(0, 8).map((e) => h('div', { class: 'diff', style: 'grid-template-columns:1fr 1fr' }, h('div', { class: 'c l del' }, e.before), h('div', { class: 'c r add' }, e.after)))));
    if ((r.loops || []).length) body.push(sec('자기 교정 루프', h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl', style: 'min-width:0' }, h('thead', {}, h('tr', {}, ['장', '회차', '이전 문제', '해결', '악화', '새 문제', '고친 뒤 문제', '결정'].map((t) => h('th', {}, t)))), h('tbody', {}, r.loops.map((l) => h('tr', {}, h('td', {}, l.chapter + '장'), h('td', {}, l.round), h('td', { class: 'num' }, l.before), h('td', { class: 'num' }, l.resolved), h('td', { class: 'num' }, l.worse), h('td', { class: 'num' }, l.newIssues), h('td', { class: 'num' }, l.after), h('td', {}, l.decision))))))));
    if (r.structure && r.structure.issues.length) body.push(sec('구조 진단', h('ul', { style: 'margin:0;padding-left:18px' }, r.structure.issues.map((i) => h('li', {}, `[${i.severity}] ${i.chapters.join(',')}장: ${i.problem} → ${i.fix}`)))));
    if (r.strategy) body.push(sec('개고 전략', h('div', { class: 'small' }, `권장 수준 ${r.strategy.level} (${P.LEVELS[r.strategy.level].name}) · 실제 적용 ${job.params.level}`), r.strategy.global.length ? h('div', { class: 'small' }, r.strategy.global.join(' / ')) : null));
    if (r.proofread) body.push(sec('교열 내역 (AI 판단 — 맞춤법 검사기가 아닙니다)', h('div', { class: 'small' }, `반영한 확정 오류 ${r.proofread.applied.length}건 · 권장 ${r.proofread.recommended.length}건 · 작가 확인 ${r.proofread.confirm.length}건 · 원문에서 못 찾아 버린 항목 ${r.proofread.notFound}건`),
      ...r.proofread.applied.slice(0, 20).map((f) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'small muted' }, `${f.chapter}장 · ${f.reason}`), h('div', { class: 'ctx' }, h('s', {}, f.orig), ' → ', h('b', {}, f.fixed))))), r.proofread.recommended.length ? h('details', {}, h('summary', { class: 'small', style: 'cursor:pointer' }, '반영하지 않은 권장 표현'), ...r.proofread.recommended.slice(0, 30).map((f) => h('div', { class: 'small' }, `${f.chapter}장: ${f.orig} → ${f.fixed} (${f.reason})`))) : null, r.proofread.confirm.length ? h('details', {}, h('summary', { class: 'small', style: 'cursor:pointer' }, '작가 확인 필요 (임의로 고치지 않음)'), ...r.proofread.confirm.slice(0, 30).map((f) => h('div', { class: 'small' }, `${f.chapter}장: ${f.orig} → ${f.fixed} (${f.reason})`))) : null));
    if (r.continuity) body.push(sec('연속성 검증', r.continuity.fixed.length ? h('div', {}, h('div', { class: 'small muted' }, '고친 설정 충돌'), h('ul', { style: 'margin:0;padding-left:18px' }, r.continuity.fixed.map((c) => h('li', {}, `${c.chapter}장 [${c.kind}] ${c.problem} (확정: ${c.established})`)))) : h('div', { class: 'muted' }, '자동으로 고친 충돌은 없습니다.'), r.continuity.confirm.length ? h('div', {}, h('div', { class: 'small muted' }, '작가 확인이 필요한 곳 (고치지 않음)'), h('ul', { style: 'margin:0;padding-left:18px' }, r.continuity.confirm.map((c) => h('li', {}, `${c.chapter}장 [${c.kind}] ${c.problem}` + (c.question ? ' — ' + c.question : ''))))) : null));
    if (r.style && r.style.inconsistent.length) body.push(sec('문체 일관성', h('ul', { style: 'margin:0;padding-left:18px' }, r.style.inconsistent.map((x) => h('li', {}, `${x.no}장: ${x.problem || ''} ${x.instruction ? '→ ' + x.instruction : ''}`)))));
    if (r.judge) body.push(sec('최종 심사위원 평가', judgeEl(r.judge, { chance: false })));
  }

  /* ───────────── 시작 ───────────── */
  async function init(app) {
    N = app; ({ h, S, $, fmt, fmtDate, toast, modal, askConfirm } = app);
    N.views.wizard = renderWizard; N.views.ai = renderAI; N.hooks.settings.push(settingsCard); N.hooks.afterRender = updateStrip;
    const jobs = await N.storage.listJobs();
    for (const j of jobs) if (j.status === 'running') { j.status = 'paused'; j.pausedReason = '창을 닫거나 새로고침해 중단되었습니다. 저장된 지점부터 이어서 진행할 수 있습니다.'; j.steps.forEach((s) => { if (s.status === 'running') s.status = 'pending'; }); await N.storage.putJob(j); }
    const m = await N.storage.getMeta('wizard'); if (m) U.wiz = Object.assign(U.wiz, m);
    if (!U.wiz.form) U.wiz.form = defaultForm();
    const last = jobs.filter((j) => j.status === 'paused').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]; if (last) U.job = last;
    window.__NSAI = { U, execJob, showReport };
  }
  window.NSAIUI = { init };
})();
