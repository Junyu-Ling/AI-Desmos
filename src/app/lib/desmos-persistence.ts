/**
 * Desmos 画板工作区持久化：刷新后恢复，仅用户点「清空画板」时清除。
 * GIF 帧数据走 IndexedDB；画板仅存当前窗口 + 视口。
 */
import { getActiveWindowedPlayback } from './gif-playback';
import { saveGifArchiveToIdb, clearGifArchiveIdb, loadGifArchiveFromIdb } from './gif-archive-idb';
import { GifFrameArchive, parseGifFrameIndexFromId } from './gif-frame-archive';
import { migrateCalculatorToWindowedPlayback } from './gif-playback';

const WORKSPACE_STORAGE_KEY = 'desmos_workspace_v1';

export type WorkspaceMode = '2d' | '3d';
const lsKey = (mode: WorkspaceMode) => (mode === '3d' ? WORKSPACE_STORAGE_KEY + '_3d' : WORKSPACE_STORAGE_KEY);
const idbKey = (mode: WorkspaceMode) => (mode === '3d' ? 'current3d' : 'current');

/** 从状态判断是 2D 还是 3D 画板（两种画板的状态互不兼容，必须分开存） */
export function detectStateMode(state: any): WorkspaceMode {
  const g = state?.graph;
  if (g && (g.threeDMode === true || g.viewport?.zmin !== undefined || Object.keys(g).some(k => /3D$/.test(k)))) {
    return '3d';
  }
  return '2d';
}

export function detectCalculatorMode(calculator: any): WorkspaceMode {
  try {
    return detectStateMode(calculator?.getState?.());
  } catch {
    return '2d';
  }
}

export type PersistedWorkspace = {
  calculatorState: unknown;
  windowedGif?: boolean;
  savedAt: number;
  /** 状态体积超过 localStorage 配额（如大型 3D 网格）→ 本体存在 IndexedDB，这里只留标记 */
  inIdb?: boolean;
};

// ─── 大状态走 IndexedDB（localStorage 约 5MB，大网格一份状态就几 MB）──────────────
const WS_DB = 'ai-desmos-workspace-v1';
const WS_STORE = 'ws';
const LS_SOFT_LIMIT = 1_500_000; // 字符数，超过就改存 IndexedDB

const openWsDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(WS_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(WS_STORE)) req.result.createObjectStore(WS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function idbPutWorkspace(mode: WorkspaceMode, value: unknown): Promise<void> {
  const db = await openWsDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(WS_STORE, 'readwrite');
      tx.objectStore(WS_STORE).put(value, idbKey(mode));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbGetWorkspace(mode: WorkspaceMode): Promise<PersistedWorkspace | null> {
  try {
    const db = await openWsDb();
    try {
      return await new Promise<PersistedWorkspace | null>((resolve, reject) => {
        const req = db.transaction(WS_STORE, 'readonly').objectStore(WS_STORE).get(idbKey(mode));
        req.onsuccess = () => resolve((req.result as PersistedWorkspace | undefined) ?? null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function idbDeleteWorkspace(mode: WorkspaceMode): Promise<void> {
  try {
    const db = await openWsDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(WS_STORE, 'readwrite');
        tx.objectStore(WS_STORE).delete(idbKey(mode));
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

export function loadWorkspace(mode: WorkspaceMode = '2d'): PersistedWorkspace | null {
  try {
    const raw = localStorage.getItem(lsKey(mode));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWorkspace;
    if (!parsed?.calculatorState) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearWorkspaceAsync(mode: WorkspaceMode = '2d'): Promise<void> {
  clearWorkspace(mode);
  await idbDeleteWorkspace(mode);
  await clearGifArchiveIdb();
}

export function clearWorkspace(mode: WorkspaceMode = '2d'): void {
  try {
    localStorage.removeItem(lsKey(mode));
  } catch {
    /* ignore */
  }
}

const slimGifCalculatorState = (state: any): any => {
  const list = state?.expressions?.list ?? [];
  const kept = list.filter((expr: any) => {
    const id = String(expr?.id || '');
    if (!id) return false;
    if (id === 'gif_time_slider') return true;
    if (id.startsWith('gif_folder_')) return false;
    return parseGifFrameIndexFromId(id) == null;
  });
  return {
    ...state,
    expressions: {
      ...state.expressions,
      list: kept,
    },
  };
};

export async function saveWorkspaceAsync(calculator: any): Promise<boolean> {
  const manager = getActiveWindowedPlayback();
  if (manager?.generating) return false;
  if (!calculator?.getState) return false;

  try {
    const manager = getActiveWindowedPlayback();
    const archive = manager?.getArchive();
    const rawState = calculator.getState();
    const mode = detectStateMode(rawState);
    const payload: PersistedWorkspace = {
      calculatorState: archive && archive.size > 0 ? slimGifCalculatorState(rawState) : rawState,
      savedAt: Date.now(),
    };

    if (archive && archive.size > 0) {
      await saveGifArchiveToIdb(archive);
      payload.windowedGif = true;
    }

    const json = JSON.stringify(payload);
    if (json.length <= LS_SOFT_LIMIT) {
      try {
        localStorage.setItem(lsKey(mode), json);
        void idbDeleteWorkspace(mode);
        return true;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'QuotaExceededError')) throw error;
      }
    }
    // 大状态：本体进 IndexedDB，localStorage 只留标记（同时清掉旧的过期状态，避免刷新后恢复成旧画面）
    await idbPutWorkspace(mode, payload);
    localStorage.setItem(
      lsKey(mode),
      JSON.stringify({ calculatorState: {}, savedAt: payload.savedAt, inIdb: true, windowedGif: payload.windowedGif }),
    );
    return true;
  } catch (error) {
    console.warn('[workspace] save failed', error);
    // 存不下就别留旧状态，免得刷新后恢复出过期画面
    clearWorkspace(detectCalculatorMode(calculator));
    return false;
  }
}

export function saveWorkspace(calculator: any): boolean {
  void saveWorkspaceAsync(calculator);
  return true;
}

/** 刷新后恢复：优先 IndexedDB 归档 + 窗口化播放 */
export async function restoreWorkspace(calculator: any): Promise<boolean> {
  const mode = detectCalculatorMode(calculator);
  let workspace = loadWorkspace(mode);
  if (workspace?.inIdb) workspace = await idbGetWorkspace(mode);
  if (!workspace?.calculatorState || !calculator?.setState) return false;
  // 旧版本把 3D 状态存进了 2D 的键：模式对不上就不恢复（否则 2D 画板会报 Error loading graph）
  if (!workspace.inIdb && detectStateMode(workspace.calculatorState) !== mode) return false;

  try {
    calculator.setState(workspace.calculatorState);

    let archive = workspace.windowedGif ? await loadGifArchiveFromIdb() : null;

    if (!archive || archive.size === 0) {
      archive = GifFrameArchive.fromCalculatorState(workspace.calculatorState);
    }

    const frameCount = archive.size;
    const list = (workspace.calculatorState as any)?.expressions?.list ?? [];
    const gifExprCount = list.filter((e: any) => parseGifFrameIndexFromId(String(e?.id || '')) != null).length;

    if (frameCount > 2 || gifExprCount > 800) {
      await migrateCalculatorToWindowedPlayback(calculator, archive);
      return true;
    }

    return frameCount > 0 || gifExprCount > 0;
  } catch (error) {
    console.warn('[workspace] restore failed', error);
    return false;
  }
}

export function createDebouncedWorkspaceSaver(delayMs = 800) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (calculator: any) => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      void saveWorkspaceAsync(calculator);
    }, delayMs);
  };

  const flush = (calculator: any) => {
    cancel();
    void saveWorkspaceAsync(calculator);
  };

  return { schedule, flush, cancel };
}
