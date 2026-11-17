/* 소설 작업실 — storage.js
 * 저장 계층. UI와 AI 엔진은 이 인터페이스만 쓴다. 나중에 서버 저장소로 바꿀 때 이 파일만 교체한다.
 *   kind: 'indexeddb' | 'memory'(영구 저장 안 됨)
 *   listWorks / getWork / putWork / deleteWork(버전 포함)
 *   listVersionMeta(workId) / getVersion / putVersion / deleteVersion
 *   getMeta / setMeta / exportAll / importAll / estimate */
(function (root, factory) {
  const m = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = m;
  else root.NSStorage = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DB_NAME = 'novel-studio', DB_VER = 2;
  const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
  const metaOf = (v) => ({ id: v.id, workId: v.workId, parentId: v.parentId, label: v.label, kind: v.kind, note: v.note, createdAt: v.createdAt, updatedAt: v.updatedAt, frozen: v.frozen, stats: v.stats || null, ai: v.ai ? { jobId: v.ai.jobId, type: v.ai.type, status: v.ai.status } : null, aiChars: aiChars(v) });
  function aiChars(v) { let n = 0, t = 0; (v.chapters || []).forEach((c) => c.paragraphs.forEach((p) => { const l = p.text.replace(/\s/g, '').length; t += l; if (p.source === 'ai' || p.source === 'ai-edit') n += l; })); return t ? Math.round((n / t) * 1000) / 1000 : 0; }

  function createMemoryStorage(reason) {
    const works = new Map(), versions = new Map(), meta = new Map(), jobs = new Map();
    return {
      kind: 'memory', reason: reason || '', persistent: false,
      async listWorks() { return [...works.values()].map(clone); },
      async getWork(id) { return clone(works.get(id)); },
      async putWork(w) { works.set(w.id, clone(w)); },
      async deleteWork(id) { works.delete(id); [...versions.values()].filter((v) => v.workId === id).forEach((v) => versions.delete(v.id)); [...jobs.values()].filter((j) => j.workId === id).forEach((j) => jobs.delete(j.id)); },
      async putJob(j) { jobs.set(j.id, clone(j)); },
      async getJob(id) { return clone(jobs.get(id)); },
      async listJobs(workId) { return [...jobs.values()].filter((j) => !workId || j.workId === workId).map(clone); },
      async deleteJob(id) { jobs.delete(id); },
      async listVersionMeta(workId) { return [...versions.values()].filter((v) => v.workId === workId).map(metaOf); },
      async getVersion(id) { return clone(versions.get(id)); },
      async putVersion(v) { versions.set(v.id, clone(v)); },
      async deleteVersion(id) { versions.delete(id); },
      async getMeta(k) { return clone(meta.get(k)); },
      async setMeta(k, val) { meta.set(k, clone(val)); },
      async exportAll() { return { works: [...works.values()].map(clone), versions: [...versions.values()].map(clone), prefs: clone(meta.get('prefs')) || {} }; },
      async importAll(d) { (d.works || []).forEach((w) => works.set(w.id, clone(w))); (d.versions || []).forEach((v) => versions.set(v.id, clone(v))); },
      async estimate() { return null; },
      async persisted() { return false; },
      async requestPersist() { return false; },
    };
  }

  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('transaction aborted')); });

  async function openIdb() {
    const idb = (typeof indexedDB !== 'undefined') ? indexedDB : null;
    if (!idb) throw new Error('이 환경에는 IndexedDB가 없습니다.');
    const db = await new Promise((res, rej) => {
      const r = idb.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('works')) d.createObjectStore('works', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('versions')) d.createObjectStore('versions', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('vmeta')) d.createObjectStore('vmeta', { keyPath: 'id' }).createIndex('workId', 'workId');
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
        if (!d.objectStoreNames.contains('jobs')) d.createObjectStore('jobs', { keyPath: 'id' }).createIndex('workId', 'workId');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('다른 탭이 저장소를 잡고 있습니다.'));
    });
    // 실제로 쓰고 읽어 본다(시크릿 창 등에서 열리기만 하고 쓰기는 실패하는 경우 대비)
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(Date.now(), '__probe');
    await done(tx);
    return db;
  }

  async function createStorage() {
    let db;
    try { db = await openIdb(); }
    catch (e) { return createMemoryStorage(String(e && e.message || e)); }
    const get = async (store, key) => req(db.transaction(store).objectStore(store).get(key));
    const all = async (store) => req(db.transaction(store).objectStore(store).getAll());
    const api = {
      kind: 'indexeddb', persistent: true,
      listWorks: () => all('works'),
      getWork: (id) => get('works', id),
      async putWork(w) { const tx = db.transaction('works', 'readwrite'); tx.objectStore('works').put(clone(w)); await done(tx); },
      async deleteWork(id) {
        const metas = await api.listVersionMeta(id), js = await api.listJobs(id);
        const tx = db.transaction(['works', 'versions', 'vmeta', 'jobs'], 'readwrite');
        tx.objectStore('works').delete(id);
        js.forEach((j) => tx.objectStore('jobs').delete(j.id));
        metas.forEach((m) => { tx.objectStore('versions').delete(m.id); tx.objectStore('vmeta').delete(m.id); });
        await done(tx);
      },
      listVersionMeta: (workId) => req(db.transaction('vmeta').objectStore('vmeta').index('workId').getAll(workId)),
      getVersion: (id) => get('versions', id),
      async putVersion(v) { const tx = db.transaction(['versions', 'vmeta'], 'readwrite'); tx.objectStore('versions').put(clone(v)); tx.objectStore('vmeta').put(metaOf(v)); await done(tx); },
      async deleteVersion(id) { const tx = db.transaction(['versions', 'vmeta'], 'readwrite'); tx.objectStore('versions').delete(id); tx.objectStore('vmeta').delete(id); await done(tx); },
      async putJob(j) { const tx = db.transaction('jobs', 'readwrite'); tx.objectStore('jobs').put(clone(j)); await done(tx); },
      getJob: (id) => get('jobs', id),
      listJobs: (workId) => (workId ? req(db.transaction('jobs').objectStore('jobs').index('workId').getAll(workId)) : all('jobs')),
      async deleteJob(id) { const tx = db.transaction('jobs', 'readwrite'); tx.objectStore('jobs').delete(id); await done(tx); },
      getMeta: (k) => get('meta', k),
      async setMeta(k, val) { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put(clone(val), k); await done(tx); },
      async exportAll() { return { works: await all('works'), versions: await all('versions'), prefs: (await get('meta', 'prefs')) || {} }; },
      async importAll(d) {
        const tx = db.transaction(['works', 'versions', 'vmeta'], 'readwrite');
        (d.works || []).forEach((w) => tx.objectStore('works').put(clone(w)));
        (d.versions || []).forEach((v) => { tx.objectStore('versions').put(clone(v)); tx.objectStore('vmeta').put(metaOf(v)); });
        await done(tx);
      },
      async estimate() { try { return await navigator.storage.estimate(); } catch (e) { return null; } },
      async persisted() { try { return await navigator.storage.persisted(); } catch (e) { return false; } },
      async requestPersist() { try { return await navigator.storage.persist(); } catch (e) { return false; } },
    };
    return api;
  }
  return { createStorage, createMemoryStorage, metaOf };
});
