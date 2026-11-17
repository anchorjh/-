// 실제 Claude 대신 쓰는 가짜 sample(). 프롬프트의 작업 문구를 보고 그럴듯한 형식의 답을 돌려준다.
// 답의 문학적 품질은 검증하지 못한다. 단계 연결·재개·검증·되돌림 같은 "배관"을 점검하는 용도다.
const block = (p, tag) => { const m = new RegExp('<' + tag + '>\\n([\\s\\S]*?)\\n</' + tag + '>').exec(p); return m ? m[1] : ''; };
const kinds = [
  ['idea', /아이디어를 발전시킨다/], ['design', /이야기를 설계한다/], ['writeScene', /번째 장면을 쓴다/], ['continue', /직전 출력이 중간에서 끊겼다/],
  ['adjust', /아래 본문이 목표\(약/], ['summarize', /사실 위주로 3~5문장 요약/], ['track', /해결됐는지/], ['revisePlan', /개고 계획을 세운다/],
  ['revise', /을\(를\) 개고한다/], ['diagnose', /을\(를\) 읽고 문제를 찾는다/], ['proofread', /아래 글을 교열한다/], ['continuity', /충돌하는지 점검한다/],
  ['structure', /구조 문제/], ['strategy', /개고 전략을 세운다/], ['styleCheck', /문체가 어긋나는 장/], ['judge', /아래 원고를 평가한다/],
  ['novelToScript', /형식으로 각색한다/], ['scriptToNovel', /시나리오의 일부를 소설로 바꾼다/], ['sceneMap', /장면 대응표를 만든다/],
];
function kindOf(p) { for (const [k, re] of kinds) if (re.test(p)) return k; return 'unknown'; }
const sentence = (tag, j) => `${tag}의 ${j}번째 문장은 정숙이 가게에서 대파를 다듬고 용석이 상자를 옮기는 장면이다.`;
function prose(tag, chars, marker) {
  const paras = []; let n = 0, len = 0, j = 0;
  while (len < chars) { const ss = [1, 2, 3].map(() => sentence(tag, ++j)); const p = ss.join(' '); paras.push(p); len += p.length + 1; if (++n > 400) break; }
  if (marker) paras[0] = marker + ' ' + paras[0];
  return paras.join('\n');
}
function makeMock(o) {
  o = o || {};
  const m = { calls: [], count: {}, script: o.script || [] };
  const fn = async (prompt, opts) => {
    const kind = kindOf(prompt); m.count[kind] = (m.count[kind] || 0) + 1; m.calls.push({ kind, prompt, opts });
    if (m.delay) await new Promise((r) => setTimeout(r, m.delay));
    if (opts && opts.signal && opts.signal.aborted) throw { code: 'cancelled', message: 'aborted' };
    for (const s of m.script) { // {kind, nth?, code, times, truncated, when(prompt)}
      if (s.kind !== kind) continue; if (s.when && !s.when(prompt, m)) continue; if (s.times != null && s.times <= 0) continue;
      if (s.nth != null && s.nth !== m.count[kind]) continue;
      if (s.abort) { s.abort(); if (opts.signal && opts.signal.aborted) throw { code: 'cancelled', message: 'aborted' }; }
      if (s.code) { if (s.times != null) s.times--; throw { code: s.code, message: s.code, text: '' }; }
    }
    const res = respond(kind, prompt, m);
    if (typeof res.data !== 'undefined') { return res; }
    return res;
  };
  const trunc = (kind, prompt) => m.script.some((s) => s.kind === kind && s.truncated && s.times > 0 && (!s.when || s.when(prompt, m)) && (s.times--, true));
  function respond(kind, prompt, mm) {
    const J = (x) => ({ __json: x });
    const wrap = (x) => (x && x.__json !== undefined ? x : x);
    switch (kind) {
      case 'idea': return J({ logline: '새벽 시장의 부부가 외상을 받으러 간다.', coreIdea: '외상장부가 관계의 장부가 된다', protagonistDesire: '떳떳하게 돈을 받고 싶다', mainConflict: '남편이 받으러 가기를 미룬다', cause: '식당 주인과의 오랜 인연', expectedEnding: '상품권으로 갚으려는 주인과 마주 앉는다', differentiators: ['생활 디테일'], similar: [], assumed: ['배경을 현대 서울로 정함'] });
      case 'design': {
        const n = +(/총 (\d+)개 장/.exec(prompt) || [0, 3])[1] || 3, total = +(/\((\d+)자\)/.exec(prompt) || [0, 3000])[1];
        const chs = Array.from({ length: n }, (_, i) => ({ no: i + 1, title: `제${i + 1}장 제목${i + 1}`, pov: '정숙', goal: `목표${i + 1}`, summary: `${i + 1}장 요약`, keyEvents: [`사건${i + 1}`], function: '전개', targetChars: Math.round(total / n), scenes: [{ summary: `${i + 1}장 장면A`, targetChars: Math.round(total / n / 2) }, { summary: `${i + 1}장 장면B`, targetChars: Math.round(total / n / 2) }] }));
        return J({ synopsis: '부부가 외상을 받으러 가는 하루', characters: [{ name: '정숙', age: '52', role: '주인공', desire: '받을 돈', speech: '짧고 건조', secret: '' }, { name: '용석', age: '55', role: '남편', desire: '피하기', speech: '느릿', secret: '' }], relations: [{ a: '정숙', b: '용석', relation: '부부' }], events: [{ no: 1, event: '장부를 꺼낸다', cause: '석 달째 미수' }], chapters: chs, twists: [] });
      }
      case 'writeScene': {
        const tag = /(\d+)장 .*?의 (\d+)\/(\d+)번째/.exec(prompt) || [0, '?', '?', '?'];
        const target = +(/약 (\d+)자\(±20%\)/.exec(prompt) || [0, 600])[1];
        let text = prose(`${tag[1]}장${tag[2]}`, target, (m.markProblem && m.markProblem(+tag[1], +tag[2])) || '');
        return { text, truncated: trunc('writeScene', prompt) ? true : false };
      }
      case 'continue': return { text: '그렇게 장면은 마무리되었다.', truncated: false };
      case 'adjust': { const text = block(prompt, 'TEXT'); const tgt = +(/약 (\d+)자/.exec(prompt) || [0, 800])[1]; return { text: prose('조정', tgt), truncated: false }; }
      case 'summarize': return J({ summary: '정숙이 대파를 다듬고 용석이 상자를 옮겼다.', characters: [{ name: '정숙', age: '52', traits: '꼼꼼', speech: '짧음' }], facts: [{ fact: '정숙은 52세다', kind: '나이' }], events: ['장부를 꺼냈다'] });
      case 'diagnose': {
        const t = block(prompt, 'TEXT');
        if (m.diagHook) { const h = m.diagHook(t, prompt); if (h) return J(h); }
        const bad = /\[문제\]/.test(t);
        return J({ issues: bad ? [{ id: 'I1', severity: '중요', type: '인과', quote: '[문제]', problem: '원인이 없다', fix: '원인을 보강' }] : [], aiTells: [], summary: bad ? '문제 있음' : '양호' });
      }
      case 'track': { const prev = JSON.parse(block(prompt, 'PREVIOUS_ISSUES')), next = JSON.parse(block(prompt, 'NEW_ISSUES')); if (m.trackHook) return J(m.trackHook(prev, next)); return J({ previous: prev.map((p) => ({ id: p.id, status: next.length ? '미해결' : '해결' })), newIssueIds: [] }); }
      case 'revisePlan': return J({ actions: [{ action: '다듬기', target: '전체', instruction: '인과를 보강' }], keep: ['결말'] });
      case 'revise': {
        let t = block(prompt, 'TEXT_TO_REVISE');
        if (m.reviseHook) { const h = m.reviseHook(t, prompt); if (h != null) return { text: h, truncated: false }; }
        t = t.replace(/\[문제\] ?/g, '').replace(/ 정숙이/g, ' 정숙이 문득');
        if (!/했었다/.test(t)) t = t.replace(/했다/, '했었다');
        return { text: t, truncated: false };
      }
      case 'proofread': { const t = block(prompt, 'TEXT'); const i = t.indexOf('되요'); return J({ fixes: i >= 0 ? [{ orig: t.slice(Math.max(0, i - 6), i + 2), fixed: t.slice(Math.max(0, i - 6), i) + '돼요', kind: '확정', reason: '맞춤법' }, { orig: '그렇게 말했다', fixed: '그리 말했다', kind: '권장', reason: '문체' }] : [] }); }
      case 'continuity': return J({ conflicts: m.conflicts || [] });
      case 'structure': return J({ issues: [{ id: 'S1', severity: '중요', chapters: [2], problem: '2장 동기 약함', fix: '보강' }], strengths: ['생활감'] });
      case 'strategy': return J({ level: 4, global: ['동기 보강'], chapters: [{ no: 1, instruction: '속도 유지' }] });
      case 'styleCheck': return J({ inconsistent: m.styleInconsistent || [] });
      case 'judge': return J(m.judgeData || { scores: { 완성도: { score: 7, reason: '구조가 안정적', evidence: ['대파 장면'] }, 신선함: { score: 6, reason: '소재가 익숙', evidence: [] }, 문장력: { score: 7, reason: '담담', evidence: [] }, '인물 생동감': { score: 8, reason: '말투 구분', evidence: [] }, '결말의 힘': { score: 6, reason: '여운 약함', evidence: [] } }, strengths: '생활 디테일', fatalWeakness: '결말', structure: '안정', characters: '살아 있음', prose: '담담', ending: '약함', disadvantages: '소재', revisionNeeds: [{ where: '3장', what: '결말' }], finalReview: '본선 문턱', winChancePercent: 12, winChanceBasis: '주관적 추정' });
      case 'novelToScript': { const t = block(prompt, 'NOVEL_EXCERPT'); const s = +(/S#(\d+)번호|장면 번호는 (\d+)번부터/.exec(prompt) || [0, 1, 1])[2] || 1; return { text: `S#${s}. 시장 골목 - 새벽\n정숙이 셔터를 올린다.\n정숙\n(혼잣말) ${t.slice(0, 20)}\nS#${s + 1}. 가게 안 - 새벽\n용석이 상자를 내려놓는다.`, truncated: false }; }
      case 'scriptToNovel': return { text: '정숙은 셔터를 올렸다. 냉장고 소리가 먼저 들렸다.\n용석이 상자를 내려놓았다.', truncated: false };
      case 'sceneMap': return J({ scenes: [{ target: 'S#1', source: '1장 첫 문단', relation: '유지', coreChange: false, note: '' }, { target: 'S#2', source: '(없음)', relation: '신규', coreChange: true, note: '인물 관계 변경' }] });
      default: return { text: '알 수 없는 요청', truncated: false };
    }
  }
  const sample = async (prompt, opts) => { const r = await fn(prompt, opts); if (r && r.__json !== undefined) return { text: JSON.stringify(r.__json), truncated: false }; return r; };
  sample.json = async (prompt, opts) => { const r = await fn(prompt, opts); if (r && r.__json !== undefined) return JSON.parse(JSON.stringify(r.__json)); if (r && typeof r.text === 'string') { try { return JSON.parse(r.text); } catch (e) { throw { code: 'invalid_json', message: 'not json', text: r.text }; } } return r; };
  sample.limits = async () => ({ maxPromptBytes: 262144, modelTiers: ['quick', 'default', 'complex'] });
  return Object.assign(sample, { mock: m });
}
module.exports = { makeMock, kindOf, block, prose };
