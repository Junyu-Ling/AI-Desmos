/**
 * GIF 播放：归档全部帧，画板只挂当前 1 帧。
 * 滑块 s 变了只在「换帧」时 setState，弱机器也能跟手。
 */
import { GIF_TIME_SLIDER, GIF_SLIDER_STEP } from './gif-quality';
import {
  GifFrameArchive,
  parseGifFrameIndexFromId,
  type GifFrameVisibilitySet,
  type StoredGifFrame,
} from './gif-frame-archive';
import { updateGifStreamDuration } from './image-processing';

export type { GifFrameVisibilitySet } from './gif-frame-archive';
export { classifyGifFrameExpressionIds } from './gif-frame-archive';

const SLIDER_DEBOUNCE_MS = 24;

const formatSliderTime = (sec: number): string => {
  const rounded = Math.round(sec * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '');
};

export const gifFolderId = (frameIndex: number): string => `gif_folder_${frameIndex + 1}`;

export type GifPlaybackAttachOptions = {
  onInjectProgress?: (done: number, total: number) => void;
  autoplay?: boolean;
};

export class GifWindowedPlaybackManager {
  private calculator: any = null;
  private sliderVar = GIF_TIME_SLIDER;
  private sliderHelper: any = null;
  private followLatestDuringGeneration = true;
  private injectAbort = false;
  private swapChain = Promise.resolve();
  private syncingSlider = false;
  private lastSetTime = 0;
  private visibleIndex = -1;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  generating = false;

  constructor(private archive: GifFrameArchive) {}

  getFrameCount(): number {
    return this.archive.size;
  }

  exportFrames(): GifFrameVisibilitySet[] {
    return this.archive.getOrderedFrames().map(frame => ({
      timeStart: frame.timeStart,
      timeEnd: frame.timeEnd,
      visibleIds: [...frame.visibleIds],
      auxIds: [...frame.auxIds],
    }));
  }

  getArchive(): GifFrameArchive {
    return this.archive;
  }

  onFrameArchived(index: number): void {
    if (!this.calculator || this.injectAbort || !this.followLatestDuringGeneration) return;
    const frame = this.archive.get(index);
    if (!frame) return;

    this.swapChain = this.swapChain
      .catch(() => undefined)
      .then(() => {
        if (!this.calculator || this.injectAbort || !this.followLatestDuringGeneration) return;
        updateGifStreamDuration(
          this.calculator,
          frame.timeEnd,
          this.sliderVar,
          GIF_SLIDER_STEP,
          frame.timeStart,
        );
        this.setSliderTime(frame.timeStart);
        this.putFrameOnCalculator(frame);
      });
  }

  attachForGeneration(calculator: any, sliderVar = GIF_TIME_SLIDER): void {
    if (this.calculator && this.calculator !== calculator) this.detach();
    this.injectAbort = false;
    this.calculator = calculator;
    this.sliderVar = sliderVar;
    this.followLatestDuringGeneration = true;
    this.generating = true;
  }

  async transitionToPlayback(
    initialIndex = 0,
    options: GifPlaybackAttachOptions = {},
  ): Promise<void> {
    this.injectAbort = false;
    this.followLatestDuringGeneration = false;
    this.generating = false;
    await this.swapChain.catch(() => undefined);
    this.resetSliderToFrame(initialIndex);
    this.putFrameOnCalculator(this.archive.get(initialIndex));
    this.bindSliderObserver();
    options.onInjectProgress?.(1, Math.max(1, this.archive.size));
  }

  attach(
    calculator: any,
    sliderVar = GIF_TIME_SLIDER,
    initialIndex = 0,
    options: GifPlaybackAttachOptions = {},
  ): void {
    if (this.calculator && this.calculator !== calculator) this.detach();
    this.injectAbort = false;
    this.calculator = calculator;
    this.sliderVar = sliderVar;
    this.followLatestDuringGeneration = false;
    void this.transitionToPlayback(initialIndex, options);
  }

  attachForRestore(calculator: any, sliderVar = GIF_TIME_SLIDER): void {
    if (this.calculator && this.calculator !== calculator) this.detach();
    this.injectAbort = false;
    this.calculator = calculator;
    this.sliderVar = sliderVar;
    this.followLatestDuringGeneration = false;
    this.generating = false;
    this.bindSliderObserver();
    const index = Math.max(0, this.findFrameIndex(this.readSliderValue()));
    this.putFrameOnCalculator(this.archive.get(index));
  }

  startAutoplay(): void {}
  stopAutoplay(): void {}

  detach(): void {
    this.injectAbort = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.unbindSliderObserver();
    this.calculator = null;
    this.swapChain = Promise.resolve();
    this.followLatestDuringGeneration = true;
    this.generating = false;
    this.visibleIndex = -1;
  }

  private unbindSliderObserver(): void {
    if (this.sliderHelper?.unobserve) {
      try { this.sliderHelper.unobserve('numericValue'); } catch { /* ignore */ }
    }
    this.sliderHelper = null;
  }

  private bindSliderObserver(): void {
    if (!this.calculator) return;
    this.unbindSliderObserver();
    if (typeof this.calculator.HelperExpression !== 'function') return;
    try {
      this.sliderHelper = this.calculator.HelperExpression({ latex: this.sliderVar });
      this.sliderHelper.observe('numericValue', () => {
        if (this.syncingSlider || this.followLatestDuringGeneration) return;
        this.scheduleShowFromSlider();
      });
    } catch {
      this.sliderHelper = null;
    }
  }

  private scheduleShowFromSlider(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const index = this.findFrameIndex(this.readSliderValue());
      if (index < 0 || index === this.visibleIndex) return;
      this.putFrameOnCalculator(this.archive.get(index));
    }, SLIDER_DEBOUNCE_MS);
  }

  private readSliderValue(): number {
    if (this.sliderHelper && Number.isFinite(this.sliderHelper.numericValue)) {
      return this.sliderHelper.numericValue;
    }
    return this.lastSetTime;
  }

  private findFrameIndex(timeSec: number): number {
    const frames = this.archive.getOrderedFrames();
    if (frames.length === 0) return -1;
    for (const frame of frames) {
      if (timeSec >= frame.timeStart && timeSec < frame.timeEnd) return frame.index;
    }
    const last = frames[frames.length - 1];
    if (timeSec >= last.timeStart) return last.index;
    return frames[0].index;
  }

  /** 画板公式列表 = 滑块 + 当前帧（其它帧只在内存） */
  private putFrameOnCalculator(frame?: StoredGifFrame): void {
    if (!this.calculator || !frame || typeof this.calculator.getState !== 'function') return;
    if (frame.index === this.visibleIndex) return;
    this.visibleIndex = frame.index;
    try {
      const state = this.calculator.getState();
      const list = state?.expressions?.list ?? [];
      const kept = list.filter((expr: any) => {
        const id = String(expr?.id || '');
        if (id === 'gif_time_slider') return true;
        if (id.startsWith('gif_folder_')) return false;
        return parseGifFrameIndexFromId(id) == null;
      });
      this.calculator.setState({
        ...state,
        expressions: {
          ...state.expressions,
          list: [...kept, ...frame.expressions],
        },
      });
    } catch {
      /* ignore */
    }
  }

  private setSliderTime(timeSec: number): void {
    if (!this.calculator) return;
    this.lastSetTime = timeSec;
    this.syncingSlider = true;
    try {
      this.calculator.setExpression({
        id: 'gif_time_slider',
        latex: `${this.sliderVar}=${formatSliderTime(timeSec)}`,
      });
    } catch { /* ignore */ }
    window.setTimeout(() => { this.syncingSlider = false; }, 30);
  }

  private resetSliderToFrame(frameIndex: number): void {
    if (!this.calculator) return;
    const frame = this.archive.get(frameIndex);
    const time = frame?.timeStart ?? 0;
    const ordered = this.archive.getOrderedFrames();
    const last = ordered[ordered.length - 1];
    const duration = last?.timeEnd ?? Math.max(time, 0.1);
    this.syncingSlider = true;
    updateGifStreamDuration(this.calculator, duration, this.sliderVar, GIF_SLIDER_STEP, time);
    this.lastSetTime = time;
    window.setTimeout(() => { this.syncingSlider = false; }, 30);
  }
}

let activeManager: GifWindowedPlaybackManager | null = null;

export async function migrateCalculatorToWindowedPlayback(
  calculator: any,
  archive: GifFrameArchive,
  sliderVar = GIF_TIME_SLIDER,
): Promise<GifWindowedPlaybackManager> {
  if (activeManager) activeManager.detach();
  const manager = new GifWindowedPlaybackManager(archive);
  manager.attachForRestore(calculator, sliderVar);
  activeManager = manager;
  return manager;
}

export async function attachGifWindowedPlayback(
  calculator: any,
  manager: GifWindowedPlaybackManager,
  sliderVar = GIF_TIME_SLIDER,
  initialIndex = 0,
  fromGeneration = false,
  options: GifPlaybackAttachOptions = {},
): Promise<void> {
  if (activeManager && activeManager !== manager) activeManager.detach();
  activeManager = manager;
  if (fromGeneration) {
    await manager.transitionToPlayback(initialIndex, { autoplay: false, ...options });
  } else {
    manager.attach(calculator, sliderVar, initialIndex, { autoplay: false, ...options });
  }
}

export function detachGifPlayback(): void {
  activeManager?.detach();
  activeManager = null;
}

export function getActiveWindowedPlayback(): GifWindowedPlaybackManager | null {
  return activeManager;
}

export function getActivePlaybackSnapshot(): GifFrameVisibilitySet[] | null {
  if (!activeManager) return null;
  const frames = activeManager.exportFrames();
  return frames.length > 0 ? frames : null;
}

/** @deprecated */
export class GifPlaybackManager extends GifWindowedPlaybackManager {}

export function attachGifPlayback(
  calculator: any,
  manager: GifWindowedPlaybackManager,
  sliderVar = GIF_TIME_SLIDER,
): void {
  attachGifWindowedPlayback(calculator, manager, sliderVar, 0);
}

export function restoreGifPlaybackFromSnapshot(
  calculator: any,
  frames: GifFrameVisibilitySet[],
  sliderVar = GIF_TIME_SLIDER,
): void {
  if (!calculator || frames.length === 0) return;
  const archive = new GifFrameArchive();
  frames.forEach((frame, index) => {
    archive.add(index, frame.timeStart, frame.timeEnd, []);
  });
  void migrateCalculatorToWindowedPlayback(calculator, archive, sliderVar);
}
