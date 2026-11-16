/**
 * desmos-3d-lists.ts — Desmos 3D「列表网格」编码 + 状态注入
 *
 * 思想借鉴（The Meadow / Colormap Canyon 两张 Desmos 3D 作品）：
 *   · 不再「一个三角形 = 一条表达式」。把整张网格存成顶点列表 V 与索引列表 A/B/C，
 *     只用一条 triangle(V[A],V[B],V[C]) 一次画出上万个三角形（The Meadow 的岩石就是 V[F[i]] 写法）。
 *   · 颜色用整数列表打包 (r·65536+g·256+b)，再由 rgb(floor(Q/65536),mod(floor(Q/256),256),mod(Q,256))
 *     解包成与三角形一一对应的颜色列表，并通过 colorLatex 赋给表达式 → 逐面精确上色。
 *   · 参数曲面的 u/v 区间走 parametricDomain3Du/v，而不是 {…} 限制式。
 *
 * 实测结论（Desmos API v1.13，无头渲染验证）：
 *   · 单条表达式内的列表上限 10000 个元素 → 每块 ≤ 9500 个三角形 / ≤ 9800 个顶点。
 *   · colorLatex 必须经 calculator.setState 写入；setExpression(s) 会丢弃该字段。
 *   · 着色器（colormap）里的列表查表上限约 100 个元素，所以不能拿它做大纹理——
 *     逐面颜色列表才是高精度上色的正解。
 */

export type Vec3 = { x: number; y: number; z: number };

export type Desmos3DExpression = {
  id: string;
  latex?: string;
  /** 十六进制主色（单色表达式用） */
  color?: string;
  /** 变量名 / 列表名：逐元素颜色（需 setState 注入） */
  colorLatex?: string;
  fillOpacity?: number | string;
  lineOpacity?: number | string;
  /** 兼容旧字段 */
  secret?: boolean;
  /** 在侧栏与画布中隐藏（列表/变量定义使用） */
  hidden?: boolean;
  type?: 'text' | 'expression';
  text?: string;
  /** 参数曲面 u、v 区间（LaTeX 字符串） */
  parametricDomain3Du?: { min: string; max: string };
  parametricDomain3Dv?: { min: string; max: string };
};

export type ListMeshChunk = {
  V: Vec3[];
  /** 1-based 顶点索引（与 Desmos 列表下标一致） */
  A: number[];
  B: number[];
  C: number[];
  /** 每三角面打包颜色 r*65536+g*256+b */
  Q: number[];
};

/** Desmos 列表元素上限 10000，留出余量 */
export const LIST_MAX_TRIANGLES = 9500;
export const LIST_MAX_VERTICES = 9800;

const fmt = (n: number, digits = 3): string => {
  if (!Number.isFinite(n)) return '0';
  const k = 10 ** digits;
  const t = Math.round(n * k) / k;
  if (Object.is(t, -0)) return '0';
  return String(t);
};

export const packRgb = (r: number, g: number, b: number): number =>
  (Math.max(0, Math.min(255, Math.round(r))) << 16) |
  (Math.max(0, Math.min(255, Math.round(g))) << 8) |
  Math.max(0, Math.min(255, Math.round(b)));

export const hexToPacked = (hex: string | null | undefined, fallback: number): number => {
  if (!hex) return fallback;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  return parseInt(m[1], 16);
};

export const packedToHex = (q: number): string => `#${(q & 0xffffff).toString(16).padStart(6, '0')}`;

const lst = (items: Array<string | number>): string => `\\left[${items.join(',')}\\right]`;

/** 近邻 Morton 码，用于让同一块里的三角形空间上聚拢 → 每块顶点更少 */
const part1by2 = (n: number): number => {
  let x = n & 0x3ff;
  x = (x | (x << 16)) & 0x030000ff;
  x = (x | (x << 8)) & 0x0300f00f;
  x = (x | (x << 4)) & 0x030c30c3;
  x = (x | (x << 2)) & 0x09249249;
  return x;
};

/**
 * 三角网格 → 若干个满足列表上限的块
 * @param positions 顶点 xyz（3n）
 * @param faces     三角形索引（0-based，3m）
 * @param faceColor 每面打包颜色（m）
 */
export function buildListChunks(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  faceColor: ArrayLike<number>,
): ListMeshChunk[] {
  const m = Math.floor(faces.length / 3);
  if (m === 0) return [];

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const sx = 1023 / (maxX - minX || 1);
  const sy = 1023 / (maxY - minY || 1);
  const sz = 1023 / (maxZ - minZ || 1);

  const order = new Array<number>(m);
  const codes = new Float64Array(m);
  for (let f = 0; f < m; f++) {
    order[f] = f;
    const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
    const cx = (positions[a] + positions[b] + positions[c]) / 3;
    const cy = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
    const cz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
    codes[f] =
      part1by2(Math.floor((cx - minX) * sx)) |
      (part1by2(Math.floor((cy - minY) * sy)) << 1) |
      (part1by2(Math.floor((cz - minZ) * sz)) << 2);
  }
  order.sort((p, q) => codes[p] - codes[q]);

  const chunks: ListMeshChunk[] = [];
  let cur: ListMeshChunk = { V: [], A: [], B: [], C: [], Q: [] };
  let map = new Map<number, number>();

  const flush = () => {
    if (cur.A.length) chunks.push(cur);
    cur = { V: [], A: [], B: [], C: [], Q: [] };
    map = new Map();
  };

  const vid = (src: number): number => {
    let id = map.get(src);
    if (id === undefined) {
      cur.V.push({
        x: positions[src * 3],
        y: positions[src * 3 + 1],
        z: positions[src * 3 + 2],
      });
      id = cur.V.length; // 1-based
      map.set(src, id);
    }
    return id;
  };

  for (const f of order) {
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    // 本三角形最坏新增 3 个顶点
    if (cur.A.length >= LIST_MAX_TRIANGLES || cur.V.length + 3 > LIST_MAX_VERTICES) flush();
    cur.A.push(vid(a));
    cur.B.push(vid(b));
    cur.C.push(vid(c));
    cur.Q.push(faceColor[f] & 0xffffff);
  }
  flush();
  return chunks;
}

/**
 * 竖立物体的默认观察矩阵（写入 graph.worldRotation3D）。
 * 实测约定：数组 a 满足 相机方向 D = −(a0,a3,a6)，屏幕右 = −(a1,a4,a7)，屏幕上 = (a2,a5,a8)。
 * 相机从 −y 侧看向 +y（物体正面朝 −y），再向 +x 偏 azimuth°、抬高 elevation°，保留一点立体感。
 */
export function uprightViewMatrix(azimuthDeg = 24, elevationDeg = 16): number[] {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const D = [Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)];
  const cross = (p: number[], q: number[]) => [
    p[1] * q[2] - p[2] * q[1],
    p[2] * q[0] - p[0] * q[2],
    p[0] * q[1] - p[1] * q[0],
  ];
  const rt0 = cross([0, 0, 1], D);
  const rl = Math.hypot(rt0[0], rt0[1], rt0[2]) || 1;
  const Rt = rt0.map(v => v / rl);
  const U = cross(D, Rt);
  return [-D[0], -Rt[0], U[0], -D[1], -Rt[1], U[1], -D[2], -Rt[2], U[2]];
}

/** 随机 3 字母标签，避免多次导入时变量重名 */
export function randomTag(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 3; i++) s += letters[Math.floor(Math.random() * 26)];
  return s;
}

/** 一块网格 → Desmos 表达式（隐藏列表 + 1 条可见 triangle 表达式） */
export function chunkToExpressions(
  chunk: ListMeshChunk,
  tag: string,
  idPrefix: string,
): Desmos3DExpression[] {
  const out: Desmos3DExpression[] = [];
  const pt = (p: Vec3) => `\\left(${fmt(p.x)},${fmt(p.y)},${fmt(p.z)}\\right)`;
  out.push({ id: `${idPrefix}_V`, latex: `V_{${tag}}=${lst(chunk.V.map(pt))}`, hidden: true });
  out.push({ id: `${idPrefix}_A`, latex: `A_{${tag}}=${lst(chunk.A)}`, hidden: true });
  out.push({ id: `${idPrefix}_B`, latex: `B_{${tag}}=${lst(chunk.B)}`, hidden: true });
  out.push({ id: `${idPrefix}_C`, latex: `D_{${tag}}=${lst(chunk.C)}`, hidden: true });

  const unique = new Set(chunk.Q);
  const tri = `\\operatorname{triangle}\\left(V_{${tag}}\\left[A_{${tag}}\\right],V_{${tag}}\\left[B_{${tag}}\\right],V_{${tag}}\\left[D_{${tag}}\\right]\\right)`;

  if (unique.size === 1) {
    out.push({
      id: `${idPrefix}_T`,
      latex: tri,
      color: packedToHex(chunk.Q[0]),
      fillOpacity: 1,
    });
    return out;
  }

  out.push({ id: `${idPrefix}_Q`, latex: `Q_{${tag}}=${lst(chunk.Q)}`, hidden: true });
  out.push({
    id: `${idPrefix}_K`,
    latex:
      `K_{${tag}}=\\operatorname{rgb}\\left(\\operatorname{floor}\\left(Q_{${tag}}/65536\\right),` +
      `\\operatorname{mod}\\left(\\operatorname{floor}\\left(Q_{${tag}}/256\\right),256\\right),` +
      `\\operatorname{mod}\\left(Q_{${tag}},256\\right)\\right)`,
    hidden: true,
  });
  out.push({
    id: `${idPrefix}_T`,
    latex: tri,
    color: packedToHex(chunk.Q[0]),
    colorLatex: `K_{${tag}}`,
    fillOpacity: 1,
  });
  return out;
}

/** 完整网格 → 表达式（自动分块） */
export function meshToListExpressions(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  faceColor: ArrayLike<number>,
  idPrefix = 'm3d',
): { expressions: Desmos3DExpression[]; chunkCount: number; triangleCount: number; colorCount: number } {
  const chunks = buildListChunks(positions, faces, faceColor);
  const base = randomTag();
  const expressions: Desmos3DExpression[] = [];
  const colors = new Set<number>();
  let triangleCount = 0;
  chunks.forEach((chunk, k) => {
    const tag = `${base}${String.fromCharCode(97 + (k % 26))}${k >= 26 ? String.fromCharCode(97 + Math.floor(k / 26)) : ''}`;
    expressions.push(...chunkToExpressions(chunk, tag, `${idPrefix}${k}`));
    triangleCount += chunk.A.length;
    for (const q of chunk.Q) colors.add(q);
  });
  return { expressions, chunkCount: chunks.length, triangleCount, colorCount: colors.size };
}

// ─── 注入 ────────────────────────────────────────────────────────────────────

const numStr = (v: number | string | undefined): string | undefined =>
  v === undefined ? undefined : String(v);

/** 本项目表达式 → Desmos 状态表达式 */
function toStateExpression(expr: Desmos3DExpression): Record<string, unknown> {
  if (expr.type === 'text') {
    return { type: 'text', id: expr.id, text: expr.text ?? '' };
  }
  const out: Record<string, unknown> = { type: 'expression', id: expr.id };
  if (expr.latex !== undefined) out.latex = expr.latex;
  if (expr.color) out.color = expr.color;
  if (expr.colorLatex) out.colorLatex = expr.colorLatex;
  if (expr.hidden || expr.secret) out.hidden = true;
  const fo = numStr(expr.fillOpacity);
  if (fo !== undefined) out.fillOpacity = fo;
  const lo = numStr(expr.lineOpacity);
  if (lo !== undefined) out.lineOpacity = lo;
  if (expr.parametricDomain3Du) out.parametricDomain3Du = expr.parametricDomain3Du;
  if (expr.parametricDomain3Dv) out.parametricDomain3Dv = expr.parametricDomain3Dv;
  return out;
}

function legacySetExpression(calculator: any, chunk: Desmos3DExpression[]) {
  const plain = chunk.map(e => {
    const { colorLatex: _c, parametricDomain3Du: _u, parametricDomain3Dv: _v, hidden, ...rest } = e as any;
    return { ...rest, secret: hidden || rest.secret };
  });
  if (typeof calculator.setExpressions === 'function') calculator.setExpressions(plain);
  else plain.forEach(e => calculator.setExpression(e));
}

/**
 * 渐进写入 3D 表达式。
 * 走 getState / setState，因为 colorLatex、parametricDomain3D* 只有状态注入才会生效。
 * 每批默认 7 条（刚好一个网格块），批间让出主线程。
 */
export async function applyDesmos3DExpressions(
  calculator: any,
  expressions: Desmos3DExpression[],
  options?: {
    clearFirst?: boolean;
    batchSize?: number;
    signal?: AbortSignal;
    onProgress?: (current: number, total: number) => void;
    /**
     * 清空画板时把可视范围设为 ±viewportHalf（默认 12）。
     * 模型被归一到 ±9，Desmos 默认只显示 ±5，不放大范围会被裁切面切掉。0 = 不改。
     */
    viewportHalf?: number;
    /** 清空画板时把相机转到正面略带俯视角（默认 true）；false 保持用户当前视角 */
    uprightCamera?: boolean;
  },
): Promise<void> {
  if (!calculator || !expressions.length) return;
  const batchSize = Math.max(1, options?.batchSize ?? 7);
  const signal = options?.signal;
  const canState = typeof calculator.getState === 'function' && typeof calculator.setState === 'function';

  if (options?.clearFirst !== false) {
    if (canState) {
      try {
        const st = calculator.getState();
        st.expressions = { ...(st.expressions || {}), list: [] };
        const half = options?.viewportHalf ?? 12;
        if (half > 0) {
          st.graph = {
            ...(st.graph || {}),
            viewport: { xmin: -half, xmax: half, ymin: -half, ymax: half, zmin: -half, zmax: half },
            // v1.13 在 setState 时以这份 LaTeX 字符串为准，不同步就会被改回 ±5
            __v12ViewportLatexStash: {
              xmin: String(-half), xmax: String(half),
              ymin: String(-half), ymax: String(half),
              zmin: String(-half), zmax: String(half),
            },
          };
        }
        if (options?.uprightCamera !== false) {
          st.graph = { ...(st.graph || {}), worldRotation3D: uprightViewMatrix() };
        }
        calculator.setState(st);
      } catch {
        calculator.setBlank?.();
      }
    } else {
      calculator.setBlank?.();
    }
  }

  for (let i = 0; i < expressions.length; i += batchSize) {
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    const chunk = expressions.slice(i, i + batchSize);
    if (canState) {
      const st = calculator.getState();
      const list: any[] = (st.expressions && st.expressions.list) || [];
      for (const e of chunk) {
        const idx = list.findIndex(x => x.id === e.id);
        const se = toStateExpression(e);
        if (idx >= 0) list[idx] = se;
        else list.push(se);
      }
      st.expressions = { ...(st.expressions || {}), list };
      calculator.setState(st);
    } else {
      legacySetExpression(calculator, chunk);
    }
    options?.onProgress?.(Math.min(i + chunk.length, expressions.length), expressions.length);
    await new Promise<void>(r => setTimeout(r, 16));
  }
}
