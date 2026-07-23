/**
 * Desmos 画板工作区持久化：刷新后恢复，仅用户点「清空画板」时清除。
 * GIF 帧数据走 IndexedDB；画板仅存当前窗口 + 视口。
 */
import { getActiveWindowedPlayback } from './gif-playback';
import { saveGifArchiveToIdb, clearGifArchiveIdb, loadGifArchiveFromIdb } from './gif-archive-idb';
import { GifFrameArchive, parseGifFrameIndexFromId } from './gif-frame-archive';
import { migrateCalculatorToWindowedPlayback } from './gif-playback';

const WORKSPACE_STORAGE_KEY = 'desmos_workspace_v1';

export type PersistedWorkspace = {
  calculatorState: unknown;
  windowedGif?: boolean;
  savedAt: number;
};

export function loadWorkspace(): PersistedWorkspace | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWorkspace;
    if (!parsed?.calculatorState) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearWorkspaceAsync(): Promise<void> {
  clearWorkspace();
  await clearGifArchiveIdb();
}

export function clearWorkspace(): void {
  try {
    localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export async function saveWorkspaceAsync(calculator: any): Promise<boolean> {
  if (!calculator?.getState) return false;

  try {
    const manager = getActiveWindowedPlayback();
    const archive = manager?.getArchive();
    const payload: PersistedWorkspace = {
      calculatorState: calculator.getState(),
      savedAt: Date.now(),
    };

    if (archive && archive.size > 0) {
      await saveGifArchiveToIdb(archive);
      payload.windowedGif = true;
    }

    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      console.warn('[workspace] localStorage quota exceeded');
    } else {
      console.warn('[workspace] save failed', error);
    }
    return false;
  }
}

export function saveWorkspace(calculator: any): boolean {
  void saveWorkspaceAsync(calculator);
  return true;
}

/** 刷新后恢复：优先 IndexedDB 归档 + 窗口化播放 */
export async function restoreWorkspace(calculator: any): Promise<boolean> {
  const workspace = loadWorkspace();
  if (!workspace?.calculatorState || !calculator?.setState) return false;

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
