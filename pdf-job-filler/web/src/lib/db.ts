// Tiny IndexedDB key-value store. Templates can hold a whole PDF (base64), which is too big for localStorage.
const DB_NAME = "pdf-job-filler";
const STORE = "kv";

let dbPromise: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

export const kv = {
  get: <T>(key: string) => run<T | undefined>("readonly", (s) => s.get(key)),
  set: (key: string, value: unknown) => run<void>("readwrite", (s) => s.put(value, key)),
  del: (key: string) => run<void>("readwrite", (s) => s.delete(key)),
};
