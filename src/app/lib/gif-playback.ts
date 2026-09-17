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
import { appendGifFrameToCalculator, updateGifStreamDuration, yieldQuick } from './image-processing';
import { buildFlatGifOutlineExpressions, FLAT_OUTLINE_FOLDER_ID } from './gif-flat-outline';

export type { GifFrameVisibilitySet } from './gif-frame-archive';
export { classifyGifFrameExpressionIds } from './gif-frame-archive';

const formatSliderTime = (sec: number): string => {
  const rounded = Math.round(sec * 10000) / 10000;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
};

export const gifFolderId = (frameIndex: number): string => `gif_folder_${frameIndex + 1}`;

/** 生成过程中反复覆写的轮廓预览行 */
const LIVE_OUTLINE_ID_PREFIX = 'gif_live_plot_';

export type GifPlaybackAttachOptions = {
  onInjectProgress?: (done: number, total: number) => void;
  autoplay?: boolean;
};

export class GifWindowedPlaybackManager {
  private loadedFrames = new Map<number, StoredGifFrame>();
  private knownIds = new Set<string>(['gif_time_slider']);
  private livePreviewIds = new Set<string>();
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
    this.livePreviewIds = new Set();
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
    await this.consolidateOutlines();
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
    this.livePreviewIds = new Set();
    this.knownIds = new Set(['gif_time_slider']);
    this.injectChain = Promise.resolve();
    this.followLatestDuringGeneration = true;
    this.generating = false;
  }

  private async injectFrame(frame: StoredGifFrame): Promise<void> {
    if (!this.calculator || this.injectAbort) return;

    // 带点列元数据的折线最后会被合并成扁平列表，这里不逐帧写进画板：
    // 写进去要几十秒，转播放时又得全部删掉，纯属白做。
    const merged: any[] = [];
    const kept: any[] = [];
    for (const expr of frame.expressions) {
      if (expr?.gifOutline) merged.push({ ...expr });
      else kept.push({ ...expr });
    }

    if (kept.length > 0 || merged.length === 0) {
      const folderId = gifFolderId(frame.index);
      await appendGifFrameToCalculator(
        this.calculator,
        kept.length > 0 ? kept : frame.expressions.map(expr => ({ ...expr })),
        {
          appendOnly: true,
          knownIds: this.knownIds,
          folderId,
          folderTitle: `帧 ${frame.index + 1}`,
          folderHidden: false,
        },
      );
      this.knownIds.add(folderId);
    }

    // 生成过程中滑块始终跟着最新一帧，所以只需要把这一帧的轮廓画出来
    if (this.generating && merged.length > 0) this.showLiveOutline(merged);

    this.loadedFrames.set(frame.index, frame);
  }

  /**
   * 生成过程中的轮廓预览：固定一组 id 反复覆写，画板上不会越堆越多。
   * 每次先删再写，让这些折线落到表达式列表末尾，才不会被后写入的色块盖住。
   */
  private showLiveOutline(outlines: any[]): void {
    const calculator = this.calculator;
    if (!calculator) return;

    const batch = outlines.map((expr, i) => {
      const next = { ...expr, id: `${LIVE_OUTLINE_ID_PREFIX}${i}` };
      delete next.gifOutline;
      return next;
    });
    const nextIds = new Set(batch.map(expr => expr.id));

    // 连同上一帧多出来的行一起删净：既清掉残留，又让重写的折线落到列表末尾
    for (const id of new Set([...this.livePreviewIds, ...nextIds])) {
      if (typeof calculator.removeExpression === 'function') calculator.removeExpression({ id });
      this.knownIds.delete(id);
    }

    if (batch.length > 0 && typeof calculator.setExpressions === 'function') {
      calculator.setExpressions(batch);
      for (const id of nextIds) this.knownIds.add(id);
    }
    this.livePreviewIds = nextIds;
  }

  private clearLiveOutline(): void {
    const calculator = this.calculator;
    if (!calculator) return;
    for (const id of this.livePreviewIds) {
      if (typeof calculator.removeExpression === 'function') calculator.removeExpression({ id });
      this.knownIds.delete(id);
    }
    this.livePreviewIds = new Set();
  }

  /**
   * 把逐帧折线换成「全帧扁平点列 + 按帧切片」。
   *
   * 逐帧折线在生成过程里方便边出边看，但播放时每次重绘都要遍历所有帧的点列。
   * 全部帧到齐后合并一次，重绘开销就只和当前帧有关了。
   *
   * 放在所有帧注入之后：合并折线会追加到表达式列表末尾，才能盖在各帧色块之上。
   */
  private async consolidateOutlines(): Promise<void> {
    if (!this.calculator || this.injectAbort) return;

    const frames = this.archive.getOrderedFrames();
    if (frames.length === 0) return;

    const interval = frames.find(frame => frame.timeEnd > frame.timeStart);
    if (!interval) return;

    this.clearLiveOutline();

    const built = buildFlatGifOutlineExpressions(
      frames.map(frame => ({ index: frame.index, expressions: frame.expressions })),
      {
        sliderVar: this.sliderVar,
        frameCount: frames[frames.length - 1].index + 1,
        frameIntervalSec: interval.timeEnd - interval.timeStart,
      },
    );
    if (!built) return;

    // 正常路径下这些逐帧折线根本没写进画板，只有旧图迁移过来才需要真的删
    await this.removeExpressionIds(built.replacedIds.filter(id => this.knownIds.has(id)));
    if (!this.calculator || this.injectAbort) return;

    await appendGifFrameToCalculator(
      this.calculator,
      built.expressions,
      {
        appendOnly: true,
        knownIds: this.knownIds,
        folderId: FLAT_OUTLINE_FOLDER_ID,
        folderTitle: '轮廓（全帧合并）',
        folderHidden: false,
      },
    );
    this.knownIds.add(FLAT_OUTLINE_FOLDER_ID);
  }

  private async removeExpressionIds(ids: string[]): Promise<void> {
    const calculator = this.calculator;
    if (!calculator || ids.length === 0) return;
    const batch = 200;
    for (let i = 0; i < ids.length; i += batch) {
      if (this.injectAbort) return;
      const slice = ids.slice(i, i + batch).map(id => ({ id }));
      if (typeof calculator.removeExpressions === 'function') {
        calculator.removeExpressions(slice);
      } else if (typeof calculator.removeExpression === 'function') {
        slice.forEach((expr: { id: string }) => calculator.removeExpression(expr));
      }
      for (const expr of slice) this.knownIds.delete(expr.id);
      await yieldQuick();
    }
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
