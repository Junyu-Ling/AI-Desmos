/**
 * Desmos 画板工作区持久化：刷新后恢复，仅用户点「清空画板」时清除。
 */
import type { GifFrameVisibilitySet } from './gif-playback';

const WORKSPACE_STORAGE_KEY = 'desmos_workspace_v1';

export type PersistedWorkspace = {
  calculatorState: unknown;
  gifPlayback?: GifFrameVisibilitySet[];
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

export function clearWorkspace(): void {
  try {
    localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function saveWorkspace(
  calculator: any,
  gifPlayback?: GifFrameVisibilitySet[] | null,
): boolean {
  if (!calculator?.getState) return false;

  try {
    const payload: PersistedWorkspace = {
      calculatorState: calculator.getState(),
      savedAt: Date.now(),
    };
    if (gifPlayback && gifPlayback.length > 0) {
      payload.gifPlayback = gifPlayback;
    }
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      console.warn('[workspace] localStorage quota exceeded; canvas not saved');
    } else {
      console.warn('[workspace] save failed', error);
    }
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

  const schedule = (calculator: any, gifPlayback?: GifFrameVisibilitySet[] | null) => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      saveWorkspace(calculator, gifPlayback);
    }, delayMs);
  };

  const flush = (calculator: any, gifPlayback?: GifFrameVisibilitySet[] | null) => {
    cancel();
    saveWorkspace(calculator, gifPlayback);
  };

  return { schedule, flush, cancel };
}
