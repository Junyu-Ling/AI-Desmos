/**
 * GIF 全帧写入：每一帧公式都留在画板上（折叠文件夹），
 * 用定义域 {t0 ≤ s < t1} 换帧，上一帧不会叠成一团。
 */
import { GIF_TIME_SLIDER, GIF_SLIDER_STEP, formatGifSliderStep } from './gif-quality';
import {
  GifFrameArchive,
  type GifFrameVisibilitySet,
  type StoredGifFrame,
} from './gif-frame-archive';
import { appendGifFrameToCalculator, updateGifStreamDuration } from './image-processing';

export type { GifFrameVisibilitySet } from './gif-frame-archive';
export { classifyGifFrameExpressionIds } from './gif-frame-archive';

const formatSliderTime = (sec: number): string => {
  const rounded = Math.round(sec * 10000) / 10000;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
};

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
  /** 步长 = 一帧时长，拖一格换一帧 */
  private sliderStep = GIF_SLIDER_STEP;
  private followLatestDuringGeneration = true;
  private injectAbort = false;
  private injectChain = Promise.resolve();
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
    if (!this.calculator || this.injectAbort) return;
    const frame = this.archive.get(index);
    if (!frame || this.loadedFrames.has(index)) return;

    this.injectChain = this.injectChain
      .catch(() => undefined)
      .then(async () => {
        if (!this.calculator || this.injectAbort) return;
        if (this.loadedFrames.has(index)) return;
        await this.injectFrame(frame);
        if (this.followLatestDuringGeneration) {
          updateGifStreamDuration(
            this.calculator,
            frame.timeStart,
            this.sliderVar,
            this.sliderStep,
            frame.timeStart,
          );
          this.setSliderTime(frame.timeStart);
        }
      });
  }

  attachForGeneration(
    calculator: any,
    sliderVar = GIF_TIME_SLIDER,
    sliderStep = GIF_SLIDER_STEP,
  ): void {
    if (this.calculator && this.calculator !== calculator) this.detach();
    this.injectAbort = false;
    this.calculator = calculator;
    this.sliderVar = sliderVar;
    this.sliderStep = sliderStep;
    this.followLatestDuringGeneration = true;
    this.generating = true;
    this.knownIds = new Set(['gif_time_slider']);
  }

  async transitionToPlayback(
    initialIndex = 0,
    options: GifPlaybackAttachOptions = {},
  ): Promise<void> {
    this.injectAbort = false;
    this.followLatestDuringGeneration = false;
    this.generating = false;
    await this.injectChain.catch(() => undefined);

    for (const frame of this.archive.getOrderedFrames()) {
      if (this.loadedFrames.has(frame.index)) continue;
      if (!this.calculator || this.injectAbort) break;
      await this.injectFrame(frame);
      options.onInjectProgress?.(this.loadedFrames.size, this.archive.size);
    }

    options.onInjectProgress?.(this.archive.size, this.archive.size);
    this.resetSliderToFrame(initialIndex);
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
    this.syncSliderStepFromArchive();
    for (const frame of this.archive.getOrderedFrames()) {
      this.loadedFrames.set(frame.index, frame);
      this.knownIds.add(gifFolderId(frame.index));
    }
  }

  startAutoplay(): void {}
  stopAutoplay(): void {}

  detach(): void {
    this.injectAbort = true;
    this.calculator = null;
    this.loadedFrames.clear();
    this.knownIds = new Set(['gif_time_slider']);
    this.injectChain = Promise.resolve();
    this.followLatestDuringGeneration = true;
    this.generating = false;
  }

  private async injectFrame(frame: StoredGifFrame): Promise<void> {
    if (!this.calculator || this.injectAbort) return;
    const folderId = gifFolderId(frame.index);
    await appendGifFrameToCalculator(
      this.calculator,
      frame.expressions.map(expr => ({ ...expr })),
      {
        appendOnly: true,
        knownIds: this.knownIds,
        folderId,
        folderTitle: `帧 ${frame.index + 1}`,
        folderHidden: false,
      },
    );
    this.loadedFrames.set(frame.index, frame);
    this.knownIds.add(folderId);
  }

  private setSliderTime(timeSec: number): void {
    if (!this.calculator) return;
    try {
      this.calculator.setExpression({
        id: 'gif_time_slider',
        latex: `${this.sliderVar}=${formatSliderTime(timeSec)}`,
      });
    } catch { /* ignore */ }
  }

  /** 归档里每帧跨度就是帧间隔，据此恢复「一格一帧」的步长 */
  private syncSliderStepFromArchive(): void {
    const ordered = this.archive.getOrderedFrames();
    const sample = ordered.find(frame => frame.timeEnd > frame.timeStart);
    if (!sample) return;
    this.sliderStep = formatGifSliderStep(sample.timeEnd - sample.timeStart);
  }

  private resetSliderToFrame(frameIndex: number): void {
    if (!this.calculator) return;
    this.syncSliderStepFromArchive();
    const frame = this.archive.get(frameIndex);
    const time = frame?.timeStart ?? 0;
    const ordered = this.archive.getOrderedFrames();
    const last = ordered[ordered.length - 1];
    const sliderMax = last?.timeStart ?? Math.max(time, 0.1);
    updateGifStreamDuration(this.calculator, sliderMax, this.sliderVar, this.sliderStep, time);
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
