/**
 * GIF 单帧处理 Worker：本地修复 + 傅里叶/填色表达式生成（并行加速）
 */
import { generateFourierExpressionsFromContext } from './image-processing';
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
  aiTuning?: Partial<SmartDrawTuningParams>;
  aiContours: SmartDrawAIContour[];
  limits: {
    maxContours: number;
    maxFillPolygons: number;
    fourierK: number;
    targetPointCount: number;
  };
  frameSlot: number;
  timeStartSec: number;
  timeEndSec: number;
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
    const fillImageData = new ImageData(new Uint8ClampedArray(msg.pixels), msg.width, msg.height);

    let tuning: SmartDrawTuningParams;
    const base = analyzeImageHeuristically(ctx, msg.width, msg.height, msg.mode);
    tuning = mergeSmartDrawTuning({
      ...base,
      ...msg.aiTuning,
      maxContours: msg.limits.maxContours,
      fourierK: msg.limits.fourierK,
      targetPointCount: msg.limits.targetPointCount,
      preserveFineDetails: true,
    });

    applyLocalImageRepair(ctx, msg.width, msg.height, tuning);

    const { expressions } = generateFourierExpressionsFromContext(
      ctx as unknown as CanvasRenderingContext2D,
      msg.width,
      msg.height,
      {
        mode: msg.mode,
        tuning,
        aiContours: msg.aiContours,
        fillImageData,
        maxFillPolygons: msg.limits.maxFillPolygons,
        varNamespace: msg.frameSlot,
        frameSlot: msg.frameSlot,
        frameSliderVar: GIF_TIME_SLIDER,
        gifTimeBasedSlider: true,
        gifTimeStart: msg.timeStartSec,
        gifTimeEnd: msg.timeEndSec,
        idPrefix: `gif_f${msg.frameSlot}_`,
      },
    );

    const output: GifFrameWorkerOutput = { taskId: msg.taskId, expressions };
    self.postMessage(output);
  } catch (err) {
    const output: GifFrameWorkerOutput = {
      taskId: msg.taskId,
      expressions: [],
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(output);
  }
};
