/**
 * GIF 窗口化播放：画板内仅保留当前帧 ±1，彻底避免万级表达式拖慢 Desmos。
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

const DEFAULT_WINDOW_RADIUS = 1;

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

const setExpressionHidden = (calculator: any, ids: string[], hidden: boolean) => {
  if (!calculator || ids.length === 0) return;
  const updates = ids.map(id => ({ id, hidden }));
  if (typeof calculator.setExpressions === 'function') {
    calculator.setExpressions(updates);
  } else {
    updates.forEach(u => calculator.setExpression(u));
  }
};

export class GifWindowedPlaybackManager {
  private loadedFrames = new Map<number, StoredGifFrame>();
  private activeIndex = -1;
  private calculator: any = null;
  private sliderVar = GIF_TIME_SLIDER;
  private sliderHelper: any = null;
  private syncing = false;
  private syncChain = Promise.resolve();
  private raf = 0;
  private followLatestDuringGeneration = true;

  constructor(
    private archive: GifFrameArchive,
    private windowRadius = DEFAULT_WINDOW_RADIUS,
  ) {}

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

  /** 生成阶段：新帧归档后更新窗口（默认跟随最新帧） */
  onFrameArchived(index: number): void {
    if (!this.calculator) return;
    if (this.followLatestDuringGeneration) {
      this.scheduleSync(index);
    }
  }

  /** 生成阶段：挂载并跟随最新帧预览（不注入全量帧） */
  attachForGeneration(calculator: any, sliderVar = GIF_TIME_SLIDER): void {
    if (this.calculator !== calculator) {
      this.detach();
    } else {
      this.clearLoadedFramesFromCalculator();
    }
    this.calculator = calculator;
    this.sliderVar = sliderVar;
    this.activeIndex = -1;
    this.followLatestDuringGeneration = true;
  }

  /** 生成完成 → 播放模式：保留归档，从第 0 帧重新注入窗口 */
  transitionToPlayback(initialIndex = 0): void {
    this.followLatestDuringGeneration = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.clearLoadedFramesFromCalculator();
    this.activeIndex = -1;
    this.resetSliderToFrame(initialIndex);
    this.bindSliderObserver();
    this.scheduleSync(initialIndex, true);
  }

  attach(calculator: any, sliderVar = GIF_TIME_SLIDER, initialIndex = 0): void {
    if (this.calculator !== calculator) {
      this.detach();
      this.calculator = calculator;
    } else {
      this.clearLoadedFramesFromCalculator();
    }
    this.sliderVar = sliderVar;
    this.activeIndex = -1;
    this.followLatestDuringGeneration = false;
    this.resetSliderToFrame(initialIndex);
    this.bindSliderObserver();
    this.scheduleSync(initialIndex, true);
  }

  detach(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.unbindSliderObserver();
    this.clearLoadedFramesFromCalculator();
    this.calculator = null;
    this.activeIndex = -1;
    this.syncChain = Promise.resolve();
  }

  private clearLoadedFramesFromCalculator(): void {
    if (this.calculator) {
      for (const idx of [...this.loadedFrames.keys()]) {
        this.unloadFrame(idx);
      }
    }
    this.loadedFrames.clear();
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
          this.scheduleSync();
        });
      } catch {
        this.sliderHelper = null;
      }
    }

    if (!this.sliderHelper && typeof this.calculator.observeEvent === 'function') {
      this.calculator.observeEvent('change', () => {
        if (this.syncing || this.followLatestDuringGeneration) return;
        this.scheduleSync();
      });
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
    try {
      this.calculator.setExpression({
        id: 'gif_time_slider',
        latex: `${this.sliderVar}=${formatSliderTime(time)}`,
      });
    } catch {
      /* ignore */
    }
  }

  private readSliderValue(): number {
    if (this.sliderHelper && Number.isFinite(this.sliderHelper.numericValue)) {
      return this.sliderHelper.numericValue;
    }
    if (!this.calculator?.getState) return 0;
    const list = this.calculator.getState()?.expressions?.list ?? [];
    for (const item of list) {
      if (item?.id !== 'gif_time_slider') continue;
      const latex = String(item.latex ?? '');
      const eq = latex.indexOf('=');
      if (eq < 0) continue;
      const value = parseFloat(latex.slice(eq + 1));
      if (Number.isFinite(value)) return value;
    }
    return 0;
  }

  private getCalculatorExprIds(): Set<string> {
    const ids = new Set<string>();
    if (!this.calculator?.getState) return ids;
    for (const item of this.calculator.getState()?.expressions?.list ?? []) {
      const id = String(item?.id || '');
      if (id) ids.add(id);
    }
    return ids;
  }

  private isFramePresentOnCalculator(frame: StoredGifFrame): boolean {
    if (frame.visibleIds.length === 0) return false;
    const ids = this.getCalculatorExprIds();
    return frame.visibleIds.some(id => ids.has(id));
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

  private scheduleSync(forcedIndex?: number, force = false): void {
    this.syncChain = this.syncChain
      .catch(() => undefined)
      .then(() => this.syncWindow(forcedIndex, force));
  }

  private frameIndicesInWindow(center: number): number[] {
    const indices: number[] = [];
    for (let offset = -this.windowRadius; offset <= this.windowRadius; offset++) {
      const idx = center + offset;
      if (this.archive.has(idx)) indices.push(idx);
    }
    return indices;
  }

  private async injectFrame(frame: StoredGifFrame, hidden: boolean): Promise<void> {
    if (!this.calculator) return;
    const expressions = frame.expressions.map(expr => ({ ...expr }));
    await appendGifFrameToCalculator(this.calculator, expressions, {
      deferVisibility: true,
      fastInject: true,
    });
    setExpressionHidden(this.calculator, frame.visibleIds, hidden);
    setExpressionHidden(this.calculator, frame.auxIds, true);
    this.loadedFrames.set(frame.index, frame);
  }

  private unloadFrame(index: number): void {
    const frame = this.loadedFrames.get(index);
    if (!frame || !this.calculator) return;
    removeExpressionIds(this.calculator, [...frame.visibleIds, ...frame.auxIds]);
    this.loadedFrames.delete(index);
  }

  private setFrameVisible(frame: StoredGifFrame, visible: boolean): void {
    if (!this.calculator) return;
    setExpressionHidden(this.calculator, frame.visibleIds, !visible);
    setExpressionHidden(this.calculator, frame.auxIds, true);
  }

  async syncWindow(forcedIndex?: number, force = false): Promise<void> {
    if (!this.calculator || this.archive.size === 0) return;

    const timeSec = forcedIndex != null
      ? (this.archive.get(forcedIndex)?.timeStart ?? this.readSliderValue())
      : this.readSliderValue();
    const nextIndex = forcedIndex ?? this.findFrameIndex(timeSec);
    if (nextIndex < 0) return;
    if (!force && nextIndex === this.activeIndex) return;

    const needed = new Set(this.frameIndicesInWindow(nextIndex));
    const prevIndex = this.activeIndex;
    this.activeIndex = nextIndex;

    this.syncing = true;
    try {
      for (const loadedIndex of [...this.loadedFrames.keys()]) {
        if (!needed.has(loadedIndex)) {
          this.unloadFrame(loadedIndex);
          continue;
        }
        const loaded = this.loadedFrames.get(loadedIndex);
        if (loaded && !this.isFramePresentOnCalculator(loaded)) {
          this.loadedFrames.delete(loadedIndex);
        }
      }

      for (const idx of needed) {
        const frame = this.archive.get(idx);
        if (!frame) continue;
        const cached = this.loadedFrames.get(idx);
        if (cached && this.isFramePresentOnCalculator(cached)) continue;
        if (cached) this.loadedFrames.delete(idx);
        await this.injectFrame(frame, idx !== nextIndex);
      }

      if (prevIndex >= 0 && prevIndex !== nextIndex) {
        const prev = this.loadedFrames.get(prevIndex);
        if (prev && this.isFramePresentOnCalculator(prev)) {
          this.setFrameVisible(prev, false);
        }
      }

      const active = this.loadedFrames.get(nextIndex);
      if (active && this.isFramePresentOnCalculator(active)) {
        this.setFrameVisible(active, true);
      }
    } finally {
      this.syncing = false;
    }
  }
}

/** 从旧版全量注入状态迁移到窗口化播放 */
export async function migrateCalculatorToWindowedPlayback(
  calculator: any,
  archive: GifFrameArchive,
  sliderVar = GIF_TIME_SLIDER,
): Promise<GifWindowedPlaybackManager> {
  const state = calculator.getState?.();
  const list = state?.expressions?.list ?? [];
  const removeIds: string[] = [];

  for (const expr of list) {
    const id = String(expr?.id || '');
    if (parseGifFrameIndexFromId(id) != null) removeIds.push(id);
  }

  for (const id of removeIds) {
    try {
      calculator.removeExpression({ id });
    } catch {
      /* ignore */
    }
  }

  const manager = new GifWindowedPlaybackManager(archive);
  manager.attach(calculator, sliderVar, 0);
  return manager;
}

let activeManager: GifWindowedPlaybackManager | null = null;

export function attachGifWindowedPlayback(
  calculator: any,
  manager: GifWindowedPlaybackManager,
  sliderVar = GIF_TIME_SLIDER,
  initialIndex = 0,
  fromGeneration = false,
): void {
  if (activeManager && activeManager !== manager) {
    activeManager.detach();
  }
  activeManager = manager;
  if (fromGeneration) {
    manager.transitionToPlayback(initialIndex);
  } else {
    manager.attach(calculator, sliderVar, initialIndex);
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

/** @deprecated 兼容旧调用 */
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
