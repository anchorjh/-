const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');

/* ── 글자 수 ── */
test('빈 문서·공백만·줄바꿈만', () => {
  assert.equal(C.countWithSpaces(''), 0);
  assert.equal(C.countNoSpaces(''), 0);
  assert.equal(C.countWithSpaces('   '), 3);
  assert.equal(C.countNoSpaces('   '), 0);
  assert.equal(C.countWithSpaces('\n\n\r\n'), 0);
  assert.equal(C.countNoSpaces('\n\n\r\n'), 0);
});
test('한글·영문·숫자·문장부호 혼합', () => {
  const t = '가나 다라.\nABC 123!';
  assert.equal(C.countWithSpaces(t), 14); // 줄바꿈 1자 제외
  assert.equal(C.countNoSpaces(t), 12);
});
test('전각 공백·탭·폭 없는 공백은 공백 제외에서 빠진다', () => {
  assert.equal(C.countNoSpaces('가　나\t다​라'), 4);
  assert.equal(C.countWithSpaces('가　나\t다'), 5);
});
test('이모지는 1자', () => {
  assert.equal(C.countWithSpaces('가😀나'), 3);
  assert.equal(C.countNoSpaces('😀😀'), 2);
});
test('단순 환산', () => {
  assert.equal(C.simpleSheets(200, {}), 1);
  assert.equal(C.simpleSheets(1000, {}), 5);
  assert.equal(C.simpleSheets(330, {}), 1.7);
  assert.equal(C.simpleSheets(300, { cellsPerLine: 25, linesPerSheet: 12 }), 1);
});
test('원고지 모사: 문단 첫 칸 비움, 20칸 줄바꿈', () => {
  // 첫 칸 비움 → 한 줄에 19자. 19자 = 1줄, 20자 = 2줄
  const a = '가'.repeat(19), b = '가'.repeat(20);
  assert.equal(C.gridSheets(a).lines, 1);
  assert.equal(C.gridSheets(b).lines, 2);
  assert.equal(C.gridSheets(b, { indent: false }).lines, 1);
});
test('원고지 모사: 문단마다 줄, 빈 줄은 줄을 쓰지 않음, 대화도 한 줄', () => {
  const t = '가나다.\n\n“안녕.”\n라마바.';
  const g = C.gridSheets(t);
  assert.equal(g.lines, 3);
  assert.equal(g.sheets, 0.3);
  assert.equal(g.sheetsCeil, 1);
});
test('원고지 모사: 줄 끝 띄어쓰기 생략, 줄머리 문장부호는 앞줄에 붙임', () => {
  // 첫 칸 비움 + 가×18 = 19칸, 공백이 20번째 칸 → 줄 끝 공백은 다음 줄로 넘기지 않음
  const t = '가'.repeat(18) + ' 나';
  const g = C.gridSheets(t);
  assert.equal(g.lines, 2);
  // 줄머리 금지: 19칸 + 가 = 20칸, 다음 '.'은 앞줄 마지막 칸에 붙어 줄이 늘지 않음
  assert.equal(C.gridSheets('가'.repeat(19) + '.').lines, 1);
  assert.equal(C.gridSheets('가'.repeat(20) + '.').lines, 2);
});
test('원고지 모사: 숫자와 영소문자는 한 칸에 두 자', () => {
  assert.equal(C.gridSheets('1234567890123456789012345678901234567', { indent: false }).lines, 1); // 37자 → 19칸
  assert.equal(C.gridSheets('가'.repeat(40), { indent: false }).lines, 2);
});
test('countText는 선택한 방식의 매수를 돌려준다', () => {
  const t = '가'.repeat(400);
  assert.equal(C.countText(t, { mode: 'simple' }).sheets, 2);
  assert.equal(C.countText(t, { mode: 'simple', basis: 'without' }).sheets, 2);
  assert.equal(C.countText(t, { mode: 'grid' }).sheets, 2.1); // 첫 줄 19자 + 나머지 381자/20 → 21줄
});

/* ── 단락 ID 보존 ── */
const mk = (txt) => C.newChapter('t', txt).paragraphs;
test('reconcile: 변경 없음은 같은 ID', () => {
  const o = mk('a\nb\nc');
  const n = C.reconcileParagraphs(o, 'a\nb\nc');
  assert.deepEqual(n.map((p) => p.id), o.map((p) => p.id));
});
test('reconcile: 한 단락 수정해도 ID·잠금·메모 유지', () => {
  const o = mk('첫째\n둘째\n셋째'); o[1].locked = true; o[1].memo = '메모';
  const n = C.reconcileParagraphs(o, '첫째\n둘째 고침\n셋째');
  assert.equal(n[1].id, o[1].id); assert.equal(n[1].text, '둘째 고침'); assert.equal(n[1].locked, true); assert.equal(n[1].memo, '메모');
  assert.equal(n[0].id, o[0].id); assert.equal(n[2].id, o[2].id);
});
test('reconcile: 중간 삽입은 새 ID, 나머지 ID 유지', () => {
  const o = mk('a\nb\nc');
  const n = C.reconcileParagraphs(o, 'a\nX\nb\nc');
  assert.equal(n.length, 4);
  assert.equal(n[0].id, o[0].id); assert.equal(n[2].id, o[1].id); assert.equal(n[3].id, o[2].id);
  assert.ok(!o.some((p) => p.id === n[1].id));
});
test('reconcile: 삭제하면 해당 ID가 사라지고 나머지 유지', () => {
  const o = mk('a\nb\nc\nd');
  const n = C.reconcileParagraphs(o, 'a\nd');
  assert.deepEqual(n.map((p) => p.id), [o[0].id, o[3].id]);
});
test('reconcile: 단락 나누기(엔터)·합치기', () => {
  const o = mk('안녕하세요 반갑습니다\nz');
  const split = C.reconcileParagraphs(o, '안녕하세요\n반갑습니다\nz');
  assert.equal(split.length, 3); assert.equal(split[0].id, o[0].id); assert.equal(split[2].id, o[1].id);
  const merged = C.reconcileParagraphs(split, '안녕하세요 반갑습니다\nz');
  assert.equal(merged.length, 2); assert.equal(merged[1].id, o[1].id);
});
test('reconcile: 빈 문서와 전체 교체', () => {
  assert.equal(C.reconcileParagraphs([], '').length, 1);
  const o = mk('a\nb');
  const n = C.reconcileParagraphs(o, '');
  assert.equal(n.length, 1); assert.equal(n[0].text, '');
});
test('reconcile: 큰 문서에서도 빠르다', () => {
  const lines = Array.from({ length: 6000 }, (_, i) => '문단 ' + i);
  const o = mk(lines.join('\n'));
  lines[4000] = '고친 문단'; lines.splice(100, 1); // 중간 구간이 커서 patience 경로를 탄다
  const t0 = Date.now();
  const n = C.reconcileParagraphs(o, lines.join('\n'));
  assert.ok(Date.now() - t0 < 1500, '느림: ' + (Date.now() - t0));
  assert.equal(n.length, 5999);
  assert.equal(n[3999].id, o[4000].id); assert.equal(n[3999].text, '고친 문단');
  assert.equal(n[5000].id, o[5001].id);
  assert.equal(n[99].id, o[99].id); assert.equal(n[100].id, o[101].id);
});

/* ── 버전·비교 ── */
function ver(chapters) { return C.makeVersion({ workId: 'w', chapters }); }
test('버전 복제는 단락 ID를 유지하고 원본과 독립적이다', () => {
  const a = ver([C.newChapter('1', 'x\ny')]);
  const b = ver(C.cloneChapters(a.chapters));
  assert.equal(b.chapters[0].paragraphs[0].id, a.chapters[0].paragraphs[0].id);
  b.chapters[0].paragraphs[0].text = '바뀜';
  assert.equal(a.chapters[0].paragraphs[0].text, 'x');
});
test('diffVersions: same/mod/add/del', () => {
  const a = ver([C.newChapter('1', 'a\nb\nc\nd')]);
  const b = ver(C.cloneChapters(a.chapters));
  b.chapters[0].paragraphs[1].text = 'B!';
  b.chapters[0].paragraphs.splice(2, 1);
  b.chapters[0].paragraphs.push(C.newParagraph('new'));
  const d = C.diffVersions(a, b);
  assert.deepEqual(d.summary, { same: 2, mod: 1, add: 1, del: 1 });
  assert.equal(d.byText, false);
});
test('diffVersions: ID가 달라도 본문이 같으면 텍스트로 대응', () => {
  const a = ver([C.newChapter('1', 'a\nb\nc')]);
  const b = ver([C.newChapter('1', 'a\nb\nc\nd')]);
  const d = C.diffVersions(a, b);
  assert.equal(d.byText, true);
  assert.deepEqual(d.summary, { same: 3, mod: 0, add: 1, del: 0 });
});
test('inlineDiff: 조사만 바뀌면 그 글자만 표시', () => {
  const s = C.inlineDiff('그는 학교에 갔다', '그는 학교를 갔다');
  assert.deepEqual(s.filter((x) => x.t !== 'eq').map((x) => [x.t, x.s]), [['del', '에'], ['ins', '를']]);
  assert.equal(s.filter((x) => x.t !== 'ins').map((x) => x.s).join(''), '그는 학교에 갔다');
  assert.equal(s.filter((x) => x.t !== 'del').map((x) => x.s).join(''), '그는 학교를 갔다');
});

/* ── 찾기·바꾸기 ── */
test('findAll/replaceMatches: 선택한 일치만 바꾼다, 같은 단락 여러 개도 정확', () => {
  const v = ver([C.newChapter('1', '철수가 갔다. 철수는 철수다.\n영희'), C.newChapter('2', '철수')]);
  const m = C.findAll(v, '철수');
  assert.equal(m.length, 4);
  const n = C.replaceMatches(v, [m[0], m[2], m[3]], '민수');
  assert.equal(n, 3);
  assert.equal(v.chapters[0].paragraphs[0].text, '민수가 갔다. 철수는 민수다.');
  assert.equal(v.chapters[1].paragraphs[0].text, '민수');
});
test('findAll: 대소문자 옵션, 특수문자 이스케이프', () => {
  const v = ver([C.newChapter('1', 'a.b A.B')]);
  assert.equal(C.findAll(v, 'a.b').length, 2);
  assert.equal(C.findAll(v, 'a.b', { caseSensitive: true }).length, 1);
  assert.equal(C.findAll(v, '').length, 0);
});

/* ── 정리 ── */
test('cleanText: 특수 공백, 따옴표, 말줄임표, 빈 줄, 줄 끝 공백', () => {
  const r = C.cleanText('가　나  \n\n\n\n"안녕" ...​', { quotes: 'curly', ellipsis: 'char', blankLines: 'collapse' });
  assert.equal(r.text, '가 나\n\n“안녕” …');
  assert.ok(r.changed);
});
test('cleanText: NFD 한글을 NFC로', () => {
  const nfd = '가'.normalize('NFD');
  assert.notEqual(nfd.length, 1);
  assert.equal(C.cleanText(nfd).text.length, 1);
});
test('cleanText: 옵션을 끄면 건드리지 않는다', () => {
  const t = 'a　b';
  assert.equal(C.cleanText(t, { specialSpaces: false, nfc: false, trailing: false }).text, t);
});

/* ── 장 나누기 ── */
test('splitChapters: 제N장·마크다운 제목 인식, 제목 없으면 본문 1개', () => {
  const r = C.splitChapters(['제1장 시작', '본문1', '', '## 둘째', '본문2']);
  assert.deepEqual(r.map((c) => c.title), ['제1장 시작', '둘째']);
  assert.equal(r[0].text, '본문1');
  const r2 = C.splitChapters(['그냥', '글']);
  assert.equal(r2.length, 1); assert.equal(r2[0].title, '본문');
});
test('splitChapters: 제목 앞 본문은 첫 장에 담기고, Word 제목 스타일을 따른다', () => {
  const r = C.splitChapters([{ text: '서두' }, { text: '제목A', heading: true }, { text: '내용' }]);
  assert.deepEqual(r.map((c) => c.title), ['본문', '제목A']);
});

/* ── 내보내기 ── */
test('toTxt / toMarkdown', () => {
  const v = ver([C.newChapter('1장', '가\n***\n나'), C.newChapter('2장', '다')]);
  assert.equal(C.toTxt(v, { workTitle: '작품' }), '작품\n\n1장\n\n가\n***\n나\n\n2장\n\n다\n');
  assert.equal(C.toMarkdown(v, { workTitle: '작품' }), '# 작품\n\n## 1장\n\n가\n\n***\n\n나\n\n## 2장\n\n다\n');
});

/* ── 신상 정보 ── */
test('privacyScan: 전화, 이메일, 등록 이름', () => {
  const v = ver([C.newChapter('1', '연락은 010-1234-5678 또는 a.b@c.com\n홍길동이 말했다')]);
  const r = C.privacyScan(v, ['홍길동']);
  assert.deepEqual(r.map((x) => x.label).sort(), ['등록한 이름 "홍길동"', '이메일', '휴대전화 번호'].sort());
});

/* ── 문체 통계 ── */
test('styleStats: 짧은 문장 연속, 문답식 대사, 대화 비율, 근접 반복, 사용자 표현', () => {
  const body = [
    '그는 갔다. 나는 봤다. 비가 왔다. 문이 닫혔다. 아무도 없었다.',
    '“어디 가요?”', '“집에.”', '“왜요?”', '“그냥.”', '“언제요?”', '“몰라.”',
    '그는 서류를 서류함에 넣고 서류를 다시 꺼내 서류의 모서리를 맞췄다. 마치 아무 일도 없었던 것이다.',
  ].join('\n');
  const v = ver([C.newChapter('1', body)]);
  const s = C.styleStats(v, { names: ['그는', '나는'] });
  assert.ok(s.shortRuns.length >= 1 && s.shortRuns[0].count >= 4);
  assert.ok(s.dialogRuns.length === 1 && s.dialogRuns[0].count === 6);
  assert.ok(s.dialogRatio > 0.05 && s.dialogRatio < 0.6);
  assert.ok(s.nearRepeats.some((x) => x.word === '서류' && x.count >= 3));
  assert.equal(s.custom['마치'].count, 1);
  assert.equal(s.custom['것이다'].count, 1);
  assert.equal(s.chapters[0].nameCounts['그는'], 2);
});
test('styleStats: 빈 원고도 오류 없이', () => {
  const s = C.styleStats(ver([C.newChapter('', '')]));
  assert.equal(s.sentenceCount, 0); assert.equal(s.dialogRatio, 0);
});

/* ── 백업 ── */
test('백업 → 검증 → 가져오기 계획 (ID 충돌 시 복사본)', () => {
  const w = { id: 'w1', title: '작품', currentVersionId: 'v2' };
  const v1 = Object.assign(ver([C.newChapter('1', 'x')]), { id: 'v1', workId: 'w1' });
  const v2 = Object.assign(ver([C.newChapter('1', 'y')]), { id: 'v2', workId: 'w1', parentId: 'v1' });
  const b = JSON.parse(JSON.stringify(C.makeBackup([w], [v1, v2], {})));
  assert.deepEqual(C.validateBackup(b), []);
  const fresh = C.planImport(b, [], []);
  assert.equal(fresh.works[0].id, 'w1'); assert.equal(fresh.renamed.length, 0);
  const clash = C.planImport(b, ['w1'], ['v1', 'v2']);
  assert.notEqual(clash.works[0].id, 'w1');
  assert.equal(clash.works[0].title, '작품 (가져옴)');
  const nv = clash.versions.find((v) => v.parentId);
  assert.ok(clash.versions.some((v) => v.id === nv.parentId));
  assert.equal(clash.works[0].currentVersionId, nv.id);
  assert.ok(clash.versions.every((v) => v.workId === clash.works[0].id));
});
test('validateBackup: 잘못된 파일을 거른다', () => {
  assert.ok(C.validateBackup(null).length);
  assert.ok(C.validateBackup({ app: 'x' }).length);
  assert.ok(C.validateBackup({ app: '소설 작업실', schema: 1, works: [{ id: 'a', title: 't' }], versions: [{ id: 'v', workId: 'zzz', chapters: [] }] }).length);
});

/* ── 파일 해석 ── */
test('docxXmlToParas: 문단, 제목, 엔티티, 줄바꿈', () => {
  const xml = '<w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>제목</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">가 &amp; 나 </w:t></w:r><w:r><w:t>다</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>둘째줄</w:t></w:r></w:p><w:p/></w:body>';
  const r = C.docxXmlToParas(xml);
  assert.deepEqual(r.map((x) => [x.text, x.heading]), [['제목', true], ['가 & 나 다', false], ['둘째줄', false]]);
});
test('hwpxXmlToParas: 문단과 글자 추출', () => {
  const xml = '<hs:sec><hp:p id="1"><hp:run><hp:t>첫 문단</hp:t></hp:run></hp:p><hp:p id="2"><hp:run><hp:t>둘째 &lt;문단&gt;</hp:t></hp:run></hp:p></hs:sec>';
  assert.deepEqual(C.hwpxXmlToParas(xml).map((x) => x.text), ['첫 문단', '둘째 <문단>']);
});
test('decodeBytes: UTF-8, BOM, EUC-KR 자동 판별', () => {
  assert.equal(C.decodeBytes(new TextEncoder().encode('가나다')).text, '가나다');
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode('가')]);
  assert.equal(C.decodeBytes(bom.buffer).text, '가');
  const euc = new Uint8Array([0xB0, 0xA1, 0xB3, 0xAA]); // 가나
  const r = C.decodeBytes(euc.buffer);
  assert.equal(r.text, '가나'); assert.match(r.encoding, /EUC-KR/);
});

test('aggregateCounts: 장별 합산이 전체 계산과 같다', () => {
  const chs = ['가나다 라마.\n\n“대화.”', '숫자 12345 abc.\n마지막 줄', ''].map((x) => C.countText(x, { mode: 'grid' }));
  const whole = C.countText('가나다 라마.\n\n“대화.”\n숫자 12345 abc.\n마지막 줄', { mode: 'grid' });
  const agg = C.aggregateCounts(chs, { mode: 'grid' });
  assert.equal(agg.withSpaces, whole.withSpaces);
  assert.equal(agg.noSpaces, whole.noSpaces);
  assert.equal(agg.grid.lines, whole.grid.lines);
  assert.equal(agg.sheets, whole.sheets);
});

test('styleFingerprint: 로컬 통계 한 줄', () => {
  const f = C.styleFingerprint('그는 갔다. 나는 봤다.\n“어디 가요?” 하고 물었다. 비가 많이 왔다.');
  assert.match(f.text, /문장 평균 .*대화 비율 \d+%/); assert.ok(f.stats.sentences >= 3);
  assert.equal(C.styleFingerprint('').text, '');
});

/* ── 제안 검증·적용 ── */
const chOf = (lines) => ({ paragraphs: lines.map((x) => C.newParagraph(x)) });
test('verifyEdits: 원문이 정확히 한 번만 나와야 통과, 잠금·겹침·여러 단락·늘림 금지', () => {
  const ch = chOf(['그는 문을 열었다. 그것은 슬픔이었다.', '잠금 문단입니다. 그대로 두었다.', '또 한 번 그대로 두었다. 그리고 갔다.']); ch.paragraphs[1].locked = true;
  const r = C.verifyEdits([
    { old: '그것은 슬픔이었다.', new: '', why: '해설' },                    // ok (삭제)
    { old: '없는 문장', new: 'x', why: 'a' },                                // 못 찾음
    { old: '그대로 두었다', new: '두었다', why: 'a' },                       // 잠금 단락 + 다른 단락에도 → 여러 번
    { old: '그리고 갔다.', new: '그리고 갔다. 아주 길게 덧붙인 문장이 이어졌다.', why: 'a' }, // 늘림
    { old: '또 한 번 그대로 두었다.', new: '또 한 번 두었다.', why: '주저' },  // ok? '그대로 두었다' 포함이지만 old 전체는 한 번
    { old: '그는 문을 열었다. 그것은', new: '그는', why: '겹침' },            // 첫 편집과 겹침
    { old: 'a\nb', new: 'c', why: 'x' },
    { old: '문을 열었다', new: '문을 열었다', why: 'x' },
  ], ch, { pass: '해설', shorten: true });
  assert.deepEqual(r.ok.map((e) => e.old), ['그것은 슬픔이었다.', '또 한 번 그대로 두었다.']);
  const reasons = r.rejected.map((x) => x.reason);
  assert.ok(reasons.includes('원고에서 찾을 수 없음') && reasons.includes('이 패스는 문장을 늘릴 수 없음') && reasons.includes('다른 제안과 겹침') && reasons.includes('여러 단락에 걸침') && reasons.includes('바뀐 것이 없음'), reasons.join('|'));
});
test('verifyEdits: 잠금 단락 안의 제안은 거절, 여러 번 나오는 문자열은 모호함으로 거절', () => {
  const ch = chOf(['같은 말. 같은 말.', '잠금 안의 문장.']); ch.paragraphs[1].locked = true;
  const r = C.verifyEdits([{ old: '같은 말.', new: '', why: 'a' }, { old: '잠금 안의 문장.', new: '', why: 'a' }], ch, {});
  assert.deepEqual(r.rejected.map((x) => x.reason), ['원고에 여러 번 나옴(앞뒤 글자를 늘려야 함)', '잠금 단락']);
});
test('verifyEdits: 최대 곳수, 이전에 거절한 제안, 새 낱말·비유 경고', () => {
  const ch = chOf(['가나다 라마바.', '사아자 차카타.', '파하 거너더.']);
  const mk = (i) => ({ old: ['가나다 라마바.', '사아자 차카타.', '파하 거너더.'][i], new: '', why: 'a' });
  const r = C.verifyEdits([mk(0), mk(1), mk(2)], ch, { maxEdits: 2 }); assert.equal(r.ok.length, 2); assert.equal(r.rejected[0].reason, '한 패스 최대 2곳 초과');
  const rk = C.verifyEdits([mk(0)], ch, { rejectedKeys: new Set([C.editKey('가나다 라마바.', '')]) }); assert.equal(rk.rejected[0].reason, '이전에 거절한 제안');
  const w = C.verifyEdits([{ old: '가나다 라마바.', new: '푸르디푸른 하늘처럼 아득한 바다', why: 'a' }], ch, { words: new Set(['가나다']) });
  assert.ok(w.ok[0].warnings.some((x) => /원고에 없던 낱말/.test(x)) && w.ok[0].warnings.includes('비유가 늘어남'));
});
test('verifyQuotes: 원고에 없는 인용은 버린다', () => {
  const r = C.verifyQuotes([{ quote: '있는 문장' }, { quote: '지어낸 문장' }, { quote: '' }], '여기 있는 문장이 있다');
  assert.equal(r.ok.length, 1); assert.equal(r.dropped.length, 2);
});
test('applyProposals: 원본 불변, 같은 단락 여러 곳 정확, 위치가 어긋나면 한 번만 나올 때 찾아서 적용, 잠금 거부', () => {
  const ver = C.makeVersion({ workId: 'w', chapters: [C.newChapter('1', '하나 둘 셋 넷.\n다섯 여섯.\n잠금 일곱.')] }); ver.chapters[0].paragraphs[2].locked = true;
  const before = JSON.stringify(ver.chapters); const P0 = ver.chapters[0].paragraphs;
  const r = C.applyProposals(ver, [
    { paraId: P0[0].id, start: 0, end: 2, old: '하나', new: '1' }, { paraId: P0[0].id, start: 6, end: 8, old: '셋', new: '3' },
    { paraId: P0[1].id, start: 99, end: 101, old: '여섯', new: '6' },   // 위치 틀림 → 한 번만 나오므로 찾아 적용
    { paraId: P0[2].id, start: 3, end: 5, old: '일곱', new: '7' },      // 잠금
    { paraId: P0[1].id, start: 0, end: 2, old: '없음', new: 'x' },      // 못 찾음
  ]);
  assert.equal(JSON.stringify(ver.chapters), before, '원본 불변');
  assert.equal(r.chapters[0].paragraphs[0].text, '1 둘 3 넷.'); assert.equal(r.chapters[0].paragraphs[1].text, '다섯 6.');
  assert.equal(r.applied, 3); assert.deepEqual(r.failed.map((f) => f.reason).sort(), ['원문이 바뀌어 위치를 찾지 못함', '잠금 단락']);
  assert.equal(r.chapters[0].paragraphs[0].source, 'ai-edit'); assert.equal(r.chapters[0].paragraphs[0].id, P0[0].id);
});
test('aiShare: AI 글자 비율', () => {
  const v = C.makeVersion({ workId: 'w', chapters: [C.newChapter('1', '가나다라\n마바사아')] }); v.chapters[0].paragraphs[1].source = 'ai';
  assert.equal(C.aiShare(v), 0.5);
});
