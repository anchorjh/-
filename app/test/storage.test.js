const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/storage.js');
const C = require('../src/core.js');

test('메모리 저장소: 작품·버전 저장, 메타 목록, 작품 삭제 시 버전도 삭제', async () => {
  const st = S.createMemoryStorage();
  assert.equal(st.persistent, false);
  const w = { id: 'w1', title: 'T' };
  await st.putWork(w);
  const v = C.makeVersion({ workId: 'w1', chapters: [C.newChapter('1', 'x')] });
  await st.putVersion(v);
  const metas = await st.listVersionMeta('w1');
  assert.equal(metas.length, 1); assert.equal(metas[0].chapters, undefined);
  // 저장된 값은 복사본이어야 한다(저장 후 원본을 바꿔도 저장물이 변하지 않음)
  v.chapters[0].paragraphs[0].text = 'changed';
  assert.equal((await st.getVersion(v.id)).chapters[0].paragraphs[0].text, 'x');
  await st.deleteWork('w1');
  assert.equal((await st.listWorks()).length, 0);
  assert.equal(await st.getVersion(v.id), undefined);
});
test('exportAll → 검증 → importAll 왕복', async () => {
  const a = S.createMemoryStorage();
  await a.putWork({ id: 'w1', title: 'T', currentVersionId: 'v1' });
  const v = Object.assign(C.makeVersion({ workId: 'w1', chapters: [C.newChapter('1', 'x\ny')] }), { id: 'v1' });
  await a.putVersion(v);
  const b = JSON.parse(JSON.stringify(C.makeBackup((await a.exportAll()).works, (await a.exportAll()).versions, {})));
  assert.deepEqual(C.validateBackup(b), []);
  const c = S.createMemoryStorage();
  await c.importAll(C.planImport(b, [], []));
  assert.deepEqual(await c.getVersion('v1'), await a.getVersion('v1'));
});
