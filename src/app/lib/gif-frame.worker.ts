/**
 * GIF 单帧处理 Worker：与单图相同的傅里叶/填色表达式生成（不降级）
 */
import {
  generateFourierExpressionsFromContext,
  SINGLE_IMAGE_MAX_FILL_POLYGONS,
} from './image-processing';
import {
  analyzeImageHeuristically,
  applyLocalImageRepair,
  mergeSmartDrawTuning,
  prepareSmartDrawFromAiResult,
  type SmartDrawAIContour,
  type SmartDrawMode,
  type SmartDrawTuningParams,
} from './smart-draw-repair';
import { GIF_TIME_SLIDER } from './gif-quality';

export type GifFrameWorkerInput = {
  taskId: string;
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  mode: SmartDrawMode;
  tuning?: SmartDrawTuningParams | Partial<SmartDrawTuningParams>;
  aiContours?: SmartDrawAIContour[];
  /** 填色用原图像素（默认同 pixels） */
  fillPixels?: Uint8ClampedArray;
  frameSlot: number;
  timeStartSec: number;
  timeEndSec: number;
  gifIsLastFrame?: boolean;
  /** 主线程已执行 applyLocalImageRepair */
  alreadyRepaired?: boolean;
  /** 使用 AI 结果在 Worker 内完成本地修复（主线程不再重复 prepare） */
  useAiPrepare?: boolean;
  /** 播放管理器负责可见性，省略 latex 时间限制 */
  skipFrameRestriction?: boolean;
  maxFillPolygons?: number;
  outlineStyle?: import('./smart-draw-repair').OutlineStyle;
  fillDetailMode?: 'row' | 'merged' | 'cell';
  compactFourier?: boolean;
};

export type GifFrameWorkerOutput = {
  taskId: string;
  expressions: any[];
  error?: string;
};

self.onmessage = (event: MessageEvent<GifFrameWorkerInput>) => {
  const msg = event.data;
  try {
    const canvas = new OffscreenCanvas(msg.width, msg.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Worker canvas unavailable');

    const imageData = new ImageData(new Uint8ClampedArray(msg.pixels), msg.width, msg.height);
    ctx.putImageData(imageData, 0, 0);

    let tuning: SmartDrawTuningParams;
    let aiContours: SmartDrawAIContour[] = msg.aiContours ?? [];

    if (msg.useAiPrepare) {
      const prepared = prepareSmartDrawFromAiResult(
        ctx as unknown as CanvasRenderingContext2D,
        msg.width,
        msg.height,
        msg.mode,
        msg.tuning || aiContours.length
          ? {
              tuning: (msg.tuning ?? {}) as Partial<SmartDrawTuningParams>,
              contours: aiContours,
            }
          : null,
      );
      tuning = prepared.tuning;
      aiContours = prepared.aiContours;
    } else if (!msg.alreadyRepaired) {
      tuning = mergeSmartDrawTuning({
        ...analyzeImageHeuristically(
          ctx as unknown as CanvasRenderingContext2D,
          msg.width,
          msg.height,
          msg.mode,
        ),
        ...(msg.tuning ?? {}),
      });
      applyLocalImageRepair(
        ctx as unknown as CanvasRenderingContext2D,
        msg.width,
        msg.height,
        tuning,
      );
    } else {
      tuning = mergeSmartDrawTuning(msg.tuning ?? {});
    }

    const fillImageData = msg.fillPixels
      ? new ImageData(msg.fillPixels, msg.width, msg.height)
      : new ImageData(new Uint8ClampedArray(msg.pixels), msg.width, msg.height);

    const { expressions } = generateFourierExpressionsFromContext(
      ctx as unknown as CanvasRenderingContext2D,
      msg.width,
      msg.height,
      {
        mode: msg.mode,
        tuning,
        aiContours,
        fillImageData,
        maxFillPolygons: msg.maxFillPolygons ?? 480,
        varNamespace: msg.frameSlot,
        frameSlot: msg.frameSlot,
        frameSliderVar: GIF_TIME_SLIDER,
        gifTimeBasedSlider: true,
        gifTimeStart: msg.timeStartSec,
        gifTimeEnd: msg.timeEndSec,
        gifIsLastFrame: msg.gifIsLastFrame,
        idPrefix: `gif_f${msg.frameSlot}_`,
        outlineStyle: msg.outlineStyle,
        skipFrameRestriction: msg.skipFrameRestriction ?? true,
        fillDetailMode: msg.fillDetailMode ?? 'merged',
        compactFourier: msg.compactFourier ?? true,
      },
    );

    self.postMessage({ taskId: msg.taskId, expressions } satisfies GifFrameWorkerOutput);
  } catch (err) {
    self.postMessage({
      taskId: msg.taskId,
      expressions: [],
      error: err instanceof Error ? err.message : String(err),
    } satisfies GifFrameWorkerOutput);
  }
};
