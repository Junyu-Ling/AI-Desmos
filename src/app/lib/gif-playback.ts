/**
 * GIF 按需播放：生成只归档；画板同时仅 1 帧，滑块 s 切换时再注入（秒开、公式极少）。
 */
import { GIF_TIME_SLIDER } from './gif-quality';
import {
  GifFrameArchive,
  parseGifFrameIndexFromId,
  type GifFrameVisibilitySet,
  type StoredGifFrame,
} from './gif-frame-archive';
import { appendGifFrameToCalculator, updateGifStreamDuration } from './image-processing';

export type { GifFrameVisibilitySet } from './gif-frame-archive';
export { classifyGifFrameExpressionIds } from './gif-frame-archive';

const SLIDER_DEBOUNCE_MS = 50;

const formatSliderTime = (sec: number): string => {
  const rounded = Math.round(sec * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '');
};

const removeExpressionIds = (calculator: any, ids: string[]) => {
  if (!calculator || ids.length === 0) return;
  for (const id of ids) {
    try {
      calculator.removeExpression({ id });
    } catch {
      /* already removed */
    }
  }
};

export type GifPlaybackAttachOptions = {
  onInjectProgress?: (done: number, total: number) => void;
};

export class GifWindowedPlaybackManager {
  private loadedFrames = new Map<number, StoredGifFrame>();
  private activeIndex = -1;
  private calculator: any = null;
  private sliderVar = GIF_TIME_SLIDER;
  private sliderHelper: any = null;
  private followLatestDuringGeneration = true;
  private injectAbort = false;
  private syncing = false;
  private swapChain = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

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

  /** 生成阶段：只更新滑块总时长，不向 Desmos 写公式 */
  onFrameArchived(_index: number): void {
    if (!this.calculator || !this.followLatestDuringGeneration) return;
    const ordered = this.archive.getOrderedFrames();
    const last = ordered[ordered.length - 1];
    if (last) {
      updateGifStreamDuration(this.calculator, last.timeEnd, this.sliderVar);
    }
  }

  attachForGeneration(calculator: any, sliderVar = GIF_TIME_SLIDER): void {
    // 仅在已绑定别的 calculator 时清理；calculator===null 时勿 detach，
    // 否则 injectAbort 会被置 true 且后续注入全部被跳过。
    if (this.calculator && this.calculator !== calculator) {
      this.detach();
    }
    this.injectAbort = false;
    this.calculator = calculator;
    this.sliderVar = sliderVar;
    this.followLatestDuringGeneration = true;
  }

  /** 首帧注入 + 滑块绑定，立即返回 */
  async transitionToPlayback(
    initialIndex = 0,
    options: GifPlaybackAttachOptions = {},
  ): Promise<void> {
    this.injectAbort = false;
    this.followLatestDuringGeneration = false;
    this.resetSliderToFrame(initialIndex);
    this.bindSliderObserver();
    await this.swapToFrame(initialIndex, true);
    options.onInjectProgress?.(1, this.archive.size);
  }

  attach(
    calculator: any,
    sliderVar = GIF_TIME_SLIDER,
    initialIndex = 0,
    options: GifPlaybackAttachOptions = {},
  ): void {
    if (this.calculator && this.calculator !== calculator) {
      this.detach();
    }
    this.injectAbort = false;
    this.calculator = calculator;
    this.sliderVar = sliderVar;
    this.followLatestDuringGeneration = false;
    this.resetSliderToFrame(initialIndex);
    this.bindSliderObserver();
    void this.swapToFrame(initialIndex, true).then(() => {
      options.onInjectProgress?.(1, this.archive.size);
    });
  }

  detach(): void {
    this.injectAbort = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.unbindSliderObserver();
    this.clearLoadedFramesFromCalculator();
    this.calculator = null;
    this.activeIndex = -1;
    this.swapChain = Promise.resolve();
    this.followLatestDuringGeneration = true;
  }

  private unbindSliderObserver(): void {
    if (this.sliderHelper?.unobserve) {
      try {
        this.sliderHelper.unobserve('numericValue');
      } catch {
        /* ignore */
      }
    }
    this.sliderHelper = null;
  }

  private bindSliderObserver(): void {
    if (!this.calculator) return;
    this.unbindSliderObserver();

    if (typeof this.calculator.HelperExpression === 'function') {
      try {
        this.sliderHelper = this.calculator.HelperExpression({ latex: this.sliderVar });
        this.sliderHelper.observe('numericValue', () => {
          if (this.syncing || this.followLatestDuringGeneration) return;
          this.scheduleSwap();
        });
      } catch {
        this.sliderHelper = null;
      }
    }

    if (!this.sliderHelper && typeof this.calculator.observeEvent === 'function') {
      this.calculator.observeEvent('change', () => {
        if (this.syncing || this.followLatestDuringGeneration) return;
        this.scheduleSwap();
      });
    }
  }

  private scheduleSwap(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.swapChain = this.swapChain
        .catch(() => undefined)
        .then(() => this.swapToCurrentSliderFrame(false));
    }, SLIDER_DEBOUNCE_MS);
  }

  private readSliderValue(): number {
    if (this.sliderHelper && Number.isFinite(this.sliderHelper.numericValue)) {
      return this.sliderHelper.numericValue;
    }
    if (!this.calculator?.getState) return 0;
    for (const item of this.calculator.getState()?.expressions?.list ?? []) {
      if (item?.id !== 'gif_time_slider') continue;
      const latex = String(item.latex ?? '');
      const eq = latex.indexOf('=');
      if (eq < 0) continue;
      const value = parseFloat(latex.slice(eq + 1));
      if (Number.isFinite(value)) return value;
    }
    return 0;
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

  private async swapToCurrentSliderFrame(force = false): Promise<void> {
    const index = this.findFrameIndex(this.readSliderValue());
    if (index >= 0) await this.swapToFrame(index, force);
  }

  private purgeAllGifFrameExpressions(): void {
    if (!this.calculator?.getState) return;
    for (const expr of this.calculator.getState()?.expressions?.list ?? []) {
      const id = String(expr?.id || '');
      if (parseGifFrameIndexFromId(id) == null) continue;
      try {
        this.calculator.removeExpression({ id });
      } catch {
        /* ignore */
      }
    }
    this.loadedFrames.clear();
  }

  private clearLoadedFramesFromCalculator(): void {
    this.purgeAllGifFrameExpressions();
  }

  private setSliderTime(timeSec: number): void {
    if (!this.calculator) return;
    try {
      this.calculator.setExpression({
        id: 'gif_time_slider',
        latex: `${this.sliderVar}=${formatSliderTime(timeSec)}`,
      });
    } catch {
      /* ignore */
    }
  }

  private resetSliderToFrame(frameIndex: number): void {
    if (!this.calculator) return;
    const frame = this.archive.get(frameIndex);
    const time = frame?.timeStart ?? 0;
    const ordered = this.archive.getOrderedFrames();
    const last = ordered[ordered.length - 1];
    const duration = last?.timeEnd ?? Math.max(time, 0.1);
    updateGifStreamDuration(this.calculator, duration, this.sliderVar);
    this.setSliderTime(time);
  }

  private isFramePresentOnCalculator(frame: StoredGifFrame): boolean {
    if (frame.visibleIds.length === 0) return false;
    const ids = new Set<string>();
    for (const item of this.calculator?.getState?.()?.expressions?.list ?? []) {
      const id = String(item?.id || '');
      if (id) ids.add(id);
    }
    return frame.visibleIds.some(id => ids.has(id));
  }

  private async injectFrame(frame: StoredGifFrame): Promise<void> {
    if (!this.calculator || this.injectAbort) return;
    const expressions = frame.expressions.map(expr => ({ ...expr }));
    await appendGifFrameToCalculator(this.calculator, expressions, {
      fastInject: true,
      appendOnly: true,
    });
    this.loadedFrames.set(frame.index, frame);
  }

  /** 画板只保留一帧；切换时先清空再注入 */
  private async swapToFrame(index: number, force = false): Promise<void> {
    if (!this.calculator || this.archive.size === 0 || index < 0) return;
    const frame = this.archive.get(index);
    if (!frame) return;

    if (!force && index === this.activeIndex && this.isFramePresentOnCalculator(frame)) {
      return;
    }

    this.syncing = true;
    this.activeIndex = index;
    try {
      this.purgeAllGifFrameExpressions();
      await this.injectFrame(frame);
    } finally {
      this.syncing = false;
    }
  }
}

export async function migrateCalculatorToWindowedPlayback(
  calculator: any,
  archive: GifFrameArchive,
  sliderVar = GIF_TIME_SLIDER,
): Promise<GifWindowedPlaybackManager> {
  const manager = new GifWindowedPlaybackManager(archive);
  manager.attach(calculator, sliderVar, 0);
  return manager;
}

let activeManager: GifWindowedPlaybackManager | null = null;

export async function attachGifWindowedPlayback(
  calculator: any,
  manager: GifWindowedPlaybackManager,
  sliderVar = GIF_TIME_SLIDER,
  initialIndex = 0,
  fromGeneration = false,
  options: GifPlaybackAttachOptions = {},
): Promise<void> {
  if (activeManager && activeManager !== manager) {
    activeManager.detach();
  }
  activeManager = manager;
  if (fromGeneration) {
    await manager.transitionToPlayback(initialIndex, options);
  } else {
    manager.attach(calculator, sliderVar, initialIndex, options);
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
