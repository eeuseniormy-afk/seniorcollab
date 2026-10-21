// Projetos e vídeos ficam no próprio aparelho (IndexedDB), separados por conta.
const DB = 'seniorcollab', VER = 1;
let dbp;
function open() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' }).createIndex('user', 'userId');
      if (!d.objectStoreNames.contains('media')) d.createObjectStore('media');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export async function listProjects(userId) {
  const d = await open();
  const all = await req(d.transaction('projects').objectStore('projects').index('user').getAll(userId));
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function getProject(id) {
  const d = await open();
  return req(d.transaction('projects').objectStore('projects').get(id));
}
export async function saveProject(p) {
  p.updatedAt = Date.now();
  return tx('projects', 'readwrite', s => s.put(p));
}
export async function deleteProject(p) {
  await tx('media', 'readwrite', s => { for (const t of p.tracks) s.delete(t.mediaId); });
  return tx('projects', 'readwrite', s => s.delete(p.id));
}
export async function putMedia(blob) {
  const id = uid();
  await tx('media', 'readwrite', s => s.put(blob, id));
  return id;
}
export async function getMedia(id) {
  const d = await open();
  return req(d.transaction('media').objectStore('media').get(id));
}
export async function deleteMedia(id) {
  return tx('media', 'readwrite', s => s.delete(id));
}
export async function persist() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch (_) {}
}
