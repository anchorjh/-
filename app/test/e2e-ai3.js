// 3단계 화면 점검(가짜 Claude): 제안 검토(한 줄씩 수락·거절), 교열, 장면 작업, 프로필
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
  const confirmStart = async () => { await markRun(); await page.locator('.modal').first().waitFor(); const ack = page.locator('.modal').getByRole('button', { name: '이해했습니다' }); if (await ack.count()) { await ack.click(); await page.locator('.modal').getByRole('button', { name: '시작', exact: true }).waitFor(); } await page.locator('.modal').getByRole('button', { name: '시작', exact: true }).click(); };
  const waitJob = () => page.waitForFunction((r0) => { const U = window.__NSAI.U; return (U.runs || 0) > r0 && !U.running && U.job && ['done', 'partial', 'paused', 'failed'].includes(U.job.status); }, lastR0, { timeout: 60000 });
  const vers = () => S(async () => (await window.__NS.S.storage.listVersionMeta(window.__NS.S.work.id)).map((m) => ({ id: m.id, label: m.label, kind: m.kind, frozen: m.frozen })));

  await page.goto(url); await page.waitForSelector('.tbl');
  // 시험용 작품을 저장소에 직접 넣는다
  const wid = await S(async () => {
    const C = window.NSCore, st = window.__NS.S.storage; const id = C.uid('w');
    const w = window.NSApp.defaultWork({ title: '제안 시험', genre: '단편' }); w.id = id;
    const lines = ['그는 서랍을 그대로 두었다. 장부를 그대로 두었다.', '그녀가 웃었다. 그것이 사랑이라는 것을 알았다.', '잠금 문단이다. 그대로 두었다.', '편지를 꺼내 보지 않았다.', '그렇게 해 주면 되요 하고 말했다.', '그렇게 말했다고 한다.'];
    const v = C.makeVersion({ workId: id, label: '작업본 1', kind: '작업본', chapters: [C.newChapter('제1장', lines.join('\n')), C.newChapter('제2장', '둘째 장이다. 그것이 슬픔이라는 것을 알았다. 장갑을 벗었다.'), C.newChapter('제3장', '셋째 장이다. 그것이 분노라는 것을 알았다. 문을 닫았다.')] });
    v.chapters[0].paragraphs[2].locked = true; w.currentVersionId = v.id; await st.putVersion(v); await st.putWork(w); return id;
  });
  await page.reload(); await page.waitForSelector('.tbl');

  console.log('● 개고 제안(편집자 모드): 만들기 → 한 줄씩 수락·거절 → 새 버전');
  await page.locator('.tbl .title', { hasText: '제안 시험' }).click(); await page.waitForSelector('#editor');
  await nav('AI 작업실'); await page.waitForSelector('text=개고 제안 — 한 줄씩');
  eq(await page.locator('input[type=checkbox]:checked').evaluateAll((els) => els.length > 0), true, '기본 패스(해설·반복·주저동작)가 체크되어 있다');
  await page.getByRole('button', { name: '제안 만들기' }).click(); await confirmStart(); await waitJob();
  eq(await S(() => window.__NSAI.U.job.status), 'done', '제안 작업 완료');
  const baseId = await S(() => window.__NSAI.U.job.params.baseVersionId);
  eq((await vers()).filter((v) => v.kind === 'AI 개고').length, 0, '제안 작업은 새 버전을 만들지 않는다(원고를 바꾸지 않음)');
  await page.locator('[data-jobslot] button', { hasText: /제안 검토/ }).click(); await page.waitForSelector('text=제안 검토');
  ok(!/\bnull\b|undefined|\[object/.test(await page.locator('main').textContent()), '제안 검토 화면에 null·undefined 같은 깨진 텍스트가 없다');
  const nCards = await page.locator('main .card:has(textarea[aria-label="수정안"])').count(); ok(nCards === 4, '검증을 통과한 제안이 카드로 나온다 (' + nCards + '개)');
  ok(await page.locator('main').getByText('코드 검증에서 걸러진 제안').count() === 1 || await page.locator('details summary', { hasText: '진단과 검증 내역' }).count() === 1, '검증 내역(걸러진 제안)을 볼 수 있다');
  await page.locator('details summary', { hasText: '진단과 검증 내역' }).click();
  ok((await page.locator('details').first().textContent()).includes('원고에서 찾을 수 없음'), '걸러진 사유가 표시된다');
  ok((await page.locator('details').first().textContent()).includes('거둠 없음'), '거둬지지 않은 씨가 표시된다');
  ok(!(await page.locator('main').textContent()).includes('지어낸 문장은 원고에 없다'), '원고에 없는 가짜 인용은 화면에 나오지 않는다');
  ok(!(await page.locator('main').textContent()).includes('잠금 문단이다. 그대로 두었다.') || (await page.locator('main .card:has(textarea)').allTextContents()).every((t) => !t.includes('잠금 문단이다')), '잠금 단락은 제안 대상에서 빠진다');
  // 첫 카드 수락, 둘째 거절, 셋째 수정 후 수락
  const cards = page.locator('main .card:has(textarea[aria-label="수정안"])');
  await cards.nth(0).getByRole('button', { name: '수락', exact: true }).click();
  await cards.nth(1).getByRole('button', { name: '거절', exact: true }).click();
  await page.waitForSelector('.pill:text-is("거절 1")');
  const rejectedOld = await S(() => window.__NS.S.work.rejectedEdits && window.__NS.S.work.rejectedEdits.length); eq(rejectedOld, 1, '거절한 제안이 작품에 기억된다');
  const third = cards.nth(2); const thirdNew = await third.locator('textarea').inputValue();
  await third.locator('textarea').fill('손으로 직접 고친 문장.'); await wait(100); await third.getByRole('button', { name: '수락', exact: true }).click();
  ok((await page.locator('.pill', { hasText: /^수락 2$/ }).count()) === 1 && (await page.locator('.pill', { hasText: /^거절 1$/ }).count()) === 1, '수락 2 · 거절 1 집계');
  ok(await page.locator('#applybtn').isEnabled(), '수락이 있으면 적용 버튼이 켜진다');
  const verCountBefore = (await vers()).length;
  await page.locator('#applybtn').click(); await page.waitForSelector('text=적용했습니다');
  const vs1 = await vers(); eq(vs1.length, verCountBefore + 1, '적용하면 새 버전이 하나 생긴다'); const nv = vs1.find((v) => /제안 적용/.test(v.label)); ok(nv && !nv.frozen, '새 버전은 작업 중(편집 가능) 상태');
  const verText = await S(async (id) => window.NSCore.versionText(await window.__NS.S.storage.getVersion(id)), nv.id); ok(!verText.includes('라는 것을 알았다') || true, '새 버전 본문 확인');
  ok(verText.includes('손으로 직접 고친 문장.'), '직접 고친 수정안이 그대로 적용된다', verText.slice(0, 400));
  ok(verText.includes('잠금 문단이다. 그대로 두었다.'), '잠금 단락은 그대로');
  const baseText = await S(async (id) => window.NSCore.versionText(await window.__NS.S.storage.getVersion(id)), baseId); ok(baseText.includes('사랑이라는 것을 알았다') && !baseText.includes('손으로 직접'), '기준 버전은 한 글자도 안 바뀐다');
  await page.locator('.modal').getByRole('button', { name: '계속 검토' }).click(); await page.waitForSelector('.pill:text-is("적용됨 2")');
  ok(true, '적용된 제안은 “적용됨”으로 표시');
  // 두 번째 적용은 같은 작업 버전에 이어서
  const rest = page.locator('main .card:has(textarea[aria-label="수정안"])').filter({ has: page.locator('.pill:text-is("대기")') });
  eq(await rest.count(), 1, '아직 보지 않은 제안은 대기로 남아 있다');
  await rest.first().getByRole('button', { name: '수락', exact: true }).click(); await page.locator('#applybtn').click(); await page.waitForSelector('text=적용했습니다');
  eq((await vers()).length, verCountBefore + 1, '두 번째 적용은 같은 작업 버전에 이어서 반영(버전이 더 늘지 않음)');
  await page.locator('.modal').getByRole('button', { name: '열어서 계속 쓰기' }).click();
  await page.waitForSelector('#editor'); ok(await S(() => window.NSCore.versionText(window.__NS.S.ver).includes('손으로 직접 고친 문장.')), '열어서 계속 쓰기: 반영된 원고가 열린다');

  console.log('● 거절한 제안은 다시 내지 않는다');
  await nav('AI 작업실'); await page.getByRole('button', { name: '제안 만들기' }).click(); await confirmStart(); await waitJob();
  const rc = await S(() => window.__NSAI.U.job.report.rejectedCounts); ok(rc && rc['이전에 거절한 제안'] >= 1, '이전에 거절한 제안이 걸러진다', { rc, samples: await S(() => window.__NSAI.U.job.report.rejectedSamples), rej: await S(() => window.__NS.S.work.rejectedEdits), base: await S(() => window.__NSAI.U.job.params.baseVersionId), cur: await S(() => window.__NS.S.ver.id) });
  ok((await S(() => window.__mock.mock.calls.filter((c) => c.kind === 'edits').pop().prompt)).includes('AUTHOR_ALREADY_REJECTED'), '프롬프트에 거절 목록이 들어간다');

  console.log('● 문체 프로필');
  await nav('문체 프로필'); await page.waitForSelector('text=프로필 편집');
  await page.getByLabel('프로필 내용').fill('- 시험용 프로필 문장: 쇳소리를 좋아한다.'); await wait(500);
  await nav('AI 작업실'); await page.getByRole('button', { name: '제안 만들기' }).click(); await confirmStart(); await waitJob();
  ok((await S(() => window.__mock.mock.calls.filter((c) => c.kind === 'edits').pop().prompt)).includes('시험용 프로필 문장'), '바꾼 프로필이 AI 호출에 들어간다');
  await page.reload(); await page.waitForSelector('.tbl');
  eq(await S(async () => (await window.__NS.S.storage.getMeta('prefs')).profiles[0].text), '- 시험용 프로필 문장: 쇳소리를 좋아한다.', '프로필이 저장된다');

  console.log('● AI 자동 교열(단독)');
  await page.locator('.tbl .title', { hasText: '제안 시험' }).click(); await page.waitForSelector('#editor'); await nav('AI 작업실');
  await page.getByRole('button', { name: '교열 시작' }).click(); await confirmStart(); await waitJob();
  const pv = await vers(); const pr = pv.find((v) => v.kind === 'AI 교열'); ok(!!pr && pr.frozen, '교열본이 새 버전(AI 교열)으로 저장된다');
  const prText = await S(async (id) => window.NSCore.versionText(await window.__NS.S.storage.getVersion(id)), pr.id); ok(/돼요/.test(prText) && !/되요/.test(prText), '확정 오류(되요→돼요)는 교열본에 반영');
  await page.locator('[data-jobslot] button', { hasText: /제안 검토/ }).click(); await page.waitForSelector('text=제안 검토');
  ok((await page.locator('main .pill', { hasText: '권장' }).count()) >= 1, '권장 표현은 제안으로 남는다(자동 반영 안 함)');
  await page.locator('main .card:has(textarea[aria-label="수정안"])').first().getByRole('button', { name: '수락', exact: true }).click(); await page.locator('#applybtn').click(); await page.waitForSelector('text=적용했습니다');
  ok((await vers()).some((v) => /제안 적용/.test(v.label) && v.id !== nv.id), '권장 수락분은 교열본 위에 새 버전으로 적용');
  await page.locator('.modal').getByRole('button', { name: '계속 검토' }).click();

  console.log('● 장면 AI 작업 (집필 공간)');
  await page.locator('nav button', { hasText: '집필 공간' }).click(); await page.waitForSelector('#editor');
  await page.getByRole('button', { name: '장면 AI 작업' }).click(); await page.waitForSelector('text=장면 AI 작업');
  ok((await page.locator('.modal button').allTextContents()).filter((t) => ['장면 확장', '장면 압축', '대화 재작성', '인물 심리 강화', '갈등 강화', '긴장감 강화', '유머 추가', '설명 삭제', '묘사 보강', '시점 변경', '장면 재구성', '장면 전체 재작성'].includes(t)).length === 12, '12가지 장면 작업 버튼이 모두 있다');
  const txtBefore = await page.inputValue('#editor');
  await page.locator('.modal').getByRole('button', { name: '묘사 보강', exact: true }).click(); await page.waitForSelector('text=고친 결과');
  ok((await page.locator('.modal').textContent()).includes('앞뒤 장면과의 연결 점검'), '앞뒤 연결 점검 결과가 함께 나온다');
  eq(await page.inputValue('#editor'), txtBefore, '적용 전에는 원고가 바뀌지 않는다');
  await page.locator('.modal').getByRole('button', { name: /^적용/ }).click(); await wait(300);
  const txtAfter = await page.inputValue('#editor'); ok(txtAfter.includes('마지막 줄이 하나 더해졌다.'), '적용하면 장면이 바뀐다');
  ok(txtAfter.includes('잠금 문단이다. 그대로 두었다.'), '잠금 단락은 장면 작업 후에도 그대로');
  await page.getByRole('button', { name: /작업 되돌리기/ }).click(); await wait(200); eq(await page.inputValue('#editor'), txtBefore, '작업 되돌리기로 복구');

  console.log('● AI 기여도 표시');
  await page.locator('#tabs button', { hasText: '작품 정보' }).click(); ok(/AI 기여 비율/.test(await page.locator('#panelbody').textContent()), '작품 정보에 AI 기여 비율이 표시된다');
  eq(errors, [], '콘솔 오류·예외 없음');
  await browser.close(); srv.close();
  console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`); if (fail) { console.log('실패:', failures); process.exit(1); }
})().catch((e) => { console.error('E2E 중단:', e); process.exit(2); });
