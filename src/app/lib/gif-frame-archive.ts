/**
 * GIF 帧表达式归档：生成时写入内存，播放时按窗口注入 Desmos（画板内始终只有少量帧）。
 */

export type GifFrameVisibilitySet = {
  timeStart: number;
  timeEnd: number;
  visibleIds: string[];
  auxIds: string[];
};

const isFillId = (id: string) => /(?:^|_)fill_poly_\d+$/.test(id);
const isPlotId = (id: string) =>
  /(?:^|_)dft_plot_(?:hold_\d+_)?\d+$/.test(id) || /(?:^|_)hd_plot_\d+$/.test(id);

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

export type StoredGifFrame = {
  index: number;
  timeStart: number;
  timeEnd: number;
  expressions: any[];
  visibleIds: string[];
  auxIds: string[];
};

const FRAME_ID_RE = /^gif_f(\d+)_/;

export const parseGifFrameIndexFromId = (id: string): number | null => {
  const match = String(id).match(FRAME_ID_RE);
  if (!match) return null;
  return parseInt(match[1], 10) - 1;
};

export type SerializedGifArchive = {
  version: 1;
  frames: StoredGifFrame[];
};

export class GifFrameArchive {
  private frames = new Map<number, StoredGifFrame>();

  add(index: number, timeStart: number, timeEnd: number, expressions: any[]): void {
    if (expressions.length === 0) return;
    const cloned = expressions.map(expr => ({ ...expr }));
    const ids = classifyGifFrameExpressionIds(cloned);
    this.frames.set(index, {
      index,
      timeStart,
      timeEnd,
      expressions: cloned,
      visibleIds: ids.visibleIds,
      auxIds: ids.auxIds,
    });
  }

  /** 覆盖已有帧的表达式（用于补回跨帧闪掉的轮廓） */
  replace(index: number, expressions: any[]): void {
    const existing = this.frames.get(index);
    if (!existing) return;
    this.add(index, existing.timeStart, existing.timeEnd, expressions);
  }

  get(index: number): StoredGifFrame | undefined {
    return this.frames.get(index);
  }

  has(index: number): boolean {
    return this.frames.has(index);
  }

  get size(): number {
    return this.frames.size;
  }

  getFrameIndices(): number[] {
    return [...this.frames.keys()].sort((a, b) => a - b);
  }

  getOrderedFrames(): StoredGifFrame[] {
    return this.getFrameIndices().map(i => this.frames.get(i)!);
  }

  exportSnapshot(): SerializedGifArchive {
    return {
      version: 1,
      frames: this.getOrderedFrames(),
    };
  }

  static fromSnapshot(snapshot: SerializedGifArchive): GifFrameArchive {
    const archive = new GifFrameArchive();
    for (const frame of snapshot.frames) {
      archive.frames.set(frame.index, frame);
    }
    return archive;
  }

  /** 从画板状态中提取 GIF 帧（用于旧版全量注入数据的迁移） */
  static fromCalculatorState(state: any): GifFrameArchive {
    const archive = new GifFrameArchive();
    const list = state?.expressions?.list ?? state?.list ?? [];
    const grouped = new Map<number, any[]>();

    for (const expr of list) {
      const id = String(expr?.id || '');
      if (id === 'gif_time_slider' || id === 'gif_frame_slider') continue;
      const frameIndex = parseGifFrameIndexFromId(id);
      if (frameIndex == null) continue;
      if (!grouped.has(frameIndex)) grouped.set(frameIndex, []);
      grouped.get(frameIndex)!.push(expr);
    }

    const indices = [...grouped.keys()].sort((a, b) => a - b);
    for (const index of indices) {
      archive.add(index, 0, 0, grouped.get(index)!);
    }

    return archive;
  }
}

export const collectGifExpressionIds = (archive: GifFrameArchive): string[] => {
  const ids: string[] = [];
  for (const frame of archive.getOrderedFrames()) {
    ids.push(...frame.visibleIds, ...frame.auxIds);
  }
  return ids;
};
