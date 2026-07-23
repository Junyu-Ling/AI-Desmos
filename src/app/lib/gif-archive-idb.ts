/**
 * GIF 帧归档 IndexedDB 持久化（体积大，不走 localStorage）
 */
import type { GifFrameArchive, SerializedGifArchive } from './gif-frame-archive';

const DB_NAME = 'ai-desmos-gif-v1';
const STORE = 'archives';
const KEY = 'current';

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export async function saveGifArchiveToIdb(archive: GifFrameArchive): Promise<void> {
  if (archive.size === 0) return;
  const db = await openDb();
  try {
    const payload: SerializedGifArchive = archive.exportSnapshot();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(payload, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadGifArchiveFromIdb(): Promise<GifFrameArchive | null> {
  try {
    const db = await openDb();
    try {
      const snapshot = await new Promise<SerializedGifArchive | null>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve((req.result as SerializedGifArchive | undefined) ?? null);
        req.onerror = () => reject(req.error);
      });
      if (!snapshot?.frames?.length) return null;
      return GifFrameArchive.fromSnapshot(snapshot);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function clearGifArchiveIdb(): Promise<void> {
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    /* ignore */
  }
}
