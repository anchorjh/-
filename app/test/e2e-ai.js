// 2단계(AI) 화면 점검. 실제 Claude 대신 가짜 sample 을 쓰므로 "배관"(흐름·저장·재개·표시)만 검증한다.
const fs = require('fs'), os = require('os'), path = require('path');
const { serve, newPage, chromium, withMockClaude } = require('./e2e-helpers.js');
let pass = 0, fail = 0; const failures = [];
const ok = (c, name, extra) => { if (c) { pass++; console.log('  ✓ ' + name); } else { fail++; failures.push(name); console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { actual: a, expected: b });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { srv, url } = await serve(); const browser = await chromium.launch();
  const { ctx, page, errors } = await newPage(browser); await withMockClaude(ctx);
  const S = (fn, arg) => page.evaluate(fn, arg);
  const nav = (t) => page.locator('nav button', { hasText: t }).click();
  let lastR0 = 0;
  const markRun = async () => { lastR0 = await S(() => (window.__NSAI && window.__NSAI.U.runs) || 0); };
  const confirmStart = async () => {
    await markRun();
    const m = page.locator('.modal');
    await m.first().waitFor();
    const ack = m.getByRole('button', { name: '이해했습니다' }); if (await ack.count()) { await ack.click(); await page.locator('.modal').getByRole('button', { name: '시작', exact: true }).waitFor(); }
    await page.locator('.modal').getByRole('button', { name: '시작', exact: true }).click();
  };
  const waitJob = (ms) => page.waitForFunction((r0) => { const U = window.__NSAI.U; return (U.runs || 0) > r0 && !U.running && U.job && ['done', 'partial', 'paused', 'failed'].includes(U.job.status); }, lastR0, { timeout: ms || 60000 });
  const jobStatus = () => S(() => window.__NSAI.U.job.status);
  const vmeta = () => S(async () => (await window.__NS.S.storage.listVersionMeta(window.__NS.S.work.id)).map((m) => ({ id: m.id, label: m.label, kind: m.kind, frozen: m.frozen, ai: m.ai, parent: m.parentId })));

  console.log('● 마법사(단계별): 재료 → 구상 → 시놉시스·구조 → 초고');
  await page.goto(url); await page.waitForSelector('.tbl');
  await nav('AI로 새 작품'); await page.waitForSelector('text=재료');
  ok(!(await page.locator('main').textContent()).includes('null'), '마법사 화면에 null 같은 깨진 텍스트가 없다');
  await page.getByLabel('키워드 (짧게)').fill('새벽 시장, 외상장부, 부부');
  await page.getByLabel(/스토리라인/).fill('새벽 시장에서 가게를 하는 부부가 석 달 치 외상을 받으러 가기까지의 하루.');
  await page.getByLabel('장 수').fill('3'); await page.getByLabel('장 수').dispatchEvent('change');
  await page.getByLabel('분량', { exact: true }).fill('20'); await page.getByLabel('분량', { exact: true }).dispatchEvent('change');
  await page.getByRole('button', { name: '구상 만들기' }).click();
  await confirmStart(); await waitJob();
  await page.waitForSelector('textarea[aria-label="로그라인"]');
  ok((await page.inputValue('textarea[aria-label="로그라인"]')).includes('외상'), '구상이 편집 가능한 칸으로 나온다');
  eq(await S(() => window.__mock.mock.calls[0].opts.cache), false, '호출은 캐시를 쓰지 않는다');
  await page.fill('textarea[aria-label="로그라인"]', '직접 고친 로그라인'); await wait(900);
  eq(await S(async () => (await window.__NS.S.storage.listWorks()).find((w) => w.aiGenerated).bible.idea.logline), '직접 고친 로그라인', '직접 고친 구상이 저장된다');
  await page.getByRole('button', { name: '이 구상으로 시놉시스·구조 만들기' }).click(); await confirmStart(); await waitJob();
  await page.waitForSelector('input[aria-label="1장 제목"]');
  eq(await page.locator('input[aria-label$="장 제목"]').count(), 3, '설계안에 3개 장이 있다');
  const tsum = await page.locator('text=/장별 목표 합계/').textContent(); ok(/4,000자/.test(tsum) || /3,99\d자|4,00\d자/.test(tsum), '장별 목표 합계가 전체 목표 근처', tsum);
  await page.fill('input[aria-label="1장 제목"]', '고친 첫 장'); await wait(900);
  eq(await S(async () => (await window.__NS.S.storage.listWorks()).find((w) => w.aiGenerated).bible.design.chapters[0].title), '고친 첫 장', '직접 고친 장 제목이 저장된다');
  await page.getByRole('button', { name: '확정하고 초고 집필' }).click(); await confirmStart(); await waitJob();
  await page.waitForSelector('text=초고가 만들어졌습니다');
  eq(await page.locator('.card', { hasText: '초고가 만들어졌습니다' }).locator('table.tbl tbody tr').count(), 3, '완료 화면에 장별 목표·실제 분량 표가 있다');
  const wid = await S(async () => (await window.__NS.S.storage.listWorks()).find((w) => w.aiGenerated).id);
  await page.getByRole('button', { name: '집필 공간에서 열기' }).click(); await page.waitForSelector('#editor');
  ok((await page.inputValue('#editor')).length > 500, '집필 공간에 생성된 초고가 열린다');
  eq(await S(() => window.__NS.S.ver.kind), 'AI 초고', '버전 종류는 “AI 초고”');
  eq(await page.locator('.chitem').count(), 3, '장이 3개');
  eq(await S(() => window.__NS.S.ver.chapters[0].title), '고친 첫 장', '고친 장 제목이 초고에 반영');
  await page.locator('#tabs button', { hasText: '버전' }).click(); await page.waitForSelector('.pill:text-is("AI 100%")');
  ok(true, '버전 목록에 AI 기여도(100%)가 표시된다');

  console.log('● 마법사(완전 자동 + 원클릭 완성까지)');
  await nav('AI로 새 작품'); await page.getByRole('button', { name: '새로 시작' }).click(); await page.locator('.modal').getByRole('button', { name: '새로 시작' }).click();
  await page.getByLabel('키워드 (짧게)').fill('자동 테스트'); await page.getByLabel('장 수').fill('2'); await page.getByLabel('장 수').dispatchEvent('change');
  await page.getByLabel('분량', { exact: true }).fill('10'); await page.getByLabel('분량', { exact: true }).dispatchEvent('change');
  await page.getByLabel(/완전 자동 — /).check(); await page.getByLabel(/원클릭 AI 완성”까지/).check();
  await page.getByRole('button', { name: '완전 자동으로 시작' }).click(); await confirmStart();
  await page.waitForFunction(() => window.__NSAI.U.wiz.stage === 'done' && !window.__NSAI.U.running, null, { timeout: 90000 });
  await page.waitForSelector('text=초고가 만들어졌습니다');
  const kinds = await S(async () => { const w = (await window.__NS.S.storage.listWorks()).filter((x) => x.aiGenerated).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; return { jobs: (await window.__NS.S.storage.listJobs(w.id)).map((j) => j.type + ':' + j.status).sort(), vers: (await window.__NS.S.storage.listVersionMeta(w.id)).map((m) => m.kind).sort() }; });
  eq(kinds.jobs, ['draft:done', 'oneclick:done', 'phase:done', 'phase:done'], '구상·설계·초고·원클릭 작업이 차례로 모두 완료');
  ok(kinds.vers.includes('AI 초고') && kinds.vers.includes('AI 개고'), '초고와 개고본이 별도 버전으로 남는다', kinds.vers);

  console.log('● AI 작업실: 자동 개고 (원본 불변·잠금·보고서·비교·단락 되돌리기)');
  await nav('작품 보관함'); await page.locator('.tbl .title', { hasText: '[예시]' }).click(); await page.waitForSelector('#editor');
  await page.click('#editor'); await page.keyboard.press('Control+Home'); await wait(300);
  await page.locator('#tabs button', { hasText: '단락' }).click(); await wait(100); await page.getByLabel('이 단락 잠금').check(); await wait(900);
  const lockedText = await S(() => window.__NS.S.ver.chapters[0].paragraphs[0].text);
  const lockedId = await S(() => window.__NS.S.ver.chapters[0].paragraphs[0].id);
  await nav('AI 작업실'); await page.waitForSelector('text=AI 자동 개고');
  const baseId0 = await S(() => window.__NS.S.ver.id);
  await page.getByRole('button', { name: '개고 시작' }).click(); await confirmStart(); await waitJob();
  eq(await jobStatus(), 'done', '개고 작업 완료');
  const vm = await vmeta();
  const res = vm.find((v) => v.kind === 'AI 개고'); ok(!!res && res.ai.status === 'complete' && res.frozen, '결과는 새 버전(AI 개고, 고정)으로 저장');
  const base = vm.find((v) => v.id === res.parent); ok(base && base.frozen, '기준 버전은 고정되어 있다(작업 중이던 버전을 자동 고정)');
  const rv = await S(async (id) => window.__NS.S.storage.getVersion(id), res.id);
  const lp = rv.chapters[0].paragraphs.find((p) => p.id === lockedId);
  eq(lp && lp.text, lockedText, '잠금한 단락은 개고 후에도 그대로'); ok(rv.chapters.flatMap((c) => c.paragraphs).some((p) => p.source === 'ai-edit'), '바뀐 단락에 AI 수정 출처가 표시된다');
  await page.getByRole('button', { name: '결과 보고서' }).click(); await page.waitForSelector('text=원본 대비 변경');
  ok(await page.locator('.modal').getByText('수정', { exact: false }).count() > 0, '보고서에 원본 대비 변경 요약');
  await page.locator('.modal').getByRole('button', { name: '원본과 비교' }).click(); await page.waitForSelector('.diff');
  const nMod = await page.locator('.diff .c.r.mod').count(); ok(nMod >= 1, '비교 화면에 개고된 단락이 표시된다', nMod);
  await page.getByRole('button', { name: '이 단락을 A(이전)로 되돌리기' }).first().click(); await page.waitForSelector('.diff');
  const vm2 = await vmeta(); ok(vm2.some((v) => v.kind === '작업본' && v.parent === res.id && !v.frozen), '되돌리면 AI 결과는 보존하고 새 작업본이 만들어진다');
  eq(await page.locator('.diff .c.r.mod').count(), nMod - 1, '되돌린 단락은 더 이상 차이로 나오지 않는다');
  const nPill = await page.locator('.pill', { hasText: /^수정 \d+$/ }).first().textContent(); ok(/수정 \d+/.test(nPill), '요약 표시 갱신');

  console.log('● 중지 → 이어서 진행');
  await nav('AI 작업실'); await S(() => { window.__mock.mock.delay = 250; });
  await page.getByRole('button', { name: '원클릭 완성 시작' }).click(); await confirmStart();
  await wait(700); await page.locator('[data-jobslot] button', { hasText: '중지' }).first().click(); await waitJob();
  eq(await jobStatus(), 'paused', '중지하면 멈춤 상태'); const pj = await S(() => ({ done: window.__NSAI.U.job.steps.filter((s) => s.status === 'done').length, total: window.__NSAI.U.job.steps.length, id: window.__NSAI.U.job.id }));
  ok(pj.done > 0 && pj.done < pj.total, '일부 단계만 완료된 채 저장', pj);
  await S(() => { window.__mock.mock.delay = 0; });
  const callsBefore = await S(() => window.__mock.mock.calls.length);
  await markRun(); await page.locator('[data-jobslot] button', { hasText: '이어서 진행' }).first().click(); await waitJob();
  eq(await jobStatus(), 'done', '이어서 진행하면 끝까지 완료');
  const reran = await S((id) => window.__mock.mock.calls.slice(0).length, pj.id); ok(reran > callsBefore, '이어서 새 호출이 일어난다');

  console.log('● 새로고침으로 끊긴 작업 복구');
  await S(() => { window.__mock.mock.delay = 300; });
  await page.getByRole('button', { name: '원클릭 완성 시작' }).click(); await confirmStart(); await wait(600);
  await page.reload(); await page.waitForSelector('.tbl');
  const jj = await S(async () => (await window.__NS.S.storage.listJobs()).filter((j) => j.type === 'oneclick').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]);
  eq(jj.status, 'paused', '새로고침 뒤 작업은 “멈춤”으로 복구된다'); ok(/새로고침|닫거나/.test(jj.pausedReason), '사유가 안내된다', jj.pausedReason);
  ok(jj.steps.every((s) => s.status !== 'running'), '진행 중이던 단계는 다시 대기로');

  console.log('● 모델 거부는 숨기지 않는다');
  await page.locator('.tbl .title', { hasText: '[예시]' }).click(); await page.waitForSelector('#editor'); await nav('AI 작업실');
  await S(() => { window.__mock.mock.delay = 0; window.__mock.mock.script.push({ kind: 'revise', code: 'refused', times: 999 }); });
  await page.getByRole('button', { name: '개고 시작' }).click(); await confirmStart(); await waitJob();
  eq(await jobStatus(), 'partial', '거부가 있으면 “일부 미처리”로 끝난다(완료로 표시하지 않는다)');
  ok(await page.waitForSelector('[data-jobslot] .banner.danger', { timeout: 4000 }).then(() => true, () => false), '처리하지 못한 곳이 화면에 표시된다');
  await S(() => { window.__mock.mock.script.length = 0; });

  console.log('● 심사위원 진단·반론');
  await page.getByRole('button', { name: '진단 시작' }).click(); await confirmStart(); await waitJob();
  await page.waitForSelector('text=심사위원 보고서');
  ok((await page.locator('.modal').textContent()).includes('읽은 범위: 전체'), '읽은 범위가 보고서에 나온다');
  ok((await page.locator('.modal').textContent()).includes('주관적 추정'), '면책 문구');
  ok(/종합 판정: (당선권|본선권|예심 통과권|탈락|응모 부적합)/.test(await page.locator('.modal').textContent()), '등급 표시');
  await page.getByLabel('반론').fill('2장의 동기는 3장에서 밝혀집니다.'); await page.getByRole('button', { name: '반론 검토 요청' }).click(); await wait(500);
  eq(await page.locator('.modal').getByText('작가 반론: 2장의 동기는').count(), 1, '반론과 검토 결과가 화면에 기록된다');
  await page.locator('.modal').getByRole('button', { name: '닫기', exact: true }).last().click();
  ok(await S(() => window.__NS.S.work.reviews.length) >= 2, '심사 기록이 작품에 쌓인다(원클릭 때 1건 + 이번 1건)');
  await page.reload(); await page.waitForSelector('.tbl');
  eq(await S(async () => (await window.__NS.S.storage.listWorks()).find((w) => w.title.startsWith('[예시]')).reviews.slice(-1)[0].rebuttals.length), 1, '반론도 저장된다');

  console.log('● 변환: 소설 → 시나리오 (파생 작품)');
  await page.locator('.tbl .title', { hasText: '[예시]' }).first().click(); await page.waitForSelector('#editor'); await nav('AI 작업실');
  await page.getByRole('button', { name: '변환 시작' }).click(); await confirmStart(); await waitJob();
  eq(await jobStatus(), 'done', '변환 완료');
  await nav('작품 보관함'); ok(await page.locator('.pill', { hasText: '파생' }).count() >= 1 && await page.locator('.pill', { hasText: '시나리오' }).count() >= 1, '보관함에 시나리오·파생 표시');
  const srcAfter = await S(async () => { const w = (await window.__NS.S.storage.listWorks()).find((x) => x.title.startsWith('[예시]') && !x.derivedFrom); return (await window.__NS.S.storage.listVersionMeta(w.id)).length; }); ok(srcAfter >= 3, '원작의 버전은 그대로');
  await page.locator('.tbl .title', { hasText: '시나리오' }).first().click(); await page.waitForSelector('#editor');
  ok((await page.inputValue('#editor')).includes('S#1.'), '시나리오 본문(S#1.)');

  console.log('● 설정·고지');
  await nav('설정·백업'); await page.waitForSelector('h2:text-is("저장소")'); ok(await page.getByText('AI 설정', { exact: true }).count() === 1, '설정에 AI 설정 카드');
  ok((await page.locator('main').textContent()).includes('Claude로 전송'), '원고가 Claude로 전송된다는 고지');
  eq(errors, [], '콘솔 오류·예외 없음');

  console.log('● AI를 쓸 수 없는 환경');
  const p2 = await newPage(browser); // window.claude 없음
  await p2.page.goto(url); await p2.page.waitForSelector('.tbl'); await p2.page.locator('nav button', { hasText: 'AI로 새 작품' }).click(); await p2.page.waitForSelector('#aiunavail');
  ok(true, 'AI 불가 환경에서는 안내 배너가 뜬다');
  await p2.page.getByLabel('키워드 (짧게)').fill('x'); await p2.page.getByRole('button', { name: '구상 만들기' }).click(); await p2.page.locator('.modal').waitFor();
  await p2.page.locator('.modal').getByRole('button', { name: '이해했습니다' }).click(); await p2.page.locator('.modal').getByRole('button', { name: '시작', exact: true }).click();
  await p2.page.waitForSelector('.toast.err'); ok((await p2.page.locator('.toast.err').first().textContent()).includes('AI'), 'AI를 못 쓰면 오류로 알린다(가짜 결과를 보여 주지 않는다)');
  await p2.ctx.close();

  await browser.close(); srv.close();
  console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`); if (fail) { console.log('실패:', failures); process.exit(1); }
})().catch((e) => { console.error('E2E 중단:', e); process.exit(2); });
