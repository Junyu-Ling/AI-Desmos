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
  /** 完整 tuning（来自 prepareSmartDrawImage，不截断） */
  tuning: SmartDrawTuningParams;
  aiContours: SmartDrawAIContour[];
  /** 填色用原图像素（1:1 取色，未经修复） */
  fillPixels?: Uint8ClampedArray;
  frameSlot: number;
  timeStartSec: number;
  timeEndSec: number;
  /** 主线程已执行 applyLocalImageRepair */
  alreadyRepaired?: boolean;
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

    const imageData = new ImageData(msg.pixels, msg.width, msg.height);
    ctx.putImageData(imageData, 0, 0);

    let tuning = msg.tuning;
    if (!msg.alreadyRepaired) {
      tuning = mergeSmartDrawTuning({
        ...analyzeImageHeuristically(ctx as unknown as CanvasRenderingContext2D, msg.width, msg.height, msg.mode),
        ...msg.tuning,
      });
      applyLocalImageRepair(ctx as unknown as CanvasRenderingContext2D, msg.width, msg.height, tuning);
    }

    const fillSource = msg.fillPixels ?? msg.pixels;
    const fillImageData = msg.fillPixels
      ? new ImageData(msg.fillPixels, msg.width, msg.height)
      : imageData;

    const { expressions } = generateFourierExpressionsFromContext(
      ctx as unknown as CanvasRenderingContext2D,
      msg.width,
      msg.height,
      {
        mode: msg.mode,
        tuning,
        aiContours: msg.aiContours,
        fillImageData,
        maxFillPolygons: SINGLE_IMAGE_MAX_FILL_POLYGONS,
        varNamespace: msg.frameSlot,
        frameSlot: msg.frameSlot,
        frameSliderVar: GIF_TIME_SLIDER,
        gifTimeBasedSlider: true,
        gifTimeStart: msg.timeStartSec,
        gifTimeEnd: msg.timeEndSec,
        idPrefix: `gif_f${msg.frameSlot}_`,
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
