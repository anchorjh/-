const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const C = require('../src/core.js');
const D = require('../src/docx.js');

test('DOCX 내보내기 → 가져오기 왕복: 제목·문단·특수문자 보존', async () => {
  const ver = C.makeVersion({ workId: 'w', chapters: [C.newChapter('제1장', '첫 문단 & <기호>\n\n둘째 “대화”.'), C.newChapter('제2장', '셋째')] });
  const bytes = await D.buildDocx(JSZip, ver, '작품명');
  const paras = await D.readDocx(JSZip, bytes);
  assert.deepEqual(paras.map((p) => p.text), ['작품명', '제1장', '첫 문단 & <기호>', '', '둘째 “대화”.', '제2장', '셋째']);
  assert.deepEqual(paras.filter((p) => p.heading).map((p) => p.text), ['작품명', '제1장', '제2장']);
});
test('DOCX 구조: 필수 파트가 모두 있다', async () => {
  const bytes = await D.buildDocx(JSZip, C.makeVersion({ workId: 'w', chapters: [C.newChapter('a', 'b')] }), '');
  const z = await JSZip.loadAsync(bytes);
  for (const n of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels']) assert.ok(z.file(n), n);
});
test('HWPX 읽기(합성 파일): 섹션 순서대로', async () => {
  const z = new JSZip();
  z.file('Contents/section1.xml', '<hs:sec><hp:p><hp:run><hp:t>둘째 섹션</hp:t></hp:run></hp:p></hs:sec>');
  z.file('Contents/section0.xml', '<hs:sec><hp:p><hp:run><hp:t>첫 섹션</hp:t></hp:run></hp:p></hs:sec>');
  const paras = await D.readHwpx(JSZip, await z.generateAsync({ type: 'uint8array' }));
  assert.deepEqual(paras.map((p) => p.text), ['첫 섹션', '둘째 섹션']);
});
test('DOCX가 아닌 파일은 이해할 수 있는 오류를 낸다', async () => {
  const z = new JSZip(); z.file('a.txt', 'x');
  await assert.rejects(() => D.readDocx(JSZip, z.generateAsync({ type: 'uint8array' }).then((b) => b)), /word\/document\.xml/);
});
