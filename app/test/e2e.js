// 실제 Chromium 에서 1단계 점검 항목을 하나씩 확인한다.  실행: node test/e2e.js  (먼저 node build.js)
const fs = require('fs'), os = require('os'), path = require('path');
const { serve, newPage, chromium } = require('./e2e-helpers.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-e2e-'));
let pass = 0, fail = 0; const failures = [];
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; failures.push(name); console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, { actual: a, expected: b });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { srv, url } = await serve();
  const browser = await chromium.launch();
  let { ctx, page, errors } = await newPage(browser);
  const S = (fn, arg) => page.evaluate(fn, arg);
  const settle = async () => { await wait(1100); await page.waitForFunction(() => window.__NS.S.saveState === 'saved'); };
  const openFirst = async (title) => { await page.locator('.tbl .title', { hasText: title }).first().click(); await page.waitForSelector('#editor'); };
  const tab = (name) => page.locator('#tabs button', { hasText: name }).click();
  const getVer = (id) => S(async (i) => window.__NS.S.storage.getVersion(i), id);

  console.log('● 시작과 예시 작품');
  await page.goto(url); await page.waitForSelector('.tbl');
  eq(await page.locator('.tbl tbody tr').count(), 1, '예시 작품 1개가 보인다');
  ok(!/object HTML/.test(await page.locator('main').textContent()), '보관함에 [object HTML…] 같은 깨진 텍스트가 없다');

  console.log('● 새 작품 + 입력 + 글자 수');
  await page.getByRole('button', { name: '새 작품', exact: true }).click();
  await page.getByLabel('작품명').fill('테스트 작품'); await page.locator('.modal').getByRole('button', { name: '만들기', exact: true }).click();
  await page.waitForSelector('#editor');
  await page.click('#editor'); await page.keyboard.type('가나다 라마바.\n“안녕”', { delay: 5 });
  await wait(400);
  let sb = await page.locator('#statusbar').textContent();
  ok(/이 장 12자 \(공백 제외 11\)/.test(sb), '입력한 글자 수(공백 포함 12·제외 11)가 실시간 계산된다', sb);
  await settle();
  eq(await S(() => window.__NS.S.work.counts.withSpaces), 12, '작품 정보에 글자 수가 저장된다');

  console.log('● 새로고침 후 유지');
  await page.reload(); await page.waitForSelector('.tbl');
  ok(await page.locator('.tbl .title', { hasText: '테스트 작품' }).count() === 1, '새로고침 후에도 작품이 있다');
  await openFirst('테스트 작품');
  eq(await page.inputValue('#editor'), '가나다 라마바.\n“안녕”', '새로고침 후 원고 내용이 그대로다');

  console.log('● 원문 보존 (고정 버전은 고쳐지지 않고 분기)');
  await page.goto(url); await page.waitForSelector('.tbl'); await openFirst('[예시]');
  const before = await S(() => JSON.stringify(window.__NS.S.ver.chapters)); const verId = await S(() => window.__NS.S.ver.id);
  const origId = await S(() => window.__NS.S.ver.parentId);
  const origBefore = JSON.stringify((await getVer(origId)).chapters);
  await page.click('#editor'); await page.keyboard.press('Control+End'); await page.keyboard.type('추가한 문장.', { delay: 5 });
  await settle();
  const nowId = await S(() => window.__NS.S.ver.id);
  ok(nowId !== verId, '고정된 “1고”를 고치면 새 작업본으로 분기한다');
  eq(JSON.stringify((await getVer(verId)).chapters), before, '“1고” 내용은 한 글자도 바뀌지 않았다');
  eq(JSON.stringify((await getVer(origId)).chapters), origBefore, '“원문” 내용도 그대로다');
  ok((await getVer(nowId)).chapters[0].paragraphs.slice(-1)[0].text.endsWith('추가한 문장.'), '새 작업본에는 입력이 반영된다');
  eq((await getVer(nowId)).parentId, verId, '새 작업본의 부모는 “1고”다');

  console.log('● 단락 ID 유지 (수정해도 잠금·ID 유지)');
  const pid0 = await S(() => window.__NS.S.ver.chapters[0].paragraphs[0].id);
  await page.click('#editor'); await page.keyboard.press('Control+Home'); await page.keyboard.press('Control+Home');
  await wait(350); await tab('단락'); await wait(100); await page.getByLabel('이 단락 잠금').check(); await settle();
  await page.click('#editor'); await page.keyboard.press('Control+Home'); await page.keyboard.type('★', { delay: 5 }); await settle();
  eq(await S(() => window.__NS.S.ver.chapters[0].paragraphs[0].id), pid0, '단락 앞에 글자를 넣어도 같은 ID');
  eq(await S(() => window.__NS.S.ver.chapters[0].paragraphs[0].locked), true, '잠금 표시도 유지');

  console.log('● 한글 입력기(IME) 조합 중에는 모델을 건드리지 않음');
  {
    const cdp = await ctx.newCDPSession(page);
    await page.click('#editor'); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter');
    await wait(300);
    const lenBefore = await S(() => window.__NS.S.ver.chapters[0].paragraphs.length);
    await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
    await wait(400);
    const duringModel = await S(() => window.__NS.S.ver.chapters[0].paragraphs.slice(-1)[0].text);
    ok(duringModel === '', '조합 중인 글자는 아직 모델에 반영되지 않는다', duringModel);
    await cdp.send('Input.insertText', { text: '한글' });
    await wait(500);
    const afterModel = await S(() => window.__NS.S.ver.chapters[0].paragraphs.slice(-1)[0].text);
    eq(afterModel, '한글', '조합이 끝나면 반영된다');
    await settle();
  }

  console.log('● 장 추가·나누기·합치기·삭제·되돌리기');
  await page.getByRole('button', { name: '장 추가', exact: true }).click();
  eq(await page.locator('.chitem').count(), 4, '장 추가 → 4개');
  await page.getByRole('button', { name: '앞 장과 합치기' }).click();
  eq(await page.locator('.chitem').count(), 3, '앞 장과 합치기 → 3개');
  await page.getByRole('button', { name: /작업 되돌리기/ }).click();
  eq(await page.locator('.chitem').count(), 4, '작업 되돌리기 → 4개');
  await page.getByRole('button', { name: /작업 되돌리기/ }).click();
  eq(await page.locator('.chitem').count(), 3, '한 번 더 되돌리기 → 3개');
  await page.locator('.chitem').nth(1).click(); await page.click('#editor');
  await page.keyboard.press('Control+Home'); for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  const parasBefore = await S(() => window.__NS.S.ver.chapters[1].paragraphs.length);
  await page.getByRole('button', { name: '여기서 장 나누기' }).click();
  eq(await page.locator('.chitem').count(), 4, '장 나누기 → 4개');
  const pa = await S(() => window.__NS.S.ver.chapters[1].paragraphs.length + window.__NS.S.ver.chapters[2].paragraphs.length);
  eq(pa, parasBefore, '나눠도 단락 수 합계는 같다');
  await page.locator('.chitem').nth(3).click();
  await page.getByRole('button', { name: '장 삭제' }).click();
  ok(await page.locator('.modal').count() === 1, '장 삭제 전에 확인 창이 뜬다');
  await page.locator('.modal').getByRole('button', { name: '취소' }).click();
  eq(await page.locator('.chitem').count(), 4, '취소하면 삭제되지 않는다');
  await page.getByRole('button', { name: '장 삭제' }).click(); await page.locator('.modal').getByRole('button', { name: '장 삭제' }).click();
  eq(await page.locator('.chitem').count(), 3, '확인하면 삭제된다');
  await settle();

  console.log('● 찾기·바꾸기 (선택 적용, 잠금 제외, 되돌리기)');
  await tab('찾기·바꾸기');
  await page.getByLabel('찾을 말').fill('정숙'); await page.getByLabel('바꿀 말').fill('민정'); await page.getByRole('button', { name: '찾기', exact: true }).click();
  const total = await page.locator('.hit').count();
  ok(total >= 5, '작품 전체에서 일치를 찾는다 (' + total + '곳)');
  await page.locator('.hit input[type=checkbox]').first().uncheck();
  await page.getByRole('button', { name: /^선택한 \d+곳 바꾸기/ }).click(); await wait(200);
  const cnt = await S(() => { const t = window.__NS.C.versionText(window.__NS.S.ver); return { jung: (t.match(/정숙/g) || []).length, min: (t.match(/민정/g) || []).length }; });
  eq(cnt.jung, 1, '선택 해제한 1곳은 그대로 남는다'); eq(cnt.min, total - 1, '나머지는 바뀐다');
  await page.getByRole('button', { name: /작업 되돌리기/ }).click(); await wait(200);
  eq(await S(() => (window.__NS.C.versionText(window.__NS.S.ver).match(/정숙/g) || []).length), total, '되돌리기로 전부 복구');
  await settle();

  console.log('● 버전 고정 → 편집 → 비교');
  await tab('버전');
  await page.locator('select[aria-label="버전 종류"]').selectOption('2고'); await page.getByLabel('버전 이름').fill('둘째 고침');
  await page.getByRole('button', { name: '버전 고정' }).click(); await wait(600);
  eq(await S(() => window.__NS.S.ver.frozen), true, '현재 상태가 “2고”로 고정된다');
  await page.click('#editor'); await page.keyboard.press('Control+Home'); await page.keyboard.type('바뀐 첫머리 ', { delay: 5 }); await settle();
  ok(await S(() => window.__NS.S.ver.frozen === false), '고친 뒤에는 새 작업본(편집 가능)');
  await page.locator('nav button', { hasText: '버전 비교' }).click(); await page.waitForSelector('.diff');
  const sum = await page.locator('.pill').allTextContents();
  ok(sum.some((t) => /수정 1\b/.test(t)), '비교: 수정 1개 표시', sum);
  ok(await page.locator('.diff .i').count() >= 1, '비교: 추가된 글자가 강조된다');

  console.log('● 파일 가져오기 (UTF-8 TXT, EUC-KR TXT, DOCX) 와 장 인식');
  const txt = '제1장 시작\n\n첫 문단입니다.\n두 번째 문단입니다.\n\n제2장 끝\n\n마지막 문단.\n';
  fs.writeFileSync(path.join(TMP, 'a.txt'), txt);
  await page.locator('nav button', { hasText: '작품 보관함' }).click();
  let fc = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '파일로 새 작품 만들기' }).click(); await (await fc).setFiles(path.join(TMP, 'a.txt'));
  await page.waitForSelector('.modal');
  ok(/장 2개/.test(await page.locator('.modal').textContent()), '장 제목(제N장)을 인식해 2개로 나눈다');
  await page.locator('.modal').getByRole('button', { name: '새 작품으로 만들기' }).click(); await page.waitForSelector('#editor');
  eq(await S(() => window.__NS.S.ver.label), '원문', '가져온 내용은 “원문”');
  eq(await S(() => window.__NS.S.ver.frozen), true, '원문은 고정 상태');
  eq(await S(() => window.__NS.S.ver.chapters.map((c) => c.title)), ['제1장 시작', '제2장 끝'], '장 제목이 제목으로 들어간다');
  // EUC-KR 바이트
  fs.writeFileSync(path.join(TMP, 'euc.txt'), Buffer.from([0xB0, 0xA1, 0xB3, 0xAA, 0xB4, 0xD9, 0x0A, 0xB6, 0xF3, 0xB8, 0xB6]));
  await page.locator('nav button', { hasText: '작품 보관함' }).click();
  fc = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '파일로 새 작품 만들기' }).click(); await (await fc).setFiles(path.join(TMP, 'euc.txt'));
  await page.waitForSelector('.modal');
  ok(/EUC-KR/.test(await page.locator('.modal').textContent()), 'EUC-KR 인코딩을 자동 판별한다');
  await page.locator('.modal').getByRole('button', { name: '새 작품으로 만들기' }).click(); await page.waitForSelector('#editor');
  eq(await page.inputValue('#editor'), '가나다\n라마', 'EUC-KR 텍스트가 깨지지 않고 읽힌다');
  // DOCX: 앱에서 내보낸 뒤 다시 가져오기
  console.log('● 내보내기 (TXT·MD·DOCX·JSON) 와 DOCX 왕복');
  await page.locator('nav button', { hasText: '작품 보관함' }).click(); await openFirst('[예시]');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  let dl = page.waitForEvent('download'); await page.locator('.modal').getByRole('button', { name: '내보내기' }).click(); let d = await dl;
  const txtOut = fs.readFileSync(await d.path(), 'utf8'); ok(/^\[예시\] 새벽 시장\n\n제1장 새벽 시장\n\n/.test(txtOut) && txtOut.endsWith('\n'), 'TXT 내보내기 형식', txtOut.slice(0, 40));
  await page.getByRole('button', { name: '내보내기', exact: true }).click(); await page.locator('.modal input[value=md]').check();
  dl = page.waitForEvent('download'); await page.locator('.modal').getByRole('button', { name: '내보내기' }).click(); d = await dl;
  ok(/^# \[예시\] 새벽 시장\n\n## 제1장/.test(fs.readFileSync(await d.path(), 'utf8')), 'Markdown 내보내기 형식');
  await page.getByRole('button', { name: '내보내기', exact: true }).click(); await page.locator('.modal input[value=docx]').check();
  dl = page.waitForEvent('download'); await page.locator('.modal').getByRole('button', { name: '내보내기' }).click(); d = await dl;
  const docxPath = path.join(TMP, 'out.docx'); fs.copyFileSync(await d.path(), docxPath);
  await page.locator('nav button', { hasText: '작품 보관함' }).click();
  fc = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '파일로 새 작품 만들기' }).click(); await (await fc).setFiles(docxPath);
  await page.waitForSelector('.modal');
  ok(/장 4개|장 3개/.test(await page.locator('.modal').textContent()), 'DOCX를 다시 읽으면 장이 인식된다', await page.locator('.modal').textContent());
  await page.locator('.modal').getByRole('button', { name: '취소' }).click();

  console.log('● JSON 백업 → 삭제 → 복원');
  await page.locator('nav button', { hasText: '설정·백업' }).click();
  dl = page.waitForEvent('download'); await page.getByRole('button', { name: '전체 백업 내려받기' }).click(); d = await dl;
  const bkPath = path.join(TMP, 'backup.json'); fs.copyFileSync(await d.path(), bkPath);
  const bk = JSON.parse(fs.readFileSync(bkPath, 'utf8'));
  ok(bk.app === '소설 작업실' && bk.works.length >= 3 && bk.versions.length >= 6, '백업 파일에 모든 작품·버전이 들어 있다', { works: bk.works.length, versions: bk.versions.length });
  await page.locator('nav button', { hasText: '작품 보관함' }).click();
  ok(!(await page.locator('.banner', { hasText: '아직 백업한 적이 없습니다' }).count()), '백업 후에는 백업 경고가 사라진다');
  const nWorks = await page.locator('.tbl tbody tr').count();
  // 모든 작품 삭제(재확인 필요)
  const names = await page.locator('.tbl .title').allTextContents();
  for (const nm of names) {
    await page.locator('.tbl tr', { hasText: nm }).first().getByRole('button', { name: '삭제' }).click();
    const input = page.locator('.modal input[type=text]');
    ok(await page.locator('.modal').getByRole('button', { name: '영구 삭제' }).isDisabled(), '삭제 확인은 작품명을 입력해야 활성화된다 (' + nm + ')');
    await input.fill(nm); await page.locator('.modal').getByRole('button', { name: '영구 삭제' }).click(); await wait(200);
  }
  eq(await page.locator('.tbl tbody tr').count(), 0, '전부 삭제됨');
  fc = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '백업 불러오기' }).click(); await (await fc).setFiles(bkPath);
  await page.waitForSelector('.modal'); await page.locator('.modal').getByRole('button', { name: '불러오기' }).click(); await wait(400);
  eq(await page.locator('.tbl tbody tr').count(), nWorks, '백업에서 모든 작품이 복원된다');
  await openFirst('[예시]');
  eq(await S(async () => (await window.__NS.S.storage.listVersionMeta(window.__NS.S.work.id)).map((m) => m.label).sort()), ['1고', '둘째 고침', '원문', '작업본 1'].sort(), '복원된 작품의 버전 4개(원문·1고·둘째 고침·작업본)가 모두 있다');
  // 같은 백업을 한 번 더 → 복사본
  await page.locator('nav button', { hasText: '작품 보관함' }).click();
  fc = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '백업 불러오기' }).click(); await (await fc).setFiles(bkPath);
  await page.waitForSelector('.modal'); await page.locator('.modal').getByRole('button', { name: '불러오기' }).click(); await wait(400);
  eq(await page.locator('.tbl tbody tr').count(), nWorks * 2, '겹치는 백업은 덮어쓰지 않고 “(가져옴)” 복사본으로 추가');

  console.log('● 원고지 설정, 문체 통계');
  await openFirst('[예시]');
  await page.locator('nav button', { hasText: '설정·백업' }).click();
  await page.getByText('원고지 모사: 문단마다').click(); await wait(300);
  ok(/원고지 모사/.test(await page.locator('.kv').first().textContent()), '계산 방식을 모사로 바꾸면 기준 표시가 바뀐다');
  await page.locator('nav button', { hasText: '문체 통계' }).click(); await page.waitForSelector('.bars');
  ok(await page.locator('h2', { hasText: '문장 길이 분포' }).count() === 1, '문체 통계가 계산된다');
  ok(await page.locator('h2', { hasText: '응모 전 점검' }).count() === 1, '신상 정보 점검 카드가 있다');

  console.log('● 콘솔 오류');
  eq(errors, [], '콘솔 오류·예외 없음');

  console.log('● 저장소를 못 쓰는 환경(메모리) 경고');
  {
    const p2 = await newPage(browser);
    await p2.ctx.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { value: undefined }); });
    await p2.page.goto(url); await p2.page.waitForSelector('.tbl');
    ok(/모든 원고가 사라집니다/.test(await p2.page.locator('#storagebanner').textContent()), 'IndexedDB가 없으면 영구 저장이 안 된다는 경고가 뜬다');
    await p2.ctx.close();
  }

  await browser.close(); srv.close();
  console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`); if (fail) { console.log('실패:', failures); process.exit(1); }
})().catch((e) => { console.error('E2E 중단:', e); process.exit(2); });
