/* 소설 작업실 — ai.js
 * AI 작업 엔진: 호출 래퍼(재시도·거부·잘림·형식 검증·로그), 단계(step) 기반 작업 실행기.
 * UI와 저장소는 주입받는다. sample() 은 아티팩트의 claude.use("sample") 함수다.
 * 모든 작업은 단계마다 저장되어 중단 지점부터 재개할 수 있다. */
(function (root, factory) {
  const m = factory(typeof self !== 'undefined' && self.NSCore ? self.NSCore : require('./core.js'), typeof self !== 'undefined' && self.NSPrompts ? self.NSPrompts : require('./prompts.js'));
  if (typeof module !== 'undefined' && module.exports) module.exports = m;
  else root.NSAI = m;
})(typeof self !== 'undefined' ? self : this, function (C, P) {
  'use strict';

  /* ───────────── 설정 ───────────── */
  const DEFAULT_CONFIG = {
    chunkChars: 2800,          // 한 번에 쓰게 할 장면 길이 상한(공백 포함 글자)
    reviseChunkChars: 2600,    // 개고 때 한 번에 보내는 본문 길이
    reviseChunkChars5: 5000,
    retries: 2, backoffMs: 4000,
    maxPromptBytes: 240000,
    judgeBytes: 150000,
    tiers: { 기획자: 'default', 소설가: 'complex', 각색자: 'complex', 구조편집자: 'complex', 문장편집자: 'complex', 교열자: 'default', 연속성감독: 'default', 심사위원: 'complex', 요약자: 'quick' },
    avgMs: { quick: 4000, default: 30000, complex: 50000 },
    sceneBreak: true,
  };
  const ROLE_NAMES = Object.keys(P.ROLES);

  /* ───────────── 오류 ───────────── */
  class AIError extends Error {
    constructor(code, message, extra) { super(message || code); this.name = 'AIError'; this.code = code; Object.assign(this, extra || {}); }
  }
  const FATAL = new Set(['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'invalid_request', 'transform_error', 'tools_unavailable']);
  const PAUSE = new Set(['rate_limited', 'session_expired', 'cancelled', 'upstream_error', 'queue_overflow']);
  const bytes = (s) => new TextEncoder().encode(String(s)).length;
  const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
  const hashStr = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h) + ':' + s.length; };

  /* ───────────── JSON 추출·검증 ───────────── */
  function extractJSON(text) {
    const t = String(text).trim();
    try { return JSON.parse(t); } catch (e) { /* 아래에서 본문 추출 */ }
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
    if (fence) { try { return JSON.parse(fence[1]); } catch (e) { /* 계속 */ } }
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* 계속 */ } }
    throw new AIError('invalid_json', 'JSON을 읽지 못했습니다.', { text: t });
  }
  const isS = (x) => typeof x === 'string', isN = (x) => typeof x === 'number' && isFinite(x), isA = Array.isArray, isO = (x) => x && typeof x === 'object' && !isA(x);
  const V = {};
  V.idea = (o) => { const e = []; if (!isO(o)) return ['객체가 아닙니다']; ['logline', 'coreIdea', 'protagonistDesire', 'mainConflict', 'expectedEnding'].forEach((k) => { if (!isS(o[k]) || !o[k].trim()) e.push(k + ' 누락'); }); if (!isA(o.differentiators)) o.differentiators = []; if (!isA(o.similar)) o.similar = []; if (!isA(o.assumed)) o.assumed = []; if (!isS(o.cause)) o.cause = ''; return e; };
  V.design = (o) => {
    const e = []; if (!isO(o)) return ['객체가 아닙니다'];
    if (!isS(o.synopsis) || !o.synopsis.trim()) e.push('synopsis 누락');
    if (!isA(o.characters) || !o.characters.length) e.push('characters 누락'); else o.characters.forEach((c) => { if (!c || !isS(c.name)) e.push('인물 이름 누락'); });
    if (!isA(o.chapters) || !o.chapters.length) e.push('chapters 누락');
    else o.chapters.forEach((c, i) => { if (!isO(c) || !isS(c.title)) e.push(`${i + 1}장 title 누락`); else { c.no = i + 1; if (!isA(c.keyEvents)) c.keyEvents = []; if (!isS(c.summary)) c.summary = ''; if (!isA(c.scenes) || !c.scenes.length) c.scenes = [{ summary: c.summary, targetChars: +c.targetChars || 0 }]; c.scenes.forEach((s) => { if (!isS(s.summary)) s.summary = ''; s.targetChars = +s.targetChars || 0; }); c.targetChars = +c.targetChars || 0; } });
    ['relations', 'events', 'twists'].forEach((k) => { if (!isA(o[k])) o[k] = []; });
    return e;
  };
  V.diagnose = (o) => { if (!isO(o)) return ['객체가 아닙니다']; if (!isA(o.issues)) return ['issues 누락']; if (!isA(o.aiTells)) o.aiTells = []; if (!isS(o.summary)) o.summary = ''; const sev = ['치명', '중요', '경미']; o.issues = o.issues.filter((i) => isO(i)).map((i, k) => ({ id: isS(i.id) && i.id ? i.id : 'I' + (k + 1), severity: sev.includes(i.severity) ? i.severity : '중요', type: i.type || '', quote: isS(i.quote) ? i.quote : '', problem: isS(i.problem) ? i.problem : '', fix: isS(i.fix) ? i.fix : '' })); return []; };
  V.track = (o) => { if (!isO(o) || !isA(o.previous)) return ['previous 누락']; if (!isA(o.newIssueIds)) o.newIssueIds = []; return []; };
  V.revisePlan = (o) => { if (!isO(o) || !isA(o.actions)) return ['actions 누락']; if (!isA(o.keep)) o.keep = []; return []; };
  V.summarize = (o) => { if (!isO(o) || !isS(o.summary)) return ['summary 누락']; ['characters', 'facts', 'events'].forEach((k) => { if (!isA(o[k])) o[k] = []; }); return []; };
  V.proofread = (o) => { if (!isO(o) || !isA(o.fixes)) return ['fixes 누락']; o.fixes = o.fixes.filter((f) => isO(f) && isS(f.orig) && isS(f.fixed) && f.orig !== '' && f.orig !== f.fixed).map((f) => ({ orig: f.orig, fixed: f.fixed, kind: ['확정', '권장', '작가확인'].includes(f.kind) ? f.kind : '작가확인', reason: f.reason || '' })); return []; };
  V.continuity = (o) => { if (!isO(o) || !isA(o.conflicts)) return ['conflicts 누락']; o.conflicts = o.conflicts.filter(isO).map((c) => ({ kind: c.kind || '기타', quote: c.quote || '', established: c.established || '', problem: c.problem || '', severity: ['치명', '중요', '경미'].includes(c.severity) ? c.severity : '중요', maybeIntentional: !!c.maybeIntentional, question: c.question || '', fix: c.fix || '' })); return []; };
  V.structure = (o) => { if (!isO(o) || !isA(o.issues)) return ['issues 누락']; if (!isA(o.strengths)) o.strengths = []; o.issues = o.issues.filter(isO).map((i, k) => ({ id: i.id || 'S' + (k + 1), severity: ['치명', '중요', '경미'].includes(i.severity) ? i.severity : '중요', chapters: isA(i.chapters) ? i.chapters : [], problem: i.problem || '', fix: i.fix || '' })); return []; };
  V.strategy = (o) => { if (!isO(o)) return ['객체가 아닙니다']; o.level = Math.min(5, Math.max(1, Math.round(+o.level) || 4)); if (!isA(o.global)) o.global = []; if (!isA(o.chapters)) o.chapters = []; return []; };
  V.styleCheck = (o) => { if (!isO(o) || !isA(o.inconsistent)) return ['inconsistent 누락']; return []; };
  V.sceneMap = (o) => { if (!isO(o) || !isA(o.scenes)) return ['scenes 누락']; o.scenes = o.scenes.filter(isO).map((s) => ({ target: String(s.target || ''), source: String(s.source || ''), relation: ['유지', '변경', '삭제', '신규'].includes(s.relation) ? s.relation : '변경', coreChange: !!s.coreChange, note: s.note || '' })); return []; };
  const JUDGE_KEYS = ['완성도', '신선함', '문장력', '인물 생동감', '결말의 힘'];
  V.judge = (o) => {
    if (!isO(o) || !isO(o.scores)) return ['scores 누락'];
    const e = [];
    JUDGE_KEYS.forEach((k) => { const s = o.scores[k]; if (!isO(s) || !isN(+s.score)) e.push(k + ' 점수 누락'); else { s.score = Math.min(10, Math.max(1, +s.score)); if (!isS(s.reason)) s.reason = ''; if (!isA(s.evidence)) s.evidence = []; } });
    ['strengths', 'fatalWeakness', 'structure', 'characters', 'prose', 'ending', 'disadvantages', 'finalReview'].forEach((k) => { if (!isS(o[k])) o[k] = ''; });
    if (!isA(o.revisionNeeds)) o.revisionNeeds = [];
    return e;
  };
  function verdictOf(scores) {
    const avg = JUDGE_KEYS.reduce((a, k) => a + scores[k].score, 0) / JUDGE_KEYS.length;
    const v = avg >= 8.5 ? 'S' : avg >= 7 ? 'A' : avg >= 5.5 ? 'B' : avg >= 3.5 ? 'C' : 'D';
    return { avg: Math.round(avg * 10) / 10, grade: v, label: { S: '당선권', A: '본선권', B: '예심 통과권', C: '탈락', D: '응모 부적합' }[v] };
  }

  /* ───────────── 본문 도구 ───────────── */
  const META_LEAD = /^(다음은|아래는|위는|이상입니다|요청하신|알겠습니다|네,|물론|물론입니다|\*\*|#{1,4}\s|---+$|```)/;
  const META_TAIL = /^(※|\(글자|\(약\s*\d|글자\s*수|\[끝\]|\(끝\)|이상\s*[,.]|---+$|```)/;
  function cleanProse(raw) {
    let t = String(raw || '').replace(/\r\n?/g, '\n').trim();
    const removed = [];
    t = t.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
    let lines = t.split('\n');
    while (lines.length && META_LEAD.test(lines[0].trim()) && lines[0].trim().length < 80) removed.push(lines.shift());
    while (lines.length && META_TAIL.test(lines[lines.length - 1].trim()) ) removed.push(lines.pop());
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    while (lines.length && lines[0].trim() === '') lines.shift();
    // 문단 사이 빈 줄은 문단 구분으로 한 번만 남긴다 → 우리는 줄바꿈 하나가 문단이므로 연속 빈 줄 제거
    t = lines.join('\n').replace(/\n{2,}/g, '\n');
    return { text: t, removed };
  }
  const TERMINAL = /[.!?…。”’"')」』\]]$/;
  const looksTruncated = (t) => { const s = String(t).trim(); return s.length > 0 && !TERMINAL.test(s); };
  const lastChars = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(-n) : t; };

  // 문단 배열을 입력 한도(글자) 이하의 묶음으로 나눈다. 문단은 쪼개지 않는다.
  function chunkParas(texts, maxChars) {
    const chunks = []; let cur = [], len = 0;
    texts.forEach((t) => { if (cur.length && len + t.length + 1 > maxChars) { chunks.push(cur); cur = []; len = 0; } cur.push(t); len += t.length + 1; });
    if (cur.length) chunks.push(cur);
    return chunks;
  }
  const lockToken = (n) => `⟦잠금${n}⟧`;
  // 잠금 단락을 표지로 바꾼 줄 배열과 복원 표를 만든다.
  function lockify(paras) {
    const locks = []; const lines = paras.map((p) => { if (p.locked) { locks.push(p.text); return lockToken(locks.length); } return p.text; });
    return { lines, locks };
  }
  function restoreLocks(text, locks, offset) {
    // offset: 이 묶음의 첫 잠금 번호 − 1. 표지가 정확히 한 번씩, 순서대로 있어야 한다.
    const found = []; const re = /⟦잠금(\d+)⟧/g; let m; while ((m = re.exec(text))) found.push(+m[1]);
    const want = locks.map((_, i) => offset + i + 1);
    if (found.length !== want.length || found.some((n, i) => n !== want[i])) return null;
    return text.replace(/⟦잠금(\d+)⟧/g, (s, n) => locks[+n - offset - 1]);
  }
  function driftOk(oldText, newText, level) {
    const L = P.LEVELS[level]; if (!L) return true;
    const a = Math.max(1, C.countNoSpaces(oldText)), b = C.countNoSpaces(newText), r = b / a;
    return r >= L.min && r <= L.max;
  }
  const chapText = (ver, i) => (ver.chapters[i] ? C.chapterText(ver.chapters[i]) : '');

  // 개고 결과를 기존 단락에 맞춰 반영한다: ID 보존, 출처 표시, 잠금 단락 원문 복구.
  function applyRevision(oldParas, newText, source) {
    const oldById = new Map(oldParas.map((p) => [p.id, p]));
    const merged = C.reconcileParagraphs(oldParas, newText);
    const out = merged.map((p) => {
      const o = oldById.get(p.id);
      if (!o) return Object.assign({}, p, { source: source || 'ai' });
      if (o.locked && o.text !== p.text) return Object.assign(C.newParagraph(p.text), { source: source || 'ai' }); // 잠금 단락의 ID를 다른 글에 내주지 않는다
      if (o.text !== p.text) return Object.assign({}, p, { source: o.source === 'ai' ? 'ai' : (source ? source + '-edit' : 'ai-edit') });
      return p;
    });
    // 사라진 잠금 단락은 원래 위치 근처(앞 단락 뒤)에 되살린다.
    const have = new Set(out.map((p) => p.id));
    oldParas.forEach((p, i) => {
      if (p.locked && !have.has(p.id)) {
        let at = 0; for (let k = i - 1; k >= 0; k--) { const idx = out.findIndex((q) => q.id === oldParas[k].id); if (idx >= 0) { at = idx + 1; break; } }
        out.splice(at, 0, p); have.add(p.id);
      }
    });
    return out;
  }

  /* ───────────── 설정집(bible) ───────────── */
  function bibleText(work, o) {
    o = Object.assign({ maxChars: 5000, upTo: null }, o || {});
    const b = work.bible || {}, d = b.design || {}, parts = [];
    if (b.idea && b.idea.logline) parts.push('로그라인: ' + b.idea.logline);
    if (d.synopsis) parts.push('시놉시스: ' + clip(d.synopsis, 1200));
    const chars = (d.characters && d.characters.length ? d.characters : b.extractedCharacters || []);
    if (chars.length) parts.push('등장인물:\n' + chars.slice(0, 14).map((c) => `- ${c.name}(${c.age || '?'}${c.role ? ', ' + c.role : ''})${c.desire ? ' 욕망: ' + c.desire : ''}${c.traits ? ' 특징: ' + c.traits : ''}${c.speech ? ' 말투: ' + c.speech : ''}`).join('\n'));
    if (d.relations && d.relations.length) parts.push('관계: ' + d.relations.slice(0, 12).map((r) => `${r.a}-${r.b}:${r.relation}`).join(', '));
    const sums = b.chapterSummaries || [];
    const chs = d.chapters || [];
    const n = Math.max(sums.length, chs.length), upTo = o.upTo == null ? n : Math.min(n, o.upTo);
    const lines = []; for (let i = 0; i < upTo; i++) { const s = sums[i] || (chs[i] && chs[i].summary); if (s) lines.push(`${i + 1}장${chs[i] && chs[i].title ? ' ' + chs[i].title : ''}: ${clip(s, 260)}`); }
    if (lines.length) parts.push('장별 요약:\n' + lines.join('\n'));
    if (b.facts && b.facts.length) parts.push('확정된 사실:\n' + b.facts.filter((f) => o.upTo == null || f.chapter <= o.upTo).slice(-40).map((f) => `- [${f.kind || '기타'}] ${f.fact}`).join('\n'));
    return clip(parts.join('\n\n'), o.maxChars);
  }

  /* ───────────── 엔진: 호출 래퍼 ───────────── */
  function createEngine(env) {
    const sample = env.sample, cfg = Object.assign({}, DEFAULT_CONFIG, env.config || {});
    cfg.tiers = Object.assign({}, DEFAULT_CONFIG.tiers, (env.config && env.config.tiers) || {});
    const sleep = env.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = env.now || (() => Date.now());
    const stats = { calls: 0, inChars: 0, outChars: 0, ms: 0 };
    let allowedTiers = null;
    const api = { currentJob: null };
    const record = (e) => { if (api.currentJob) api.currentJob.log.push(Object.assign({ step: api.currentJob.currentStep }, e)); if (env.onCall) env.onCall(e); };
    const tierFor = (role, override) => { let t = override || cfg.tiers[role] || 'default'; if (allowedTiers && !allowedTiers.includes(t)) t = allowedTiers.includes('default') ? 'default' : allowedTiers[0]; return t; };

    async function call(spec) {
      if (typeof sample !== 'function') throw new AIError('not_granted', 'AI를 사용할 수 없습니다.');
      let prompt = spec.prompt;
      if (bytes(prompt) > cfg.maxPromptBytes) throw new AIError('prompt_too_large', `입력이 너무 깁니다(${bytes(prompt)}바이트).`);
      const entry = { t: new Date(now()).toISOString(), role: spec.role, task: spec.task, tier: tierFor(spec.role, spec.tier), inChars: prompt.length, outChars: 0, ms: 0, ok: false, code: '', promptVersion: P.PROMPT_VERSION, label: spec.label || '' };
      const t0 = now();
      let formatRetry = false, upRetry = 0;
      for (;;) {
        try {
          const opts = { modelTier: entry.tier, cache: false };
          if (spec.signal) opts.signal = spec.signal;
          if (spec.onText) opts.onText = spec.onText;
          let out;
          if (spec.json) {
            let data;
            if (typeof sample.json === 'function') data = await sample.json(prompt, opts);
            else { const r = await sample(prompt, opts); data = extractJSON(r.text); }
            const errs = spec.validate ? spec.validate(data) : [];
            if (errs.length) throw new AIError('invalid_json', '형식 검증 실패: ' + errs.slice(0, 4).join(', '), { text: JSON.stringify(data).slice(0, 400) });
            out = { data, outChars: JSON.stringify(data).length };
          } else {
            const r = await sample(prompt, opts);
            out = { text: r.text, truncated: !!r.truncated, outChars: r.text.length };
          }
          entry.ok = true; entry.outChars = out.outChars; entry.ms = now() - t0;
          stats.calls++; stats.inChars += entry.inChars; stats.outChars += entry.outChars; stats.ms += entry.ms;
          record(entry);
          return out;
        } catch (e) {
          const code = (e && e.code) || 'upstream_error';
          if (code === 'cancelled') { entry.code = code; entry.ms = now() - t0; record(entry); throw e instanceof AIError ? e : new AIError('cancelled', '중지됨'); }
          if (code === 'upstream_error' && upRetry < cfg.retries) { upRetry++; await sleep(cfg.backoffMs * upRetry); continue; }
          if ((code === 'invalid_json' || code === 'empty_completion') && !formatRetry) {
            formatRetry = true;
            prompt += '\n\n[재요청] 직전 응답이 지정한 형식에 맞지 않았다' + (e.message ? ' (' + clip(e.message, 120) + ')' : '') + '. 설명 없이 지정한 형식만 출력한다.';
            continue;
          }
          entry.code = code; entry.ms = now() - t0; stats.calls++; stats.inChars += entry.inChars; stats.ms += entry.ms;
          record(entry);
          throw e instanceof AIError ? e : new AIError(code, (e && e.message) || code, { text: e && e.text });
        }
      }
    }
    return Object.assign(api, { call, cfg, stats, tierFor, setAllowedTiers: (a) => { allowedTiers = a; }, sample });
  }

  /* ───────────── 작업(job) 만들기 ───────────── */
  const SEV_RANK = { 치명: 3, 중요: 2, 경미: 1 };
  const critMajor = (issues) => issues.filter((i) => i.severity === '치명' || i.severity === '중요').length;
  const step = (kind, arg, label) => ({ id: kind + (arg == null ? '' : '#' + arg) + '@' + Math.random().toString(36).slice(2, 6), kind, arg: arg == null ? null : arg, label, status: 'pending', error: '', calls: 0 });
  const KIND_LABEL = { 'AI 초고': 'AI 초고', 'AI 개고': 'AI 개고', 'AI 변환': 'AI 변환' };
  function newJob(type, workId, params, steps) {
    const t = new Date().toISOString();
    return { id: C.uid('job'), workId, type, status: 'pending', createdAt: t, updatedAt: t, params, steps, state: { chapters: {}, notes: [] }, log: [], resultVersionId: null, report: { unprocessed: [], warnings: [] }, pausedReason: '', stats: { calls: 0, inChars: 0, outChars: 0, ms: 0 } };
  }
  const TYPE_LABEL = { write: 'AI 자동 집필', revise: 'AI 자동 개고', oneclick: '원클릭 AI 완성', judge: '작품 진단', convert: '장르·형식 변환', phase: 'AI 구상' };

  // chapters: 대상 버전의 장 수(작성 작업은 설계 후에 정해지므로 steps 가 동적으로 늘어난다)
  function buildJob(type, work, params, info) {
    info = info || {};
    const n = info.chapterCount || 0;
    const scope = params.scope && params.scope.length ? params.scope : Array.from({ length: n }, (_, i) => i);
    let steps = [];
    if (type === 'phase') {
      if (params.phases.includes('idea')) steps.push(step('idea', null, '구상 만들기'));
      if (params.phases.includes('design')) steps.push(step('design', null, '시놉시스·구조 설계'));
    } else if (type === 'draft') {
      const chs = (work.bible && work.bible.design && work.bible.design.chapters) || [];
      steps.push(step('prep', null, '작업 준비'));
      chs.forEach((c, i) => steps.push(step('draft_ch', i, `${i + 1}장 집필 — ${c.title}`)));
      chs.forEach((c, i) => steps.push(step('review_ch', i, `${i + 1}장 자동 검토`)));
      steps.push(step('finalize', null, '초고 마무리'));
    } else if (type === 'revise') {
      steps.push(step('prep', null, '작업 준비'));
      scope.forEach((i) => steps.push(step('analyze_ch', i, `${i + 1}장 설정 추출`)));
      scope.forEach((i) => steps.push(step('diag_ch', i, `${i + 1}장 진단`)));
      scope.forEach((i) => steps.push(step('rev_ch', i, `${i + 1}장 개고`)));
      steps.push(step('finalize', null, '개고본 마무리'));
    } else if (type === 'oneclick') {
      steps.push(step('prep', null, '① 작품 읽기 준비'));
      scope.forEach((i) => steps.push(step('analyze_ch', i, `① ${i + 1}장 읽기·설정 추출`)));
      steps.push(step('structure', null, '① 구조 분석'));
      scope.forEach((i) => steps.push(step('diag_ch', i, `② ${i + 1}장 결함·개연성 분석`)));
      steps.push(step('strategy', null, '③ 개고 전략 수립'));
      scope.forEach((i) => steps.push(step('rev_ch', i, `④ ${i + 1}장 개고`)));
      scope.forEach((i) => steps.push(step('polish_ch', i, `⑤ ${i + 1}장 문장·대화 재검토`)));
      steps.push(step('style_check', null, '⑥ 문체 일관성 검토'));
      scope.forEach((i) => steps.push(step('proof_ch', i, `⑦ ${i + 1}장 교열`)));
      scope.forEach((i) => steps.push(step('cont_ch', i, `⑧ ${i + 1}장 연속성 검증`)));
      steps.push(step('finalize', null, '⑨ 최종 원고 생성'));
      steps.push(step('judge', null, '⑩ 최종 심사위원 평가'));
    } else if (type === 'judge') {
      steps.push(step('judge', null, '심사위원 평가'));
    } else if (type === 'convert') {
      steps.push(step('prep', null, '변환 준비'));
      const chunks = info.chunks || 1;
      for (let k = 0; k < chunks; k++) steps.push(step('conv_chunk', k, `${k + 1}/${chunks} 변환`));
      for (let k = 0; k < chunks; k++) steps.push(step('map_chunk', k, `${k + 1}/${chunks} 장면 대응표`));
      steps.push(step('finalize', null, '변환본 마무리'));
    } else throw new Error('알 수 없는 작업 종류: ' + type);
    return newJob(type, work.id, params, steps);
  }

  // 사전 안내용 추정(호출 횟수·시간). 정확한 값이 아니다.
  const CALL_WEIGHT = {
    idea: [1, 'default'], design: [1, 'default'], prep: [0, 'quick'], draft_ch: null, review_ch: [2, 'default'], analyze_ch: [1, 'quick'], diag_ch: [1, 'default'],
    rev_ch: null, rediag_ch: [2, 'default'], structure: [1, 'default'], strategy: [1, 'default'], polish_ch: null, style_check: [1, 'default'], proof_ch: null,
    cont_ch: [1, 'default'], finalize: [0, 'quick'], judge: [1, 'complex'], conv_chunk: [1, 'complex'], map_chunk: [1, 'quick'],
  };
  function estimateJob(job, cfg, history) {
    cfg = Object.assign({}, DEFAULT_CONFIG, cfg || {});
    const avg = Object.assign({}, cfg.avgMs, history || {});
    let calls = 0, ms = 0;
    const add = (n, tier) => { calls += n; ms += n * (avg[tier] || avg.default); };
    const level = (job.params && job.params.level) || 4;
    const chunkCalls = (chars, size) => Math.max(1, Math.ceil(chars / size));
    job.steps.filter((s) => s.status === 'pending' || s.status === 'running').forEach((s) => {
      const w = CALL_WEIGHT[s.kind];
      if (w) { add(w[0], w[1]); return; }
      const chars = (job.params.chapterChars && job.params.chapterChars[s.arg]) || 3000;
      if (s.kind === 'draft_ch') { const sc = (job.params.sceneCounts && job.params.sceneCounts[s.arg]) || chunkCalls(chars, cfg.chunkChars); add(sc, 'complex'); add(1, 'quick'); }
      else if (s.kind === 'rev_ch') { add(chunkCalls(chars, level === 5 ? cfg.reviseChunkChars5 : cfg.reviseChunkChars) + (level >= 4 ? 1 : 0), 'complex'); }
      else if (s.kind === 'polish_ch') add(chunkCalls(chars, cfg.reviseChunkChars), 'complex');
      else if (s.kind === 'proof_ch') add(chunkCalls(chars, 3000), 'default');
    });
    if (job.params && job.params.loop && job.params.loop.on) { const chs = job.steps.filter((s) => s.kind === 'rev_ch').length; add(chs * 2 * (job.params.loop.max || 1) * 0.6, 'default'); calls = Math.round(calls); }
    return { calls: Math.round(calls), minMinutes: Math.max(1, Math.round((ms * 0.6) / 60000)), maxMinutes: Math.max(1, Math.round((ms * 1.8) / 60000)) };
  }

  /* ───────────── 판정 입력 구성 ───────────── */
  function buildJudgeInput(ver, work, maxBytes) {
    const texts = ver.chapters.map((c, i) => `【${i + 1}장${c.title ? ' ' + c.title : ''}】\n${C.chapterText(c)}`);
    const total = texts.join('\n\n');
    const chars = C.countWithSpaces(C.versionText(ver));
    if (bytes(total) <= maxBytes) return { text: total, coverage: `전체 ${ver.chapters.length}개 장의 전문을 읽었다(공백 포함 ${chars}자). 읽지 못한 부분은 없다.`, full: true };
    const sums = (work.bible && work.bible.chapterSummaries) || [];
    let budget = maxBytes, parts = [], fullIdx = [], excerptIdx = [], sumOnly = [];
    const idxs = ver.chapters.map((_, i) => i);
    const pick = [0, ver.chapters.length - 1].filter((v, i, a) => a.indexOf(v) === i);
    const used = new Set();
    const addFull = (i) => { const t = texts[i]; if (bytes(t) <= budget * 0.45) { parts[i] = t; budget -= bytes(t); fullIdx.push(i + 1); used.add(i); return true; } return false; };
    pick.forEach((i) => { if (!addFull(i)) { const t = lastChars(texts[i], 9000); parts[i] = '(발췌) ' + t; budget -= bytes(t); excerptIdx.push(i + 1); used.add(i); } });
    idxs.filter((i) => !used.has(i)).forEach((i) => { const ex = clip(C.chapterText(ver.chapters[i]), 2500); if (bytes(ex) < budget * 0.5) { parts[i] = `【${i + 1}장 발췌(앞부분)】\n${ex}`; budget -= bytes(ex); excerptIdx.push(i + 1); } else { parts[i] = `【${i + 1}장 요약만】 ${clip(sums[i] || '', 300)}`; sumOnly.push(i + 1); } });
    const cov = `전문을 읽은 장: ${fullIdx.join(', ') || '없음'} / 일부만 읽은 장(발췌): ${excerptIdx.join(', ') || '없음'} / 요약만 본 장: ${sumOnly.join(', ') || '없음'}. 분량 때문에 전체를 읽지 못했으므로, 읽지 못한 부분에 대한 평가는 하지 않는다.`;
    return { text: parts.filter(Boolean).join('\n\n'), coverage: cov, full: false, partial: { fullIdx, excerptIdx, sumOnly } };
  }

  /* ───────────── 작업 실행기 ───────────── */
  function createRunner(env) {
    const { engine, storage } = env;
    const cfg = engine.cfg;
    const emit = (job) => { if (env.onEvent) env.onEvent({ type: 'job', job }); };

    async function run(job, runOpts) {
      runOpts = runOpts || {};
      const signal = runOpts.signal;
      job._base = Object.assign({ calls: 0, inChars: 0, outChars: 0, ms: 0 }, job.stats);
      job.status = 'running'; job.pausedReason = ''; await save(job);
      const ctx = makeCtx(job, signal);
      for (;;) {
        if (signal && signal.aborted) { job.status = 'paused'; job.pausedReason = '사용자가 중지했습니다.'; await save(job); return job; }
        const idx = job.steps.findIndex((s) => s.status === 'pending' || s.status === 'running' || s.status === 'failed');
        if (idx < 0) break;
        const st = job.steps[idx];
        st.status = 'running'; st.error = ''; st.startedAt = new Date().toISOString(); job.currentStep = st.id; await save(job);
        const callsBefore = engine.stats.calls;
        try {
          await exec(ctx, st, idx);
          st.status = st.status === 'running' ? 'done' : st.status;
        } catch (e) {
          const code = (e && e.code) || 'error';
          st.calls += engine.stats.calls - callsBefore;
          if (code === 'refused') { st.status = 'refused'; st.error = 'Claude가 이 입력을 처리하지 않았습니다.'; ctx.unprocessed(st, '모델이 처리를 거부함'); }
          else if (code === 'cancelled') { st.status = 'pending'; job.status = 'paused'; job.pausedReason = '사용자가 중지했습니다.'; await save(job); return job; }
          else if (code === 'rate_limited' || code === 'session_expired') { st.status = 'pending'; job.status = 'paused'; job.pausedReason = code === 'rate_limited' ? '호출 한도에 도달했습니다. 잠시 뒤 이어서 진행하세요.' : '로그인이 만료되었습니다. 다시 로그인한 뒤 이어서 진행하세요.'; await save(job); return job; }
          else if (FATAL.has(code)) { st.status = 'failed'; st.error = e.message; job.status = 'failed'; job.pausedReason = 'AI를 사용할 수 없습니다: ' + e.message; await save(job); return job; }
          else { st.status = 'failed'; st.error = (e && e.message) || String(e); job.status = 'paused'; job.pausedReason = `“${st.label}”에서 멈췄습니다: ${st.error}`; await save(job); return job; }
        }
        st.endedAt = new Date().toISOString(); st.calls += engine.stats.calls - callsBefore;
        await save(job);
      }
      const incomplete = job.steps.some((s) => s.status === 'refused' || s.status === 'skipped');
      job.status = incomplete ? 'partial' : 'done';
      if (ctx.resultVer) { ctx.resultVer.ai = Object.assign(ctx.resultVer.ai || {}, { status: incomplete ? 'incomplete' : 'complete' }); await ctx.saveVer(); }
      await save(job);
      return job;
    }
    async function save(job) { job.updatedAt = new Date().toISOString(); const b = job._base || { calls: 0, inChars: 0, outChars: 0, ms: 0 }; job.stats = { calls: b.calls + engine.stats.calls, inChars: b.inChars + engine.stats.inChars, outChars: b.outChars + engine.stats.outChars, ms: b.ms + engine.stats.ms }; if (job.log.length > 400) job.log = job.log.slice(-400); await storage.putJob(job); emit(job); }

    function makeCtx(job, signal) {
      const ctx = { job, signal, resultVer: null };
      ctx.getWork = () => (env.getWork ? env.getWork(job.workId) : storage.getWork(job.workId));
      ctx.updateWork = async (fn) => { if (env.updateWork) return env.updateWork(job.workId, fn); const w = await storage.getWork(job.workId); fn(w); await storage.putWork(w); return w; };
      ctx.base = async () => (job.params.baseVersionId ? storage.getVersion(job.params.baseVersionId) : null);
      ctx.saveJob = () => save(job);
      ctx.note = (msg) => { job.state.notes.push(msg); };
      ctx.warn = (msg) => { job.report.warnings.push(msg); };
      ctx.unprocessed = (st, reason) => { job.report.unprocessed.push({ step: st.label, kind: st.kind, arg: st.arg, reason }); };
      ctx.call = async (spec) => {
        const prev = engine.stats.calls;
        try { return await engine.call(Object.assign({ signal }, spec)); }
        finally { /* 로그는 onCall 에서 */ }
      };
      ctx.insertAfter = (idx, steps) => { job.steps.splice(idx + 1, 0, ...steps); };
      ctx.loadResult = async () => { if (ctx.resultVer) return ctx.resultVer; if (!job.resultVersionId) return null; ctx.resultVer = await storage.getVersion(job.resultVersionId); return ctx.resultVer; };
      ctx.saveVer = async () => { if (ctx.resultVer) { ctx.resultVer.updatedAt = new Date().toISOString(); const t = C.aggregateCounts(ctx.resultVer.chapters.map((c) => C.countText(C.chapterText(c))), {}); ctx.resultVer.stats = { withSpaces: t.withSpaces, noSpaces: t.noSpaces, sheets: t.sheets }; await storage.putVersion(ctx.resultVer); } };
      ctx.storage = storage; ctx.cfg = cfg;
      return ctx;
    }
    async function exec(ctx, st, idx) {
      const H = HANDLERS[st.kind];
      if (!H) throw new AIError('transform_error', '알 수 없는 단계: ' + st.kind);
      engine.currentJob = ctx.job;
      await H(ctx, st, idx, env);
    }
    return { run, save };
  }

  /* ───────────── 단계 처리기 ───────────── */
  const HANDLERS = {};
  const chapterTarget = (work, i) => { const c = work.bible.design.chapters[i]; return (c && c.targetChars) || 0; };

  HANDLERS.idea = async (ctx) => {
    const work = await ctx.getWork();
    const r = await ctx.call({ role: '기획자', task: 'idea', prompt: P.T.idea(work), tier: 'default', json: true, validate: V.idea, label: '구상' });
    await ctx.updateWork((w) => { w.bible = w.bible || {}; w.bible.idea = r.data; });
  };
  HANDLERS.design = async (ctx, st, idx) => {
    const work = await ctx.getWork();
    const idea = work.bible && work.bible.idea; if (!idea) throw new AIError('transform_error', '구상이 없습니다.');
    let r;
    try { r = await ctx.call({ role: '기획자', task: 'design', prompt: P.T.design(work, idea, ctx.job.params.authorEdits || ''), tier: 'default', json: true, validate: V.design, label: '시놉시스·구조' }); }
    catch (e) {
      if (e.code !== 'invalid_json') throw e; // 출력이 길어 잘렸을 수 있다: 더 짧은 형식으로 한 번 더
      ctx.warn('설계안 출력이 형식에 맞지 않아 더 짧은 형식으로 다시 요청했습니다.');
      r = await ctx.call({ role: '기획자', task: 'design', prompt: P.T.design(work, idea, ctx.job.params.authorEdits || '', true), tier: 'default', json: true, validate: V.design, label: '시놉시스·구조(간결)' });
    }
    const d = r.data, total = work.brief.target.chars;
    // 분량 정규화: 장별 목표의 합이 전체 목표와 크게 어긋나면 비례 조정하고, 장면 분량도 맞춘다.
    let sum = d.chapters.reduce((a, c) => a + (c.targetChars || 0), 0);
    if (sum <= 0) d.chapters.forEach((c) => { c.targetChars = Math.round(total / d.chapters.length); });
    else if (Math.abs(sum - total) / total > 0.1) { const k = total / sum; d.chapters.forEach((c) => { c.targetChars = Math.round((c.targetChars || 0) * k); }); }
    d.chapters.forEach((c) => {
      let ss = c.scenes.reduce((a, s) => a + s.targetChars, 0);
      if (ss <= 0) c.scenes.forEach((s) => { s.targetChars = Math.round(c.targetChars / c.scenes.length); });
      else { const k = c.targetChars / ss; c.scenes.forEach((s) => { s.targetChars = Math.round(s.targetChars * k); }); }
    });
    await ctx.updateWork((w) => { w.bible = w.bible || {}; w.bible.design = d; w.bible.chapterSummaries = d.chapters.map((c) => c.summary); w.bible.facts = []; });
  };

  async function ensureResult(ctx, o) {
    let v = await ctx.loadResult(); if (v) return v;
    v = C.makeVersion({ workId: ctx.job.workId, parentId: o.parentId || null, label: o.label, kind: o.kind, frozen: true, note: o.note || '', chapters: o.chapters });
    v.ai = { jobId: ctx.job.id, type: ctx.job.type, status: 'partial', promptVersion: P.PROMPT_VERSION };
    ctx.job.resultVersionId = v.id; ctx.resultVer = v; await ctx.saveVer(); await ctx.saveJob();
    return v;
  }
  const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`; };

  HANDLERS.prep = async (ctx) => {
    const job = ctx.job;
    if (job.type === 'draft') {
      const work = await ctx.getWork();
      await ensureResult(ctx, { label: `AI 초고 (${stamp()})`, kind: 'AI 초고', note: '자동 집필 결과(진행 중이면 미완성)', chapters: work.bible.design.chapters.map((c) => ({ id: C.uid('c'), title: c.title, paragraphs: [C.newParagraph('')] })) });
    } else if (job.type === 'convert') {
      await HANDLERS.prepConvert(ctx);
    } else {
      const base = await ctx.base(); if (!base) throw new AIError('transform_error', '기준 버전을 찾을 수 없습니다.');
      if (!base.frozen) throw new AIError('transform_error', '기준 버전이 고정되어 있지 않습니다.');
      const lvl = (job.params.level) || 4;
      await ensureResult(ctx, { parentId: base.id, label: job.type === 'oneclick' ? `AI 완성 (${stamp()})` : `AI 개고 ${lvl}단계 (${stamp()})`, kind: 'AI 개고', note: `기준: ${base.label}`, chapters: C.cloneChapters(base.chapters) });
      job.state.baseChars = C.countWithSpaces(C.versionText(base));
    }
  };

  /* 집필 */
  HANDLERS.draft_ch = async (ctx, st) => {
    const i = st.arg, work = await ctx.getWork(), d = work.bible.design, ch = d.chapters[i];
    const S = ctx.job.state.chapters; const state = S[i] = S[i] || { scenes: [], done: false };
    const ver = await ctx.loadResult();
    const scenes = ch.scenes;
    const sceneSep = ctx.cfg.sceneBreak && work.brief && work.brief.sceneBreak !== false ? '***' : '';
    for (let k = state.scenes.length; k < scenes.length; k++) {
      const prevTail = k > 0 ? lastChars(state.scenes.join('\n'), 1200) : (i > 0 ? lastChars(C.chapterText(ver.chapters[i - 1]), 1200) : '');
      const sums = (work.bible.chapterSummaries || []).slice(0, i).map((s, n) => `${n + 1}장: ${clip(s, 200)}`).join('\n');
      const target = Math.max(200, scenes[k].targetChars || Math.round(ch.targetChars / scenes.length));
      const baseArgs = { chapterNo: i + 1, chapterTitle: ch.title, sceneNo: k + 1, sceneTotal: scenes.length, targetChars: target, isFirst: k === 0 && i === 0, isLast: k === scenes.length - 1 };
      let text = '';
      const r = await ctx.call({ role: '소설가', task: 'writeScene', label: `${i + 1}장 ${k + 1}/${scenes.length}`, prompt: P.T.writeScene(work, Object.assign(baseArgs, { bible: bibleText(work, { maxChars: 4500, upTo: i }), chapterPlan: `${ch.title} — 목표: ${ch.goal || ''}\n요약: ${ch.summary}\n핵심 사건: ${(ch.keyEvents || []).join('; ')}\n시점 인물: ${ch.pov || ''}`, scenePlan: scenes[k].summary, prevSummary: sums, tail: prevTail })) });
      text = cleanProse(r.text).text;
      let guard = 0, trunc = r.truncated || looksTruncated(text);
      while (trunc && guard < 2) {
        guard++;
        const r2 = await ctx.call({ role: '소설가', task: 'continue', label: `${i + 1}장 ${k + 1} 이어쓰기`, prompt: P.T.continueText(work, { scenePlan: scenes[k].summary, tail: lastChars(text, 900) }) });
        const add = cleanProse(r2.text).text; text = text + (add.startsWith('\n') ? '' : '\n') + add;
        trunc = r2.truncated || looksTruncated(text);
      }
      if (trunc) ctx.warn(`${i + 1}장 ${k + 1}번째 장면이 끝맺지 못하고 끊긴 듯합니다. 장면을 다시 쓰거나 직접 마무리하세요.`);
      state.scenes.push(text);
      await ctx.saveJob();
    }
    let text = state.scenes.join(sceneSep ? '\n' + sceneSep + '\n' : '\n');
    // 분량 점검: 목표 대비 크게 어긋나면 한 번만 보강·압축한다.
    const target = ch.targetChars, cur = C.countWithSpaces(text);
    if (target > 0 && (cur < target * 0.7 || cur > target * 1.4)) {
      const mode = cur < target ? 'expand' : 'condense';
      try {
        const r = await ctx.call({ role: '소설가', task: 'adjustLength', label: `${i + 1}장 분량 ${mode === 'expand' ? '보강' : '압축'}`, prompt: P.T.adjustLength(work, { mode, targetChars: target, currentChars: cur, scenePlan: ch.summary, text }) });
        const t2 = cleanProse(r.text).text, c2 = C.countWithSpaces(t2);
        if (!r.truncated && !looksTruncated(t2) && Math.abs(c2 - target) < Math.abs(cur - target)) { text = t2; state.adjusted = mode; } else ctx.warn(`${i + 1}장 분량 조정 결과를 쓰지 않았습니다(개선되지 않음).`);
      } catch (e) { if (e.code === 'cancelled' || e.code === 'rate_limited' || e.code === 'session_expired') throw e; ctx.warn(`${i + 1}장 분량 조정에 실패했습니다: ${e.message}`); }
    }
    ver.chapters[i].paragraphs = C.splitLines(text).map((l) => Object.assign(C.newParagraph(l), { source: 'ai' }));
    state.done = true; await ctx.saveVer(); await ctx.saveJob();
    // 장 요약과 확정 사실을 설정집에 쌓는다(다음 장의 맥락).
    try {
      const r = await ctx.call({ role: '요약자', task: 'summarize', label: `${i + 1}장 요약`, tier: 'quick', prompt: P.T.summarize({ label: `${i + 1}장`, text }), json: true, validate: V.summarize });
      await ctx.updateWork((w) => { w.bible.chapterSummaries[i] = r.data.summary; w.bible.facts = (w.bible.facts || []).filter((f) => f.chapter !== i + 1).concat(r.data.facts.map((f) => ({ fact: f.fact, kind: f.kind, chapter: i + 1 }))); });
    } catch (e) { if (['cancelled', 'rate_limited', 'session_expired'].includes(e.code)) throw e; ctx.warn(`${i + 1}장 요약을 만들지 못했습니다(다음 장 맥락은 설계안의 요약을 씁니다).`); }
  };
  HANDLERS.review_ch = async (ctx, st) => {
    const i = st.arg, work = await ctx.getWork(), ver = await ctx.loadResult();
    const R = ctx.job.state.review = ctx.job.state.review || {}; const rv = R[i] = R[i] || {};
    const text = C.chapterText(ver.chapters[i]);
    if (!text.trim()) return;
    if (!rv.issues) {
      const r = await ctx.call({ role: '구조편집자', task: 'diagnose', label: `${i + 1}장 자동 검토`, tier: 'default', json: true, validate: V.diagnose, prompt: P.T.diagnose(work, { label: `${i + 1}장 초고`, bible: bibleText(work, { upTo: i + 1 }), text, focus: '인물 행동의 개연성, 사건 연결, 대사의 인물 적합성, 불필요한 설명, 장면 반복, 결말이 갑작스럽거나 작위적인지, 분량을 중점으로 본다.' }) });
      rv.issues = r.data.issues; rv.aiTells = r.data.aiTells; await ctx.saveJob();
    }
    const serious = rv.issues.filter((x) => x.severity !== '경미');
    if (serious.length && !rv.fixed) {
      const paras = ver.chapters[i].paragraphs, lk = lockify(paras);
      const r = await ctx.call({ role: '문장편집자', task: 'revise', label: `${i + 1}장 자동 검토 반영`, prompt: P.T.revise(work, { level: 3, automation: '균형형', label: `${i + 1}장`, bible: bibleText(work, { upTo: i + 1 }), before: '', after: '', issues: serious, plan: '', extra: '발견된 문제를 해결하되 분량(±15%)과 사건 흐름은 유지한다.', text: lk.lines.join('\n') }) });
      let out = cleanProse(r.text).text;
      const restored = restoreLocks(out, lk.locks, 0);
      if (restored != null && !r.truncated && !looksTruncated(out) && driftOk(C.chapterText(ver.chapters[i]), restored, 3)) { ver.chapters[i].paragraphs = applyRevision(paras, restored, 'ai'); rv.fixed = true; await ctx.saveVer(); }
      else ctx.warn(`${i + 1}장 자동 검토 반영 결과가 기준(분량·잠금·끝맺음)을 지키지 못해 쓰지 않았습니다. 지적 사항은 보고서에 남습니다.`);
    }
    ctx.job.report.reviews = ctx.job.report.reviews || []; ctx.job.report.reviews[i] = { chapter: i + 1, issues: rv.issues.length, serious: serious.length, fixed: !!rv.fixed };
    await ctx.saveJob();
  };

  /* 개고·설정 추출·진단 */
  HANDLERS.analyze_ch = async (ctx, st) => {
    const i = st.arg, base = await ctx.base(), work = await ctx.getWork();
    const text = C.chapterText(base.chapters[i]); const h = hashStr(text);
    const b = work.bible || {};
    if (b.chapterHash && b.chapterHash[i] === h && b.chapterSummaries && b.chapterSummaries[i]) return;
    const r = await ctx.call({ role: '요약자', task: 'summarize', label: `${i + 1}장 설정 추출`, tier: 'quick', json: true, validate: V.summarize, prompt: P.T.summarize({ label: `${i + 1}장`, text: clip(text, 60000) }) });
    await ctx.updateWork((w) => {
      w.bible = w.bible || {}; const bb = w.bible; bb.chapterSummaries = bb.chapterSummaries || []; bb.chapterHash = bb.chapterHash || []; bb.facts = (bb.facts || []).filter((f) => f.chapter !== i + 1); bb.extractedCharacters = bb.extractedCharacters || [];
      bb.chapterSummaries[i] = r.data.summary; bb.chapterHash[i] = h;
      r.data.facts.forEach((f) => bb.facts.push({ fact: f.fact, kind: f.kind, chapter: i + 1 }));
      r.data.characters.forEach((c) => { const ex = bb.extractedCharacters.find((x) => x.name === c.name); if (ex) { if (c.age && !ex.age) ex.age = c.age; if (c.speech && !ex.speech) ex.speech = c.speech; if (c.traits && !(ex.traits || '').includes(c.traits)) ex.traits = ((ex.traits || '') + ' ' + c.traits).trim().slice(0, 200); } else bb.extractedCharacters.push({ name: c.name, age: c.age || '', traits: c.traits || '', speech: c.speech || '' }); });
    });
  };
  HANDLERS.structure = async (ctx) => {
    const work = await ctx.getWork(), sums = (work.bible.chapterSummaries || []).map((s, i) => `${i + 1}장: ${s}`).join('\n');
    const r = await ctx.call({ role: '구조편집자', task: 'structure', label: '구조 분석', tier: 'default', json: true, validate: V.structure, prompt: P.T.structure(work, { bible: bibleText(work), summaries: sums }) });
    ctx.job.state.structure = r.data; ctx.job.report.structure = r.data;
  };
  HANDLERS.diag_ch = async (ctx, st) => {
    const i = st.arg, base = await ctx.base(), work = await ctx.getWork();
    const S = ctx.job.state.chapters; const state = S[i] = S[i] || {};
    let text = C.chapterText(base.chapters[i]);
    if (bytes(text) > 180000) { text = text.slice(0, 50000); ctx.warn(`${i + 1}장이 너무 길어 앞 50,000자만 진단했습니다.`); }
    const r = await ctx.call({ role: '구조편집자', task: 'diagnose', label: `${i + 1}장 진단`, tier: 'default', json: true, validate: V.diagnose, prompt: P.T.diagnose(work, { label: `${i + 1}장`, bible: bibleText(work, { upTo: i + 1 }), text, focus: ctx.job.params.focus || '인과관계, 인물 행동의 동기, 장면의 기능과 속도, 대사의 현실성, 불필요한 설명, 결말의 필연성을 본다.', notes: work.todo }) });
    state.issuesBefore = r.data.issues; state.aiTells = r.data.aiTells; state.summary = r.data.summary;
  };
  HANDLERS.strategy = async (ctx) => {
    const S = ctx.job.state.chapters;
    const counts = Object.keys(S).map((k) => ({ no: +k + 1, total: (S[k].issuesBefore || []).length, serious: critMajor(S[k].issuesBefore || []) }));
    const r = await ctx.call({ role: '구조편집자', task: 'strategy', label: '개고 전략', tier: 'default', json: true, validate: V.strategy, prompt: P.T.strategy({}, { automation: ctx.job.params.automation || '적극형', structure: ctx.job.state.structure || {}, counts }) });
    ctx.job.state.strategy = r.data; ctx.job.report.strategy = r.data;
    if (!ctx.job.params.levelFixed) { const rg = { 보수적: [1, 2], 균형형: [2, 3], 적극형: [3, 4], 전면형: [4, 5] }[ctx.job.params.automation || '적극형'] || [3, 4]; ctx.job.params.level = Math.min(rg[1], Math.max(rg[0], r.data.level)); }
  };

  async function reviseChapter(ctx, i, opts) {
    // opts: {level, extra, issues, plan, label, source}
    const work = await ctx.getWork(), ver = await ctx.loadResult();
    const level = opts.level, auto = ctx.job.params.automation || '적극형';
    const paras = ver.chapters[i].paragraphs;
    const lk = lockify(paras);
    const size = level === 5 ? ctx.cfg.reviseChunkChars5 : ctx.cfg.reviseChunkChars;
    const chunks = chunkParas(lk.lines, size);
    const outChunks = []; let lockSeen = 0; const origText = C.chapterText(ver.chapters[i]);
    let plan = opts.plan || '';
    const notes = [];
    for (let k = 0; k < chunks.length; k++) {
      const chunk = chunks[k], text = chunk.join('\n');
      const nLocks = (text.match(/⟦잠금\d+⟧/g) || []).length;
      const base = { level, automation: auto, label: `${i + 1}장 (${k + 1}/${chunks.length})`, bible: bibleText(work, { upTo: i + 1, maxChars: 3500 }), before: k > 0 ? lastChars(outChunks[k - 1], 600) : (i > 0 ? lastChars(C.chapterText(ver.chapters[i - 1]), 400) : ''), after: k < chunks.length - 1 ? clip(chunks[k + 1].join('\n'), 400) : '', issues: (opts.issues || []).filter((x) => !x.quote || text.includes(x.quote.slice(0, 20)) || chunks.length === 1), plan, extra: opts.extra || '', text };
      let attempt = 0, good = null, why = '';
      while (attempt < 2 && good == null) {
        const extra = attempt === 0 ? base.extra : (base.extra + ' [재요청] 직전 결과가 기준을 지키지 못했다: ' + why + ' 분량과 잠금 표지를 반드시 지킨다.').trim();
        const r = await ctx.call({ role: level >= 4 ? '소설가' : '문장편집자', task: 'revise', label: base.label + ' 개고' + (attempt ? '(재시도)' : ''), prompt: P.T.revise(work, Object.assign({}, base, { extra })) });
        const out = cleanProse(r.text).text;
        const restored = restoreLocks(out, lk.locks.slice(lockSeen, lockSeen + nLocks), lockSeen);
        if (r.truncated || looksTruncated(out)) why = '끝맺지 못하고 끊겼다.';
        else if (restored == null) why = '잠금 표지가 빠지거나 순서가 바뀌었다.';
        else if (!driftOk(text.replace(/⟦잠금\d+⟧/g, '가'), out.replace(/⟦잠금\d+⟧/g, '가'), level)) why = `분량이 ${P.LEVELS[level].name} 범위를 벗어났다.`;
        else good = restored;
        attempt++;
      }
      if (good == null) { notes.push(`${i + 1}장 ${k + 1}번째 묶음은 기준을 지키지 못해 원문을 유지했습니다(${why}).`); good = chunk.map((l) => l.replace(/⟦잠금(\d+)⟧/g, (s, n) => lk.locks[+n - 1])).join('\n'); }
      outChunks.push(good); lockSeen += nLocks;
    }
    const merged = outChunks.join('\n');
    ver.chapters[i].paragraphs = applyRevision(paras, merged, 'ai');
    notes.forEach((n) => ctx.warn(n));
    await ctx.saveVer();
    return { before: origText, after: C.chapterText(ver.chapters[i]) };
  }

  HANDLERS.rev_ch = async (ctx, st, idx) => {
    const i = st.arg, job = ctx.job, S = job.state.chapters; const state = S[i] = S[i] || {};
    const level = job.params.level || 4, work = await ctx.getWork();
    const ver = await ctx.loadResult();
    const issues = st.iter ? (state.issuesNow || []) : (state.issuesBefore || []);
    state.prevParas = JSON.stringify(ver.chapters[i].paragraphs);
    let plan = '';
    if (level >= 4 && !st.iter) {
      try {
        const strat = job.state.strategy; const stratText = strat ? [(strat.global || []).join('; '), ((strat.chapters || []).find((c) => c.no === i + 1) || {}).instruction].filter(Boolean).join(' / ') : '';
        const r = await ctx.call({ role: '구조편집자', task: 'revisePlan', label: `${i + 1}장 개고 계획`, tier: 'default', json: true, validate: V.revisePlan, prompt: P.T.revisePlan(work, { level, automation: job.params.automation || '적극형', label: `${i + 1}장`, bible: bibleText(work, { upTo: i + 1 }), issues, text: C.chapterText(ver.chapters[i]), strategy: stratText }) });
        plan = JSON.stringify(r.data); state.plan = r.data;
      } catch (e) { if (['cancelled', 'rate_limited', 'session_expired'].includes(e.code)) throw e; ctx.warn(`${i + 1}장 개고 계획을 만들지 못해 계획 없이 진행했습니다.`); }
    } else plan = state.plan ? JSON.stringify(state.plan) : '';
    const extra = [job.params.extra, state.strategyNote].filter(Boolean).join(' ');
    const res = await reviseChapter(ctx, i, { level, issues: issues.filter((x) => x.severity !== '경미' || level >= 3), plan, extra });
    state.revised = true; state.rounds = (state.rounds || 0) + 1;
    await ctx.saveJob();
    if (job.params.loop && job.params.loop.on) ctx.insertAfter(idx, [Object.assign(step('rediag_ch', i, `${i + 1}장 재진단 (${st.iter ? st.iter + 1 : 1}회차)`), { iter: (st.iter || 0) + 1 })]);
  };
  HANDLERS.rediag_ch = async (ctx, st, idx) => {
    const i = st.arg, job = ctx.job, S = job.state.chapters, state = S[i];
    const work = await ctx.getWork(), ver = await ctx.loadResult(), max = (job.params.loop && job.params.loop.max) || 2;
    const newText = C.chapterText(ver.chapters[i]);
    // 수정 의도를 모르는 별도 호출로 다시 진단한다(자기 평가 편향 방지).
    const r = await ctx.call({ role: '구조편집자', task: 'diagnose', label: `${i + 1}장 독립 재진단`, tier: 'default', json: true, validate: V.diagnose, prompt: P.T.diagnose(work, { label: `${i + 1}장`, bible: bibleText(work, { upTo: i + 1 }), text: newText, focus: '인과관계, 인물 행동의 동기, 장면의 기능과 속도, 대사의 현실성, 불필요한 설명, 결말의 필연성을 본다.' }) });
    const prevIssues = (st.iter > 1 ? state.issuesNow : state.issuesBefore) || [];
    const next = r.data.issues.map((x, k) => Object.assign({}, x, { id: 'N' + (k + 1) }));
    let trk = { previous: [], newIssueIds: [] };
    if (prevIssues.length || next.length) {
      const t = await ctx.call({ role: '구조편집자', task: 'track', label: `${i + 1}장 문제 추적`, tier: 'default', json: true, validate: V.track, prompt: P.T.track({ prev: prevIssues.map(({ id, severity, problem, quote }) => ({ id, severity, problem, quote })), next: next.map(({ id, severity, problem, quote }) => ({ id, severity, problem, quote })) }) });
      trk = t.data;
    }
    const status = (id) => (trk.previous.find((p) => p.id === id) || {}).status || '미해결';
    const newOnes = next.filter((n) => trk.newIssueIds.includes(n.id));
    const resolved = prevIssues.filter((p) => status(p.id) === '해결').length, worse = prevIssues.filter((p) => status(p.id) === '악화').length;
    const prevCM = critMajor(prevIssues), nowCM = critMajor(next), newFatal = newOnes.filter((n) => n.severity === '치명').length;
    const entry = { chapter: i + 1, round: st.iter, before: prevIssues.length, after: next.length, resolved, worse, newIssues: newOnes.length, newFatal, prevSerious: prevCM, nowSerious: nowCM, decision: '' };
    job.report.loops = job.report.loops || []; job.report.loops.push(entry);
    if (newFatal > 0 || nowCM > prevCM || worse > resolved) {
      // 나빠졌다: 이번 회차 결과를 버리고 직전 판으로 되돌린다.
      ver.chapters[i].paragraphs = JSON.parse(state.prevParas);
      entry.decision = '되돌림(이번 수정이 오히려 나빠짐)'; ctx.warn(`${i + 1}장 ${st.iter}회차 수정은 새 문제가 생기거나 나빠져 채택하지 않았습니다.`);
      await ctx.saveVer(); await ctx.saveJob(); return;
    }
    state.issuesNow = next; entry.decision = '채택';
    const remaining = critMajor(next);
    if (remaining === 0) entry.decision += ' · 치명·중요 문제 없음, 종료';
    else if (st.iter >= max) entry.decision += ` · 최대 ${max}회 도달, 종료`;
    else if (resolved === 0 && st.iter > 1) entry.decision += ' · 더 개선되지 않아 종료';
    else ctx.insertAfter(idx, [Object.assign(step('rev_ch', i, `${i + 1}장 추가 개고 (${st.iter + 1}회차)`), { iter: st.iter })]);
    await ctx.saveVer(); await ctx.saveJob();
  };
  HANDLERS.polish_ch = async (ctx, st) => {
    const i = st.arg, work = await ctx.getWork(), ver = await ctx.loadResult(), S = ctx.job.state.chapters; const state = S[i] = S[i] || {};
    if (!C.chapterText(ver.chapters[i]).trim()) return;
    const lvl = ctx.job.params.automation === '보수적' ? 1 : 2;
    await reviseChapter(ctx, i, { level: lvl, issues: [], plan: '', extra: '문장 호흡과 대사의 현실감만 다듬는다. 사건·장면·인물 행동은 건드리지 않는다. 지나치게 매끄러운 평균적 문장으로 만들지 않는다.' });
    state.polished = true;
  };
  HANDLERS.style_check = async (ctx, st, idx) => {
    const ver = await ctx.loadResult(), work = await ctx.getWork();
    const stats = ver.chapters.map((c, i) => { const one = { chapters: [c] }; const s = C.styleStats(one, { names: [], custom: [] }); return { no: i + 1, avgSentenceLen: s.avgLen, dialogRatio: Math.round(s.dialogRatio * 100) / 100, sentences: s.sentenceCount }; });
    const excerpts = ver.chapters.map((c, i) => `【${i + 1}장】 ${clip(C.chapterText(c), 500)}`).join('\n');
    const r = await ctx.call({ role: '문장편집자', task: 'styleCheck', label: '문체 일관성', tier: 'default', json: true, validate: V.styleCheck, prompt: P.T.styleCheck(work, { stats, excerpts }) });
    ctx.job.report.style = { stats, inconsistent: r.data.inconsistent };
    const fixes = r.data.inconsistent.filter((x) => x && Number.isInteger(+x.no) && +x.no >= 1 && +x.no <= ver.chapters.length).slice(0, 3);
    ctx.insertAfter(idx, fixes.map((x) => Object.assign(step('style_fix_ch', +x.no - 1, `⑥ ${x.no}장 문체 맞춤`), { instr: x.instruction || x.problem })));
  };
  HANDLERS.style_fix_ch = async (ctx, st) => { await reviseChapter(ctx, st.arg, { level: 2, issues: [], plan: '', extra: '다른 장과 문체를 맞춘다: ' + (st.instr || '') }); };
  HANDLERS.proof_ch = async (ctx, st) => {
    const i = st.arg, ver = await ctx.loadResult(), J = ctx.job;
    const rep = J.report.proofread = J.report.proofread || { applied: [], recommended: [], confirm: [], notFound: 0 };
    const paras = ver.chapters[i].paragraphs;
    const idxs = paras.map((p, k) => k).filter((k) => paras[k].text.trim());
    const chunks = chunkParas(idxs.map((k) => paras[k].text), 3000);
    let pos = 0;
    for (const chunk of chunks) {
      const ids = idxs.slice(pos, pos + chunk.length); pos += chunk.length;
      const text = chunk.join('\n');
      const r = await ctx.call({ role: '교열자', task: 'proofread', label: `${i + 1}장 교열`, tier: 'default', json: true, validate: V.proofread, prompt: P.T.proofread({ text }) });
      for (const f of r.data.fixes) {
        const occ = text.split(f.orig).length - 1;
        if (occ !== 1 || f.orig.includes('\n')) { rep.notFound++; continue; }
        const rec = { chapter: i + 1, orig: f.orig, fixed: f.fixed, reason: f.reason, kind: f.kind };
        if (f.kind === '확정') {
          const k = ids.find((id) => paras[id].text.includes(f.orig));
          if (k == null || paras[k].locked) { rep.notFound++; continue; }
          paras[k] = Object.assign({}, paras[k], { text: paras[k].text.replace(f.orig, f.fixed), source: paras[k].source === 'ai' ? 'ai' : 'ai-edit' }); rep.applied.push(rec);
        } else if (f.kind === '권장') rep.recommended.push(rec); else rep.confirm.push(rec);
      }
    }
    await ctx.saveVer(); await ctx.saveJob();
  };
  HANDLERS.cont_ch = async (ctx, st, idx) => {
    const i = st.arg, work = await ctx.getWork(), ver = await ctx.loadResult(), J = ctx.job;
    const text = C.chapterText(ver.chapters[i]); if (!text.trim()) return;
    const facts = ((work.bible && work.bible.facts) || []).filter((f) => f.chapter <= i).map((f) => `[${f.kind}] ${f.fact} (${f.chapter}장)`).join('\n');
    const r = await ctx.call({ role: '연속성감독', task: 'continuity', label: `${i + 1}장 연속성`, tier: 'default', json: true, validate: V.continuity, prompt: P.T.continuity(work, { label: `${i + 1}장`, bible: bibleText(work, { upTo: i + 1, maxChars: 3000 }), facts, text }) });
    const rep = J.report.continuity = J.report.continuity || { fixed: [], confirm: [] };
    const fixable = r.data.conflicts.filter((c) => !c.maybeIntentional && c.severity !== '경미' && c.fix);
    r.data.conflicts.filter((c) => !fixable.includes(c)).forEach((c) => rep.confirm.push(Object.assign({ chapter: i + 1 }, c)));
    if (fixable.length) {
      await reviseChapter(ctx, i, { level: 2, issues: fixable.map((c, k) => ({ id: 'C' + (k + 1), severity: c.severity, type: '설정', quote: c.quote, problem: c.problem + ' (확정: ' + c.established + ')', fix: c.fix })), plan: '', extra: '설정 충돌만 최소한으로 고친다. 다른 부분은 건드리지 않는다.' });
      fixable.forEach((c) => rep.fixed.push(Object.assign({ chapter: i + 1 }, c)));
    }
    await ctx.saveJob();
  };

  HANDLERS.finalize = async (ctx) => {
    const J = ctx.job, ver = await ctx.loadResult();
    if (!ver) return;
    const total = C.countWithSpaces(C.versionText(ver));
    J.report.final = { chars: total, chapters: ver.chapters.length };
    if (J.type === 'draft') {
      const work = await ctx.getWork(), d = work.bible.design, target = work.brief.target.chars;
      J.report.lengths = d.chapters.map((c, i) => ({ chapter: i + 1, target: c.targetChars, actual: C.countWithSpaces(C.chapterText(ver.chapters[i])) }));
      J.report.target = target; J.report.final.ratio = Math.round((total / target) * 100) / 100;
      if (total < target * 0.8 || total > target * 1.25) ctx.warn(`최종 분량이 목표(${target}자)와 ${Math.round(Math.abs(total / target - 1) * 100)}% 차이 납니다(${total}자).`);
      ver.note = `자동 집필 초고 · 목표 ${target}자 · 실제 ${total}자`;
    } else if (J.type === 'revise' || J.type === 'oneclick') {
      const base = await ctx.base();
      const d = C.diffVersions(base, ver);
      J.report.diff = d.summary;
      J.report.deleted = d.rows.filter((r) => r.type === 'del' && r.a.text.trim()).slice(0, 40).map((r) => ({ chapter: r.a.chapterTitle, text: r.a.text }));
      J.report.added = d.rows.filter((r) => r.type === 'add' && r.b.text.trim()).slice(0, 40).map((r) => ({ chapter: r.b.chapterTitle, text: r.b.text }));
      J.report.examples = d.rows.filter((r) => r.type === 'mod').sort((x, y) => Math.abs(y.b.text.length - y.a.text.length) - Math.abs(x.b.text.length - x.a.text.length)).slice(0, 12).map((r) => ({ chapter: r.a.chapterTitle, before: r.a.text, after: r.b.text }));
      J.report.base = { chars: J.state.baseChars, label: base.label };
    }
    ver.ai = Object.assign(ver.ai || {}, { unprocessed: J.report.unprocessed });
    await ctx.saveVer();
  };

  /* 심사 */
  HANDLERS.judge = async (ctx) => {
    const J = ctx.job, work = await ctx.getWork();
    const ver = J.resultVersionId && J.type !== 'judge' ? await ctx.loadResult() : await ctx.storage.getVersion(J.params.versionId || J.params.baseVersionId);
    if (!ver) throw new AIError('transform_error', '평가할 버전을 찾을 수 없습니다.');
    const inp = buildJudgeInput(ver, work, ctx.cfg.judgeBytes);
    const info = `제목: ${work.title}\n장르: ${work.genre}\n분량: 공백 포함 ${C.countWithSpaces(C.versionText(ver))}자 (${ver.chapters.length}개 장)` + (work.brief && work.brief.pov ? `\n시점: ${work.brief.pov}` : '');
    const r = await ctx.call({ role: '심사위원', task: 'judge', label: '심사위원 평가', tier: 'complex', json: true, validate: V.judge, prompt: P.T.judge(work, { coverage: inp.coverage, info, text: inp.text }) });
    const v = verdictOf(r.data.scores);
    const rec = { id: C.uid('rv'), versionId: ver.id, versionLabel: ver.label, createdAt: new Date().toISOString(), jobId: J.id, coverage: inp.coverage, full: inp.full, verdict: v, report: r.data, disclaimer: P.JUDGE_DISCLAIMER, promptVersion: P.PROMPT_VERSION };
    J.report.judge = rec;
    await ctx.updateWork((w) => { w.reviews = (w.reviews || []).concat([rec]).slice(-30); });
  };

  /* 변환 */
  HANDLERS.prepConvert = async (ctx) => {
    const J = ctx.job, p = J.params, src = await ctx.base(), work = await ctx.getWork();
    if (!src) throw new AIError('transform_error', '원작 버전을 찾을 수 없습니다.');
    if (!J.state.newWorkId) {
      const nw = Object.assign({}, p.newWork);
      await ctx.storage.putWork(nw);
      J.state.newWorkId = nw.id;
    }
    const nv = await ctx.storage.getVersion(J.resultVersionId || '__none__');
    if (!nv) {
      const v = C.makeVersion({ workId: J.state.newWorkId, parentId: null, label: p.direction === 'novel2script' ? 'AI 시나리오(초안)' : 'AI 소설(초안)', kind: 'AI 변환', frozen: true, note: `원작: ${work.title} / ${src.label}`, chapters: src.chapters.map((c) => ({ id: C.uid('c'), title: c.title, paragraphs: [C.newParagraph('')] })) });
      v.ai = { jobId: J.id, type: 'convert', status: 'partial', promptVersion: P.PROMPT_VERSION };
      J.resultVersionId = v.id; ctx.resultVer = v; await ctx.saveVer(); await ctx.saveJob();
      await ctx.storage.putWork(Object.assign(await ctx.storage.getWork(J.state.newWorkId), { currentVersionId: v.id }));
    }
  };
  function convertChunks(src, maxChars) {
    // 장 단위로 묶되, 한 장이 한도보다 길면 단락 경계에서 쪼갠다. [{chapter, paras:[text]}]
    const out = [];
    src.chapters.forEach((c, ci) => { const parts = chunkParas(c.paragraphs.map((p) => p.text), maxChars); parts.forEach((pp, k) => out.push({ chapter: ci, part: k, parts: parts.length, text: pp.join('\n') })); });
    return out;
  }
  HANDLERS.conv_chunk = async (ctx, st) => {
    const J = ctx.job, p = J.params, src = await ctx.base(), work = await ctx.getWork();
    const chunks = convertChunks(src, Math.round(ctx.cfg.chunkChars * 1.3)); const ck = chunks[st.arg];
    if (!ck) return;
    const totalChars = chunks.reduce((a, c) => a + c.text.length, 0);
    const share = ck.text.length / Math.max(1, totalChars);
    const startScene = (J.state.sceneCount || 0) + 1;
    let targetText;
    if (p.direction === 'novel2script') targetText = `전체 ${p.target.minutes ? '러닝타임 약 ' + p.target.minutes + '분' : ''} ${p.target.scenes ? '장면 약 ' + p.target.scenes + '개' : ''}에서 이 부분은 약 ${Math.max(1, Math.round((p.target.minutes || 0) * share)) || '적절한'}분, 장면 ${Math.max(1, Math.round((p.target.scenes || 0) * share)) || '적절한 수의'}개 분량`;
    else targetText = `전체 목표 ${p.target.chars ? p.target.chars + '자' : '원작에 맞는 분량'} 중 이 부분은 약 ${Math.round((p.target.chars || ck.text.length * 2) * share)}자`;
    const args = { format: p.format, modeText: p.modeText, targetText, startScene, bible: bibleText(work, { maxChars: 3000 }), text: ck.text };
    const r = await ctx.call({ role: '각색자', task: p.direction, label: `${st.arg + 1}/${chunks.length} 변환`, prompt: p.direction === 'novel2script' ? P.T.novelToScript(work, args) : P.T.scriptToNovel(work, args) });
    let text = cleanProse(r.text).text;
    if (r.truncated || (p.direction === 'script2novel' && looksTruncated(text))) {
      const r2 = await ctx.call({ role: '각색자', task: 'continue', label: '변환 이어쓰기', prompt: P.T.continueText(work, { scenePlan: '변환 중인 장면을 마무리', tail: lastChars(text, 900) }) });
      text += '\n' + cleanProse(r2.text).text;
      if (r2.truncated) ctx.warn(`${st.arg + 1}번째 변환 묶음이 끝맺지 못했을 수 있습니다.`);
    }
    J.state.chapters[st.arg] = { text }; J.state.sceneCount = (J.state.sceneCount || 0) + (text.match(/^\s*S#\d+/gm) || []).length;
    await ctx.saveJob();
  };
  HANDLERS.map_chunk = async (ctx, st) => {
    const J = ctx.job, src = await ctx.base(); const chunks = convertChunks(src, Math.round(ctx.cfg.chunkChars * 1.3)); const ck = chunks[st.arg]; if (!ck) return;
    const conv = (J.state.chapters[st.arg] || {}).text || '';
    if (!conv) return;
    const r = await ctx.call({ role: '각색자', task: 'sceneMap', label: `${st.arg + 1} 대응표`, tier: 'quick', json: true, validate: V.sceneMap, prompt: P.T.sceneMap({ source: clip(ck.text, 12000), converted: clip(conv, 12000) }) });
    J.report.sceneMap = (J.report.sceneMap || []).concat(r.data.scenes.map((s) => Object.assign({ chunk: st.arg + 1, chapter: ck.chapter + 1 }, s)));
    await ctx.saveJob();
  };
  HANDLERS.convFinalize = async () => {};

  /* 변환의 finalize: 장 구성 채우기 */
  const baseFinalize = HANDLERS.finalize;
  HANDLERS.finalize = async (ctx, st, idx) => {
    if (ctx.job.type !== 'convert') return baseFinalize(ctx, st, idx);
    const J = ctx.job, src = await ctx.base(), ver = await ctx.loadResult();
    const chunks = convertChunks(src, Math.round(ctx.cfg.chunkChars * 1.3));
    const byChapter = new Map();
    chunks.forEach((ck, k) => { const t = (J.state.chapters[k] || {}).text; if (!t) { J.report.unprocessed.push({ step: `${ck.chapter + 1}장 ${ck.part + 1}/${ck.parts}`, reason: '변환 결과 없음' }); return; } byChapter.set(ck.chapter, (byChapter.get(ck.chapter) || []).concat([t])); });
    ver.chapters.forEach((c, ci) => { const parts = byChapter.get(ci); if (parts) c.paragraphs = C.splitLines(parts.join('\n')).map((l) => Object.assign(C.newParagraph(l), { source: 'ai' })); });
    J.report.coreChanges = (J.report.sceneMap || []).filter((s) => s.coreChange);
    J.report.final = { chars: C.countWithSpaces(C.versionText(ver)), scenes: J.state.sceneCount || 0 };
    ver.ai = Object.assign(ver.ai || {}, { unprocessed: J.report.unprocessed });
    await ctx.saveVer();
    const total = C.aggregateCounts(ver.chapters.map((c) => C.countText(C.chapterText(c))), {});
    const nw = await ctx.storage.getWork(J.state.newWorkId);
    nw.counts = { withSpaces: total.withSpaces, noSpaces: total.noSpaces, sheets: total.sheets, simple: total.simple, grid: total.grid, chapters: ver.chapters.length }; nw.updatedAt = new Date().toISOString();
    await ctx.storage.putWork(nw);
  };

  return { DEFAULT_CONFIG, AIError, FATAL, PAUSE, V, extractJSON, cleanProse, looksTruncated, chunkParas, lockify, restoreLocks, driftOk, applyRevision, bibleText, hashStr, createEngine, createRunner, buildJob, estimateJob, buildJudgeInput, verdictOf, JUDGE_KEYS, TYPE_LABEL, step, bytes, convertChunks, critMajor };
});
