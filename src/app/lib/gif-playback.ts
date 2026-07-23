/**
 * GIF 播放优化：仅让当前时间轴帧的表达式可见，其余 hidden，避免 Desmos 同时渲染全部帧。
 */
import { GIF_TIME_SLIDER } from './gif-quality';

export type GifFrameVisibilitySet = {
  timeStart: number;
  timeEnd: number;
  visibleIds: string[];
  auxIds: string[];
};

const isFillId = (id: string) => /(?:^|_)fill_poly_\d+$/.test(id);
const isPlotId = (id: string) => /(?:^|_)dft_plot_\d+$/.test(id) || /(?:^|_)hd_plot_\d+$/.test(id);

/** 从单帧表达式中拆分「需显示」与「辅助（始终隐藏）」id */
export function classifyGifFrameExpressionIds(expressions: any[]): Omit<GifFrameVisibilitySet, 'timeStart' | 'timeEnd'> {
  const visibleIds: string[] = [];
  const auxIds: string[] = [];

  for (const expr of expressions) {
    const id = String(expr?.id || '');
    if (!id || id === 'gif_time_slider' || id === 'gif_frame_slider') continue;
    if (isFillId(id) || isPlotId(id)) visibleIds.push(id);
    else auxIds.push(id);
  }

  return { visibleIds, auxIds };
}

export class GifPlaybackManager {
  private frames: GifFrameVisibilitySet[] = [];
  private activeIndex = -1;
  private calculator: any = null;
  private sliderVar = GIF_TIME_SLIDER;
  private raf = 0;
  private changeHandler: (() => void) | null = null;

  registerFrame(
    timeStart: number,
    timeEnd: number,
    ids: Omit<GifFrameVisibilitySet, 'timeStart' | 'timeEnd'>,
  ): void {
    this.frames.push({ timeStart, timeEnd, ...ids });
  }

  exportFrames(): GifFrameVisibilitySet[] {
    return this.frames.map(frame => ({
      timeStart: frame.timeStart,
      timeEnd: frame.timeEnd,
      visibleIds: [...frame.visibleIds],
      auxIds: [...frame.auxIds],
    }));
  }

  getFrameCount(): number {
    return this.frames.length;
  }

  attach(calculator: any, sliderVar = GIF_TIME_SLIDER): void {
    this.detach();
    this.calculator = calculator;
    this.sliderVar = sliderVar;
    this.activeIndex = -1;

    this.changeHandler = () => {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.syncVisibility();
      });
    };

    if (typeof calculator.observeEvent === 'function') {
      calculator.observeEvent('change', this.changeHandler);
    }
    this.syncVisibility(true);
  }

  detach(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.calculator && this.changeHandler && typeof this.calculator.unobserveEvent === 'function') {
      this.calculator.unobserveEvent('change', this.changeHandler);
    }
    this.changeHandler = null;
    this.calculator = null;
    this.activeIndex = -1;
    this.frames = [];
  }

  private readSliderValue(): number {
    if (!this.calculator?.getState) return 0;
    const state = this.calculator.getState();
    const list = state?.expressions?.list ?? state?.list ?? [];
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

  private findFrameIndex(timeSec: number): number {
    if (this.frames.length === 0) return -1;

    for (let i = 0; i < this.frames.length; i++) {
      const frame = this.frames[i];
      if (timeSec >= frame.timeStart && timeSec < frame.timeEnd) return i;
    }

    const last = this.frames.length - 1;
    if (timeSec >= this.frames[last].timeStart) return last;
    return 0;
  }

  private pushVisibilityUpdates(updates: Array<{ id: string; hidden: boolean }>): void {
    if (!this.calculator || updates.length === 0) return;

    const chunkSize = 120;
    for (let i = 0; i < updates.length; i += chunkSize) {
      const chunk = updates.slice(i, i + chunkSize);
      if (typeof this.calculator.setExpressions === 'function') {
        this.calculator.setExpressions(chunk);
      } else {
        chunk.forEach(expr => this.calculator.setExpression(expr));
      }
    }
  }

  private syncVisibility(force = false): void {
    if (!this.calculator || this.frames.length === 0) return;

    const nextIndex = this.findFrameIndex(this.readSliderValue());
    if (!force && nextIndex === this.activeIndex) return;

    const prevIndex = this.activeIndex;
    this.activeIndex = nextIndex;
    const updates: Array<{ id: string; hidden: boolean }> = [];

    if (prevIndex >= 0 && prevIndex !== nextIndex) {
      const prev = this.frames[prevIndex];
      for (const id of prev.visibleIds) updates.push({ id, hidden: true });
      for (const id of prev.auxIds) updates.push({ id, hidden: true });
    }

    if (nextIndex >= 0) {
      const next = this.frames[nextIndex];
      for (const id of next.visibleIds) updates.push({ id, hidden: false });
      for (const id of next.auxIds) updates.push({ id, hidden: true });
    }

    this.pushVisibilityUpdates(updates);
  }
}

let activePlayback: GifPlaybackManager | null = null;

export function getActivePlaybackSnapshot(): GifFrameVisibilitySet[] | null {
  if (!activePlayback) return null;
  const frames = activePlayback.exportFrames();
  return frames.length > 0 ? frames : null;
}

export function restoreGifPlaybackFromSnapshot(
  calculator: any,
  frames: GifFrameVisibilitySet[],
  sliderVar = GIF_TIME_SLIDER,
): void {
  if (!calculator || frames.length === 0) return;
  const manager = new GifPlaybackManager();
  for (const frame of frames) {
    manager.registerFrame(frame.timeStart, frame.timeEnd, {
      visibleIds: frame.visibleIds,
      auxIds: frame.auxIds,
    });
  }
  attachGifPlayback(calculator, manager, sliderVar);
}

export function attachGifPlayback(calculator: any, manager: GifPlaybackManager, sliderVar = GIF_TIME_SLIDER): void {
  activePlayback?.detach();
  activePlayback = manager;
  manager.attach(calculator, sliderVar);
}

export function detachGifPlayback(): void {
  activePlayback?.detach();
  activePlayback = null;
}
