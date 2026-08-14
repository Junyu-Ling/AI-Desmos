/**
 * GIF 全帧滑块播放：
 * - 每一帧写入画板，收进折叠文件夹，辅助公式 secret（列表不暴涨）
 * - 同时只显示当前帧文件夹，拖动滑块 s 换帧（Desmos 不会同时画全部帧）
 * - 自动播放按帧时长推进 s；用户一拖滑块就停，不再抢控制权
 */
import { GIF_TIME_SLIDER, GIF_SLIDER_STEP } from './gif-quality';
import {
  GifFrameArchive,
  type GifFrameVisibilitySet,
  type StoredGifFrame,
} from './gif-frame-archive';
import { appendGifFrameToCalculator, updateGifStreamDuration } from './image-processing';

export type { GifFrameVisibilitySet } from './gif-frame-archive';
export { classifyGifFrameExpressionIds } from './gif-frame-archive';

const SLIDER_DEBOUNCE_MS = 30;
const MIN_FRAME_HOLD_MS = 50;

const formatSliderTime = (sec: number): string => {
  const rounded = Math.round(sec * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '');
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const gifFolderId = (frameIndex: number): string => `gif_folder_${frameIndex + 1}`;

export type GifPlaybackAttachOptions = {
  onInjectProgress?: (done: number, total: number) => void;
  autoplay?: boolean;
};

export class GifWindowedPlaybackManager {
  private loadedFrames = new Map<number, StoredGifFrame>();
  private knownIds = new Set<string>(['gif_time_slider']);
  private calculator: any = null;
  private sliderVar = GIF_TIME_SLIDER;
  private sliderHelper: any = null;
  private followLatestDuringGeneration = true;
  private injectAbort = false;
  private injectChain = Promise.resolve();
  private playing = false;
  private playToken = 0;
  private syncingSlider = false;
  private lastSetTime = 0;
  private visibleIndex = -1;
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

  /** 生成阶段：小批次写入该帧文件夹，只点亮最新帧 */
  onFrameArchived(index: number): void {
    if (!this.calculator || this.injectAbort) return;
    const frame = this.archive.get(index);
    if (!frame || this.loadedFrames.has(index)) return;

    this.injectChain = this.injectChain
      .catch(() => undefined)
      .then(async () => {
        if (!this.calculator || this.injectAbort) return;
        if (this.loadedFrames.has(index)) return;

        const folderId = gifFolderId(index);
        await appendGifFrameToCalculator(
          this.calculator,
          frame.expressions.map(expr => ({ ...expr })),
          {
            appendOnly: true,
            knownIds: this.knownIds,
            folderId,
            folderTitle: `帧 ${index + 1}`,
            folderHidden: true,
          },
        );
        this.loadedFrames.set(index, frame);
        this.knownIds.add(folderId);

        updateGifStreamDuration(
          this.calculator,
          frame.timeEnd,
          this.sliderVar,
          GIF_SLIDER_STEP,
          this.followLatestDuringGeneration ? frame.timeStart : undefined,
        );

        if (this.followLatestDuringGeneration) {
          this.setSliderTime(frame.timeStart);
          this.showFolder(index);
        }
      });
  }

  attachForGeneration(calculator: any, sliderVar = GIF_TIME_SLIDER): void {
    if (this.calculator && this.calculator !== calculator) {
      this.detach();
    }
    this.injectAbort = false;
    this.calculator = calculator;
    this.sliderVar = sliderVar;
    this.followLatestDuringGeneration = true;
    this.knownIds = new Set(['gif_time_slider']);
  }

  async transitionToPlayback(
    initialIndex = 0,
    options: GifPlaybackAttachOptions = {},
  ): Promise<void> {
    this.injectAbort = false;
    this.followLatestDuringGeneration = false;
    await this.injectChain.catch(() => undefined);

    for (const frame of this.archive.getOrderedFrames()) {
      if (this.loadedFrames.has(frame.index)) continue;
      if (!this.calculator || this.injectAbort) break;
      const folderId = gifFolderId(frame.index);
      await appendGifFrameToCalculator(
        this.calculator,
        frame.expressions.map(expr => ({ ...expr })),
        {
          appendOnly: true,
          knownIds: this.knownIds,
          folderId,
          folderTitle: `帧 ${frame.index + 1}`,
          folderHidden: true,
        },
      );
      this.loadedFrames.set(frame.index, frame);
      this.knownIds.add(folderId);
      options.onInjectProgress?.(this.loadedFrames.size, this.archive.size);
    }

    options.onInjectProgress?.(this.archive.size, this.archive.size);
    this.resetSliderToFrame(initialIndex);
    this.showFolder(initialIndex);
    this.bindSliderObserver();

    if (options.autoplay !== false) {
      this.startAutoplay();
    }
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
    void this.transitionToPlayback(initialIndex, options);
  }

  /** 按每帧真实时长推进 s；不每秒刷 60 次，避免卡死滑块 */
  startAutoplay(): void {
    const frames = this.archive.getOrderedFrames();
    if (!this.calculator || frames.length === 0) return;

    const token = ++this.playToken;
    this.playing = true;

    const loop = async () => {
      let i = Math.max(0, frames.findIndex(f => f.index === this.visibleIndex));
      if (i < 0) i = 0;

      while (this.playing && token === this.playToken && !this.injectAbort && this.calculator) {
        const live = this.archive.getOrderedFrames();
        if (live.length === 0) break;
        if (i >= live.length) i = 0;
        const frame = live[i];

        this.setSliderTime(frame.timeStart);
        this.showFolder(frame.index);

        const holdMs = Math.max(
          MIN_FRAME_HOLD_MS,
          Math.round((frame.timeEnd - frame.timeStart) * 1000),
        );
        await sleep(holdMs);
        if (!this.playing || token !== this.playToken) break;
        i = (i + 1) % live.length;
      }
    };

    void loop();
  }

  stopAutoplay(): void {
    this.playing = false;
    this.playToken += 1;
  }

  detach(): void {
    this.stopAutoplay();
    this.injectAbort = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.unbindSliderObserver();
    this.calculator = null;
    this.loadedFrames.clear();
    this.knownIds = new Set(['gif_time_slider']);
    this.injectChain = Promise.resolve();
    this.followLatestDuringGeneration = true;
    this.visibleIndex = -1;
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
          if (this.followLatestDuringGeneration) return;
          const value = this.sliderHelper?.numericValue;
          if (this.syncingSlider) return;
          if (Number.isFinite(value) && Math.abs(value - this.lastSetTime) < 0.015) return;
          this.stopAutoplay();
          this.scheduleShowFromSlider();
        });
        return;
      } catch {
        this.sliderHelper = null;
      }
    }

    if (typeof this.calculator.observeEvent === 'function') {
      this.calculator.observeEvent('change', () => {
        if (this.syncingSlider || this.followLatestDuringGeneration) return;
        const value = this.readSliderValue();
        if (Math.abs(value - this.lastSetTime) < 0.015) return;
        this.stopAutoplay();
        this.scheduleShowFromSlider();
      });
    }
  }

  private scheduleShowFromSlider(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const index = this.findFrameIndex(this.readSliderValue());
      if (index >= 0) this.showFolder(index);
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

  /** 只切换文件夹 hidden，一次 setExpression，滑块跟手 */
  private showFolder(index: number): void {
    if (!this.calculator || index < 0 || index === this.visibleIndex) return;
    const prev = this.visibleIndex;
    this.visibleIndex = index;
    try {
      if (prev >= 0) {
        this.calculator.setExpression({
          id: gifFolderId(prev),
          type: 'folder',
          hidden: true,
          collapsed: true,
        });
      }
      this.calculator.setExpression({
        id: gifFolderId(index),
        type: 'folder',
        hidden: false,
        collapsed: true,
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
    } catch {
      /* ignore */
    }
    window.setTimeout(() => {
      this.syncingSlider = false;
    }, 40);
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
    requestAnimationFrame(() => {
      this.syncingSlider = false;
    });
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
    await manager.transitionToPlayback(initialIndex, { autoplay: true, ...options });
  } else {
    manager.attach(calculator, sliderVar, initialIndex, { autoplay: true, ...options });
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
