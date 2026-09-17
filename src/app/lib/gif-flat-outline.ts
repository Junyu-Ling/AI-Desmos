/**
 * GIF 轮廓合并：把所有帧的折线点列拼成扁平列表，只用下标切出当前帧那一段。
 *
 * 为什么要这么做：
 * 逐帧写一条折线时，画板上同时存在「帧数 × 轮廓数」条表达式。虽然非当前帧被
 * 门控成 undefined，Desmos 每次重绘仍要把每条表达式的点列整个走一遍，开销是
 * O(整段动画)；帧一多，拖滑块就是秒级卡顿。
 *
 * 合并后每次重绘只做一次列表切片，开销降到 O(当前帧)，与总帧数无关。
 */

/** Desmos 列表上限 10000，留点余量 */
const MAX_CHUNK_ELEMENTS = 9000;

/** 轮廓之间插一个 undefined 断点，折线才不会把两条轮廓连起来 */
const UNDEFINED_ELEMENT = '\\frac{0}{0}';

/** 帧在本块内没有数据时的哨兵区间：下标 0 不存在，切出来画不出线段 */
const EMPTY_START = 1;
const EMPTY_END = 0;

export const FLAT_OUTLINE_FOLDER_ID = 'gif_flat_outline';

export type FlatOutlineSourceFrame = {
  index: number;
  expressions: any[];
};

export type FlatOutlineBuildResult = {
  /** 合并后的表达式（含帧下标变量、点列、折线） */
  expressions: any[];
  /** 被取代的逐帧折线 id，注入前要先从画板删掉 */
  replacedIds: string[];
  chunkCount: number;
};

const formatSeconds = (sec: number): string => {
  const rounded = Math.round(sec * 10000) / 10000;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
};

type OutlineSegment = {
  frame: number;
  x: string[];
  y: string[];
};

type OutlineStream = {
  color: string;
  lineWidth: number;
  segments: OutlineSegment[];
};

const readOutlinePoints = (expr: any): { x: string[]; y: string[] } | null => {
  const data = expr?.gifOutline;
  if (!data) return null;
  const { x, y } = data;
  if (!Array.isArray(x) || !Array.isArray(y)) return null;
  if (x.length < 2 || x.length !== y.length) return null;
  return { x: x.map(String), y: y.map(String) };
};

/**
 * 按颜色分组收集所有帧的折线点列。
 * 一条 Desmos 折线只有一个颜色，所以颜色不同必须分到不同的列表里。
 */
const collectStreams = (
  frames: FlatOutlineSourceFrame[],
): { streams: OutlineStream[]; replacedIds: string[] } => {
  const byKey = new Map<string, OutlineStream>();
  const replacedIds: string[] = [];

  for (const frame of frames) {
    for (const expr of frame.expressions) {
      const points = readOutlinePoints(expr);
      if (!points) continue;
      const id = String(expr?.id || '');
      if (id) replacedIds.push(id);

      const color = String(expr?.color ?? '#000000');
      const lineWidth = Number.isFinite(Number(expr?.lineWidth)) ? Number(expr.lineWidth) : 2;
      const key = `${color}|${lineWidth}`;
      let stream = byKey.get(key);
      if (!stream) {
        stream = { color, lineWidth, segments: [] };
        byKey.set(key, stream);
      }
      stream.segments.push({ frame: frame.index, x: points.x, y: points.y });
    }
  }

  return { streams: [...byKey.values()], replacedIds };
};

/**
 * 把逐帧折线合并成「扁平点列 + 按帧切片」。
 *
 * 生成的表达式（每块 5 行）：
 *   X_{gq} = [...]            当前块所有帧的 x 坐标（含断点）
 *   Y_{gq} = [...]            y 坐标
 *   O_{gq} = [...]            第 i 帧在本块内的起始下标（本块没有该帧则为 1）
 *   E_{gq} = [...]            第 i 帧的结束下标（本块没有该帧则为 0，配合起始 1 切出空段）
 *   (X_{gq}[[O..E]], Y_{gq}[[O..E]])   只画当前帧那一段
 *
 * 另有一行共享的帧下标 N_{g} = round(s / 帧间隔)。
 *
 * @returns null 表示没有可合并的折线（例如整段都走了参数曲线回退路径）
 */
export function buildFlatGifOutlineExpressions(
  frames: FlatOutlineSourceFrame[],
  options: {
    sliderVar: string;
    /** 时间轴总格数，查表列表长度取这个值 */
    frameCount: number;
    frameIntervalSec: number;
  },
): FlatOutlineBuildResult | null {
  const { frameCount, frameIntervalSec, sliderVar } = options;
  if (frameCount <= 0 || !(frameIntervalSec > 0)) return null;

  const { streams, replacedIds } = collectStreams(frames);
  if (streams.length === 0 || replacedIds.length === 0) return null;

  const frameIndexVar = 'N_{g}';
  const expressions: any[] = [{
    id: 'gif_flat_n',
    latex: `${frameIndexVar}=\\operatorname{max}\\left(0,\\operatorname{min}\\left(${
      frameCount - 1
    },\\operatorname{round}\\left(\\frac{${sliderVar}}{${formatSeconds(frameIntervalSec)}}\\right)\\right)\\right)`,
    hidden: true,
  }];

  let chunkOrdinal = 0;

  for (const stream of streams) {
    let xs: string[] = [];
    let ys: string[] = [];
    let starts: number[] = new Array(frameCount).fill(EMPTY_START);
    let ends: number[] = new Array(frameCount).fill(EMPTY_END);

    const flushChunk = () => {
      if (xs.length === 0) return;
      const q = chunkOrdinal++;
      const range = `\\left[O_{g${q}}\\left[${frameIndexVar}+1\\right]...E_{g${q}}\\left[${frameIndexVar}+1\\right]\\right]`;

      expressions.push(
        { id: `gif_flat_x_${q}`, latex: `X_{g${q}}=\\left[${xs.join(',')}\\right]`, hidden: true },
        { id: `gif_flat_y_${q}`, latex: `Y_{g${q}}=\\left[${ys.join(',')}\\right]`, hidden: true },
        { id: `gif_flat_o_${q}`, latex: `O_{g${q}}=\\left[${starts.join(',')}\\right]`, hidden: true },
        { id: `gif_flat_e_${q}`, latex: `E_{g${q}}=\\left[${ends.join(',')}\\right]`, hidden: true },
        {
          id: `gif_flat_plot_${q}`,
          latex: `\\left(X_{g${q}}\\left[${range}\\right],Y_{g${q}}\\left[${range}\\right]\\right)`,
          color: stream.color,
          lines: true,
          points: false,
          lineWidth: stream.lineWidth,
          lineOpacity: 1,
          hidden: false,
        },
      );

      xs = [];
      ys = [];
      starts = new Array(frameCount).fill(EMPTY_START);
      ends = new Array(frameCount).fill(EMPTY_END);
    };

    for (const seg of stream.segments) {
      if (seg.frame < 0 || seg.frame >= frameCount) continue;
      // 一条轮廓绝不跨块，否则切片会把它切断
      if (xs.length > 0 && xs.length + seg.x.length + 1 > MAX_CHUNK_ELEMENTS) flushChunk();

      const segStart = xs.length + 1;
      xs.push(UNDEFINED_ELEMENT);
      ys.push(UNDEFINED_ELEMENT);
      for (let i = 0; i < seg.x.length; i++) {
        xs.push(seg.x[i]);
        ys.push(seg.y[i]);
      }
      // 同一帧的多条轮廓在块内连续，起点只记第一条
      if (ends[seg.frame] === EMPTY_END) starts[seg.frame] = segStart;
      ends[seg.frame] = xs.length;
    }

    flushChunk();
  }

  if (chunkOrdinal === 0) return null;

  return { expressions, replacedIds, chunkCount: chunkOrdinal };
}
