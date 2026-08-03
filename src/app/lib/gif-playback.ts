/**
 * GIF 全量动画播放：生成阶段只归档；完成后将所有帧追加到画板，
 * 每帧表达式带时间域限制，滑块 s 控制显示哪一帧（不卸载、不覆盖）。
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
  private calculator: any = null;
  private sliderVar = GIF_TIME_SLIDER;
  private followLatestDuringGeneration = true;
  private allFramesInjected = false;
  private injectAbort = false;

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

  /** 生成阶段：仅更新滑块总时长，不向 Desmos 注入帧 */
  onFrameArchived(_index: number): void {
    if (!this.calculator || !this.followLatestDuringGeneration) return;
    const ordered = this.archive.getOrderedFrames();
    const last = ordered[ordered.length - 1];
    if (last) {
      updateGifStreamDuration(this.calculator, last.timeEnd, this.sliderVar);
    }
  }

  /** 生成阶段：仅挂载 calculator 引用 */
  attachForGeneration(calculator: any, sliderVar = GIF_TIME_SLIDER): void {
    if (this.calculator !== calculator) {
      this.detach();
    }
    this.calculator = calculator;
    this.sliderVar = sliderVar;
    this.allFramesInjected = false;
    this.followLatestDuringGeneration = true;
  }

  /** 生成完成 → 将全部帧追加到画板，滑块 s 按时间域切换可见帧 */
  async transitionToPlayback(
    initialIndex = 0,
    options: GifPlaybackAttachOptions = {},
  ): Promise<void> {
    this.followLatestDuringGeneration = false;
    this.resetSliderToFrame(initialIndex);
    await this.injectAllFrames(options);
  }

  attach(
    calculator: any,
    sliderVar = GIF_TIME_SLIDER,
    initialIndex = 0,
    options: GifPlaybackAttachOptions = {},
  ): void {
    if (this.calculator !== calculator) {
      this.detach();
      this.calculator = calculator;
    }
    this.sliderVar = sliderVar;
    this.followLatestDuringGeneration = false;
    this.resetSliderToFrame(initialIndex);
    void this.injectAllFrames(options);
  }

  detach(): void {
    this.injectAbort = true;
    this.clearLoadedFramesFromCalculator();
    this.calculator = null;
    this.allFramesInjected = false;
    this.followLatestDuringGeneration = true;
  }

  private clearLoadedFramesFromCalculator(): void {
    if (this.calculator) {
      for (const idx of [...this.loadedFrames.keys()]) {
        this.unloadFrame(idx);
      }
    }
    this.loadedFrames.clear();
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
    return frame.visibleIds.every(id => ids.has(id));
  }

  private async injectFrame(frame: StoredGifFrame): Promise<boolean> {
    if (!this.calculator || this.injectAbort) return false;
    if (this.isFramePresentOnCalculator(frame)) {
      this.loadedFrames.set(frame.index, frame);
      return false;
    }
    const expressions = frame.expressions.map(expr => ({ ...expr }));
    await appendGifFrameToCalculator(this.calculator, expressions, {
      fastInject: false,
      appendOnly: true,
    });
    this.loadedFrames.set(frame.index, frame);
    return true;
  }

  private unloadFrame(index: number): void {
    const frame = this.loadedFrames.get(index);
    if (!frame || !this.calculator) return;
    removeExpressionIds(this.calculator, [...frame.visibleIds, ...frame.auxIds]);
    this.loadedFrames.delete(index);
  }

  /** 逐帧追加全部表达式；Desmos 时间域自动切换可见帧 */
  async injectAllFrames(options: GifPlaybackAttachOptions = {}): Promise<void> {
    if (!this.calculator || this.archive.size === 0) return;
    if (this.allFramesInjected) return;

    this.injectAbort = false;
    const frames = this.archive.getOrderedFrames();
    const total = frames.length;
    let injected = 0;

    for (const frame of frames) {
      if (this.injectAbort) break;
      const added = await this.injectFrame(frame);
      if (added) injected += 1;
      options.onInjectProgress?.(injected, total);
    }

    this.allFramesInjected = !this.injectAbort;
  }
}

/** 从旧版全量注入状态迁移到归档播放 */
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
