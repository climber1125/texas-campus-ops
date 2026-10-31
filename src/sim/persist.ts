// Minimal IndexedDB persistence (no dependencies). Stores full SimState snapshots.
import type { SimState } from './types';

const DB = 'grid-ops', STORE = 'sessions';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function saveState(key: string, s: SimState): Promise<void> {
  const db = await open();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ savedAt: Date.now(), state: JSON.parse(JSON.stringify(s)) }, key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
  db.close();
}

export async function loadState(key: string): Promise<{ savedAt: number; state: SimState } | null> {
  const db = await open();
  const v = await new Promise<any>((res, rej) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error);
  });
  db.close();
  return v && v.state?.version === 2 ? v : null;
}
