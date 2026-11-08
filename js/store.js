// Onde os pacotes ficam guardados:
//  - no app do iPhone: arquivos do próprio app (via ponte nativa);
//  - no navegador: IndexedDB.
// Cada pacote é um objeto simples, guardado como JSON.

import { isNative, call } from './native.js';

const DB = 'recorta-ai';
const STORE = 'packs';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const result = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
        t.onerror = () => reject(t.error);
      }),
  );
}

export async function listPacks() {
  let packs;
  if (isNative) {
    const raw = await call('listPacks');
    packs = (raw || []).map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } else {
    packs = (await tx('readonly', (s) => s.getAll())) || [];
  }
  return packs.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export async function savePack(pack) {
  pack.updated = Date.now();
  if (isNative) return call('savePack', { id: pack.id, json: JSON.stringify(pack) });
  return tx('readwrite', (s) => s.put(pack));
}

export async function deletePack(id) {
  if (isNative) return call('deletePack', { id });
  return tx('readwrite', (s) => s.delete(id));
}
