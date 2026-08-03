/**
 * GIF 全帧滑块播放：
 * - 每一帧都写入画板，带时间限制 {t0 ≤ s < t1}
 * - 拖动 / 自动推进滑块 s，由 Desmos 原生显隐换帧
 * - 不再按需 purge（用户要滑块，显卡可全力跑）
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

const formatSliderTime = (sec: number): string => {
  const rounded = Math.round(sec * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '');
};

export type GifPlaybackAttachOptions = {
  onInjectProgress?: (done: number, total: number) => void;
  autoplay?: boolean;
};

export class GifWindowedPlaybackManager {
  private loadedFrames = new Map<number, StoredGifFrame>();
  private calculator: any = null;
  private sliderVar = GIF_TIME_SLIDER;
  private followLatestDuringGeneration = true;
  private injectAbort = false;
  private injectChain = Promise.resolve();
  private playing = false;
  private playToken = 0;
  private playRaf = 0;
  private playStartedAt = 0;
  private playDuration = 0.1;

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

  /** 生成阶段：追加写入该帧（带时间限制），滑块跟到最新帧预览 */
  onFrameArchived(index: number): void {
    if (!this.calculator || this.injectAbort) return;
    const frame = this.archive.get(index);
    if (!frame || this.loadedFrames.has(index)) return;

    this.injectChain = this.injectChain
      .catch(() => undefined)
      .then(async () => {
        if (!this.calculator || this.injectAbort) return;
        if (this.loadedFrames.has(index)) return;

        await appendGifFrameToCalculator(
          this.calculator,
          frame.expressions.map(expr => ({ ...expr })),
          { fastInject: true, appendOnly: true },
        );
        this.loadedFrames.set(index, frame);

        updateGifStreamDuration(
          this.calculator,
          frame.timeEnd,
          this.sliderVar,
          GIF_SLIDER_STEP,
          this.followLatestDuringGeneration ? frame.timeStart : undefined,
        );
        if (this.followLatestDuringGeneration) {
          this.setSliderTime(frame.timeStart);
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
  }

  /** 全帧已在画板：只复位滑块并自动推进 s */
  async transitionToPlayback(
    initialIndex = 0,
    options: GifPlaybackAttachOptions = {},
  ): Promise<void> {
    this.injectAbort = false;
    this.followLatestDuringGeneration = false;
    await this.injectChain.catch(() => undefined);

    // 补写生成期未注入成功的帧
    for (const frame of this.archive.getOrderedFrames()) {
      if (this.loadedFrames.has(frame.index)) continue;
      if (!this.calculator || this.injectAbort) break;
      await appendGifFrameToCalculator(
        this.calculator,
        frame.expressions.map(expr => ({ ...expr })),
        { fastInject: true, appendOnly: true },
      );
      this.loadedFrames.set(frame.index, frame);
      options.onInjectProgress?.(this.loadedFrames.size, this.archive.size);
    }

    options.onInjectProgress?.(this.archive.size, this.archive.size);
    this.resetSliderToFrame(initialIndex);

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

  /** 只推动滑块 s；各帧靠时间限制显隐，不再 purge/换注 */
  startAutoplay(): void {
    const frames = this.archive.getOrderedFrames();
    if (!this.calculator || frames.length === 0) return;

    const last = frames[frames.length - 1];
    this.playDuration = Math.max(0.1, last.timeEnd);
    this.playStartedAt = performance.now();
    const token = ++this.playToken;
    this.playing = true;

    const tick = () => {
      if (!this.playing || token !== this.playToken || !this.calculator) return;
      const elapsed = (performance.now() - this.playStartedAt) / 1000;
      const t = elapsed % this.playDuration;
      this.setSliderTime(t);
      this.playRaf = requestAnimationFrame(tick);
    };

    if (this.playRaf) cancelAnimationFrame(this.playRaf);
    this.playRaf = requestAnimationFrame(tick);
  }

  stopAutoplay(): void {
    this.playing = false;
    this.playToken += 1;
    if (this.playRaf) {
      cancelAnimationFrame(this.playRaf);
      this.playRaf = 0;
    }
  }

  detach(): void {
    this.stopAutoplay();
    this.injectAbort = true;
    this.calculator = null;
    this.loadedFrames.clear();
    this.injectChain = Promise.resolve();
    this.followLatestDuringGeneration = true;
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
    updateGifStreamDuration(this.calculator, duration, this.sliderVar, GIF_SLIDER_STEP, time);
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
