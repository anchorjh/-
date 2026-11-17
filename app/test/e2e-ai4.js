// 3단계(b) 화면 점검(가짜 Claude): 장르 전환, 고증, 인물·설정·연속성, 공모전, 온보딩
const { serve, newPage, chromium, withMockClaude } = require('./e2e-helpers.js');
let pass = 0, fail = 0; const failures = [];
const ok = (c, name, extra) => { if (c) { pass++; console.log('  ✓ ' + name); } else { fail++; failures.push(name); console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { actual: a, expected: b });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { srv, url } = await serve(); const browser = await chromium.launch();
  const { ctx, page, errors } = await newPage(browser); await withMockClaude(ctx);
  const S = (fn, arg) => page.evaluate(fn, arg);
  const nav = (t) => page.locator('nav button', { hasText: t }).first().click();
  let lastR0 = 0;
  const markRun = async () => { lastR0 = await S(() => (window.__NSAI && window.__NSAI.U.runs) || 0); };
  const confirmStart = async () => { await markRun(); await page.locator('.modal').first().waitFor(); const ack = page.locator('.modal').getByRole('button', { name: '이해했습니다' }); if (await ack.count()) { await ack.click(); await page.locator('.modal').getByRole('button', { name: '시작', exact: true }).waitFor(); } await page.locator('.modal').getByRole('button', { name: '시작', exact: true }).click(); };
  const waitJob = () => page.waitForFunction((r0) => { const U = window.__NSAI.U; return (U.runs || 0) > r0 && !U.running && U.job && ['done', 'partial', 'paused', 'failed'].includes(U.job.status); }, lastR0, { timeout: 60000 });
  const clean = async (label) => ok(!/\bnull\b|undefined|\[object/.test(await page.locator('main').textContent()), `${label}: null·undefined 같은 깨진 글자가 없다`);

  await page.goto(url); await page.waitForSelector('.tbl');
  console.log('● 온보딩');
  ok(await page.locator('#onboarding').count() === 1, '처음 열면 안내 배너가 보인다');
  await page.locator('#onboarding').getByRole('button', { name: '알겠습니다' }).click(); await wait(300); ok(await page.locator('#onboarding').count() === 0, '닫으면 사라진다');
  await page.reload(); await page.waitForSelector('.tbl'); ok(await page.locator('#onboarding').count() === 0, '새로고침해도 다시 뜨지 않는다');

  const wid = await S(async () => {
    const C = window.NSCore, st = window.__NS.S.storage; const id = C.uid('w'); const w = window.NSApp.defaultWork({ title: '고증 시험', genre: '단편' }); w.id = id; w.penName = '홍길동'; w.names = ['정숙'];
    const v = C.makeVersion({ workId: id, label: '작업본 1', kind: '작업본', chapters: [C.newChapter('제1장', '1980년대 시장에서 정숙은 핸드폰을 꺼냈다. 연락은 010-1234-5678로 왔다.\n홍길동이 말했다.'), C.newChapter('제2장', '둘째 장이다. 정숙은 장갑을 벗었다.')] });
    w.currentVersionId = v.id; await st.putVersion(v); await st.putWork(w); return id;
  });
  await page.reload(); await page.waitForSelector('.tbl');
  await page.locator('.tbl .title', { hasText: '고증 시험' }).click(); await page.waitForSelector('#editor');

  console.log('● 고증 점검');
  await nav('AI 작업실'); await page.waitForSelector('text=역사·자료 고증 점검');
  ok((await page.locator('main').textContent()).includes('출처를 확인하지 못합니다'), '웹 검색 없이 출처를 확인하지 못한다는 경고가 먼저 나온다');
  await page.getByLabel('시대·장소', { exact: true }).fill('1980년대 서울'); await page.getByRole('button', { name: '고증 점검 시작' }).click(); await confirmStart(); await waitJob();
  await page.waitForSelector('text=시대착오 가능성'); const rep = await page.locator('.modal').textContent();
  ok(rep.includes('핸드폰') && rep.includes('시대착오 가능성 (1)'), '시대착오 항목이 분류되어 나온다'); ok(!rep.includes('지어낸 인용은 없다'), '원고에 없는 인용은 버린다'); ok(rep.includes('웹 검색 없이'), '보고서에도 출처 미확인 경고');
  eq(await S(async (id) => (await window.__NS.S.storage.listVersionMeta(id)).length, wid), 1, '고증 점검은 새 버전을 만들지 않는다(원고를 바꾸지 않음)');
  await page.locator('.modal').getByRole('button', { name: '닫기', exact: true }).last().click();

  console.log('● 장르 전환');
  await page.getByLabel('장르 전환', { exact: true }).check(); await page.waitForSelector('select[aria-label="목표 장르"]');
  ok(await page.locator('main').getByText('유지할 요소').count() === 1, '유지할 요소 체크 목록이 나온다');
  await page.getByLabel('목표 장르').selectOption('스릴러'); await page.getByRole('button', { name: '변환 시작' }).click(); await confirmStart(); await waitJob();
  eq(await S(() => window.__NSAI.U.job.status), 'done', '장르 전환 완료');
  const gw = await S(async () => (await window.__NS.S.storage.listWorks()).find((w) => w.derivedFrom && w.derivedFrom.kind === 'genre')); ok(!!gw && /스릴러/.test(gw.title), '파생 작품이 새로 만들어진다', gw && gw.title);
  eq(await S(async (id) => (await window.__NS.S.storage.listVersionMeta(id)).length, wid), 1, '원작 버전은 그대로');
  ok((await S((w) => window.__NS.S.storage.listVersionMeta(w), gw.id)).some((m) => /장르 전환\(스릴러\)/.test(m.label)), '결과 버전 이름에 목표 장르가 들어간다');

  console.log('● 인물·설정·연속성');
  await nav('작품 보관함'); await page.locator('.tbl .title', { hasText: /^고증 시험$/ }).click(); await page.waitForSelector('#editor');
  await nav('인물·설정'); await page.waitForSelector('text=원고에서 설정 추출'); await clean('인물·설정');
  await page.getByRole('button', { name: '원고에서 설정 추출' }).click(); await confirmStart(); await waitJob();
  await page.waitForSelector('input[aria-label="사실 1"]'); await wait(300);
  ok((await page.locator('input[aria-label="인물 1 이름"]').inputValue()) === '정숙', '추출한 인물이 설정집에 채워진다');
  ok((await page.locator('input[aria-label="사실 1"]').inputValue()).includes('52세'), '추출한 확정 사실이 채워진다');
  await page.locator('input[aria-label="사실 1"]').fill('정숙은 50세다'); await wait(900);
  eq(await S(async (id) => (await window.__NS.S.storage.getWork(id)).bible.facts[0].fact, wid), '정숙은 50세다', '설정집을 직접 고치면 저장된다');
  await page.getByRole('button', { name: '인물 추가' }).click(); ok(await page.locator('input[aria-label="인물 2 이름"]').count() === 1, '인물을 추가할 수 있다');
  await S(() => { window.__mock.mock.conflicts = [{ kind: '나이', quote: '정숙은 장갑을 벗었다', established: '정숙은 50세다', problem: '나이 표기가 다르다', severity: '중요', maybeIntentional: false, fix: '50세로' }]; });
  await page.getByRole('button', { name: '연속성 점검' }).click(); await confirmStart(); await waitJob(); await wait(300); await page.waitForSelector('text=확인이 필요한 곳');
  eq(await S(async (id) => (await window.__NS.S.storage.listVersionMeta(id)).length, wid), 1, '연속성 점검은 원고를 바꾸지도, 새 버전을 만들지도 않는다');
  ok((await page.locator('main').textContent()).includes('나이 표기가 다르다'), '충돌이 작가 확인 목록으로 나온다(자동으로 고치지 않음)');
  await page.getByRole('button', { name: '문제 없음' }).first().click(); await wait(400);
  eq(await S(async (id) => (await window.__NS.S.storage.listJobs(id)).filter((j) => j.type === 'continuity')[0].report.continuity.confirm.some((c) => c.status === 'ok'), wid), true, '“문제 없음” 표시가 저장된다');
  await page.getByRole('button', { name: '원고에서 보기' }).last().click(); await page.waitForSelector('#editor'); ok(true, '원고에서 보기: 집필 공간으로 이동');

  console.log('● 공모전 관리');
  await nav('공모전'); await page.waitForSelector('text=공모전 관리'); await clean('공모전');
  ok((await page.locator('main').textContent()).includes('공식 공고를 확인하지 않으므로'), '공식 공고를 확인하라는 경고');
  await page.getByRole('button', { name: '공모전 추가' }).click();
  await page.getByLabel('신문사·문학상 이름').fill('시험 신춘문예'); await page.getByLabel('모집 부문').fill('단편소설');
  await page.getByLabel('분량 단위').selectOption('chars_with'); await page.getByLabel('분량 상한(숫자, 선택)').fill('50');
  const dl = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10); await page.getByLabel('마감일').fill(dl);
  await page.getByLabel('표지에 쓸 연락처(응모 파일 표지용)').fill('시험 연락처');
  await page.getByRole('button', { name: '저장' }).click(); await page.waitForSelector('text=시험 신춘문예');
  ok(/D-[4-6]/.test(await page.locator('main').textContent()), 'D-day가 표시된다'); ok((await page.locator('main').textContent()).includes('AI 규정: 미확인'), 'AI 규정은 확인 전까지 “미확인”');
  await page.getByRole('button', { name: '응모 작품 추가' }).click(); await page.locator('.modal').getByLabel('작품').selectOption({ label: '고증 시험' }); await page.locator('.modal').getByRole('button', { name: '추가' }).click(); await page.waitForSelector('table.tbl');
  const row = await page.locator('table.tbl tbody tr').first().textContent();
  ok(row.includes('분량 초과'), '분량 기준을 넘으면 자동으로 알려 준다', row); ok(/신상 정보 의심 \d+곳/.test(row), '본문 속 연락처·필명을 신상 정보로 잡아낸다', row); ok(row.includes('미제출'), '제출 상태');
  await page.getByRole('button', { name: '제출본으로 잠금' }).click(); await wait(500);
  const sub = await S(async (id) => (await window.__NS.S.storage.listVersionMeta(id)).find((m) => m.kind === '제출본'), wid); ok(sub && sub.frozen && /시험 신춘문예/.test(sub.label), '제출본으로 잠그면 고정된 복사본이 생긴다(원본은 그대로)');
  eq(await S(async (id) => (await window.__NS.S.storage.listVersionMeta(id)).length, wid), 2, '원본 버전 + 제출본');
  await page.getByRole('button', { name: '응모 파일 내보내기' }).click(); await page.waitForSelector('.modal textarea');
  const body = await page.locator('.modal textarea').first().inputValue(); ok(!body.includes('고증 시험'), '본문 파일에는 작품 제목이 들어가지 않는다'); await page.locator('.modal').getByRole('button', { name: '닫기', exact: true }).last().click();
  await page.waitForSelector('.modal textarea'); const cover = await page.locator('.modal textarea').first().inputValue(); ok(cover.includes('제목: 고증 시험') && cover.includes('필명: 홍길동') && cover.includes('시험 연락처'), '표지 파일에 제목·필명·연락처가 따로 들어간다', cover); await page.locator('.modal').getByRole('button', { name: '닫기', exact: true }).last().click();
  await page.getByRole('button', { name: '제출함 표시' }).click(); await wait(300); ok((await page.locator('main').textContent()).includes('제출함 '), '제출함으로 표시');
  await page.reload(); await page.waitForSelector('.tbl'); await nav('공모전'); await page.waitForSelector('text=시험 신춘문예'); ok(true, '새로고침 후에도 공모전 기록이 남는다');

  console.log('● 콘솔 오류'); eq(errors, [], '콘솔 오류·예외 없음');
  await browser.close(); srv.close();
  console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`); if (fail) { console.log('실패:', failures); process.exit(1); }
})().catch((e) => { console.error('E2E 중단:', e); process.exit(2); });
