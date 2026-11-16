/**
 * model-3d.ts — OBJ 网格解析 → Desmos 3D triangle 表达式
 *
 * 【v1 策略】
 * - 仅正式支持 OBJ（纯文本、浏览器可直接解析）
 * - GLB/GLTF 等格式给出明确提示，不静默失败
 * - 面片三角化后归一化到约 [-10,10]^3
 * - 用 Desmos 3D 的 triangle((x,y,z),...) 绘制；面片过多时均匀抽样
 * - 超大网格可回退为边线参数曲线，避免表达式爆炸卡死
 */

export type Vec3 = { x: number; y: number; z: number };

export type Mesh3D = {
  vertices: Vec3[];
  /** 三角面：每项为顶点下标（0-based）三元组 */
  triangles: [number, number, number][];
};

export type Desmos3DExpression = {
  id: string;
  latex?: string;
  color?: string;
  fillOpacity?: number;
  lineOpacity?: number;
  secret?: boolean;
  /** Desmos note 行 */
  type?: 'text' | 'expression';
  text?: string;
};

export type Model3DConvertResult = {
  expressions: Desmos3DExpression[];
  vertexCount: number;
  faceCount: number;
  triangleCount: number;
  renderedTriangles: number;
  renderedEdges: number;
  mode: 'triangles' | 'wireframe' | 'mixed';
  explanation: string;
  warning?: string;
};

/** 面片上限：过多时 Desmos 会明显卡顿 */
export const MAX_TRIANGLES = 500;
/** 线框边上限（回退模式） */
export const MAX_EDGES = 800;
/** 归一化目标半边长（约落在 [-10,10]） */
export const TARGET_HALF_EXTENT = 9;

const MESH_COLORS = [
  '#2d70b3',
  '#388c46',
  '#c74440',
  '#6042a6',
  '#fa7e19',
  '#000000',
];

const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return '0';
  const t = Math.round(n * 1e4) / 1e4;
  if (Object.is(t, -0)) return '0';
  return String(t);
};

const fmtPt = (p: Vec3): string =>
  `\\left(${fmt(p.x)},${fmt(p.y)},${fmt(p.z)}\\right)`;

export function isObjFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.obj') || file.type === 'model/obj' || file.type === 'text/plain';
}

export function unsupportedModelMessage(file: File): string | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.obj')) return null;
  if (
    name.endsWith('.glb') ||
    name.endsWith('.gltf') ||
    name.endsWith('.stl') ||
    name.endsWith('.fbx') ||
    name.endsWith('.ply')
  ) {
    return 'unsupported_3d_format';
  }
  return 'unsupported_3d_format';
}

/**
 * 解析 Wavefront OBJ（仅 v / f；忽略材质、法线、UV）
 * 顶点索引支持负索引；多边形用扇形三角化。
 */
export function parseObj(text: string): Mesh3D {
  const vertices: Vec3[] = [];
  const triangles: [number, number, number][] = [];

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('v ')) {
      const parts = line.slice(2).trim().split(/\s+/);
      if (parts.length < 3) continue;
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      const z = Number(parts[2]);
      if (![x, y, z].every(Number.isFinite)) continue;
      vertices.push({ x, y, z });
      continue;
    }

    if (line.startsWith('f ')) {
      const parts = line.slice(2).trim().split(/\s+/);
      const idxs: number[] = [];
      for (const part of parts) {
        // f 可用 v / v/vt / v/vt/vn / v//vn
        const token = part.split('/')[0];
        const n = Number(token);
        if (!Number.isFinite(n) || n === 0) continue;
        // OBJ 正索引从 1 开始；负索引相对当前顶点数
        const idx = n < 0 ? vertices.length + n : n - 1;
        if (idx < 0 || idx >= vertices.length) continue;
        idxs.push(idx);
      }
      if (idxs.length < 3) continue;
      // 扇形三角化： (0,i,i+1)
      for (let i = 1; i < idxs.length - 1; i++) {
        triangles.push([idxs[0], idxs[i], idxs[i + 1]]);
      }
    }
  }

  if (vertices.length === 0) {
    throw new Error('OBJ_NO_VERTICES');
  }
  if (triangles.length === 0) {
    throw new Error('OBJ_NO_FACES');
  }

  return { vertices, triangles };
}

/** 居中并等比缩放到目标包围盒 */
export function normalizeMesh(mesh: Mesh3D, halfExtent = TARGET_HALF_EXTENT): Mesh3D {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const v of mesh.vertices) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.z < minZ) minZ = v.z;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
    if (v.z > maxZ) maxZ = v.z;
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  const sx = maxX - minX || 1;
  const sy = maxY - minY || 1;
  const sz = maxZ - minZ || 1;
  const scale = (2 * halfExtent) / Math.max(sx, sy, sz);

  return {
    vertices: mesh.vertices.map(v => ({
      x: (v.x - cx) * scale,
      y: (v.y - cy) * scale,
      z: (v.z - cz) * scale,
    })),
    triangles: mesh.triangles.slice(),
  };
}

/** 均匀抽样，尽量保留整体外形 */
function sampleIndices(total: number, maxKeep: number): number[] {
  if (total <= maxKeep) {
    return Array.from({ length: total }, (_, i) => i);
  }
  const out: number[] = [];
  for (let i = 0; i < maxKeep; i++) {
    out.push(Math.floor((i * total) / maxKeep));
  }
  return out;
}

function uniqueEdges(triangles: [number, number, number][]): [number, number][] {
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  for (const [a, b, c] of triangles) {
    const triples: [number, number][] = [
      [a, b],
      [b, c],
      [c, a],
    ];
    for (const [u, v] of triples) {
      const lo = Math.min(u, v);
      const hi = Math.max(u, v);
      const key = `${lo}:${hi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([lo, hi]);
    }
  }
  return edges;
}

function triangleLatex(a: Vec3, b: Vec3, c: Vec3): string {
  return `\\operatorname{triangle}\\left(${fmtPt(a)},${fmtPt(b)},${fmtPt(c)}\\right)`;
}

/** 参数线段：(1-t)P + tQ，t∈[0,1] */
function edgeLatex(a: Vec3, b: Vec3): string {
  const lerp = (pa: number, pb: number) =>
    `\\left(1-t\\right)\\cdot${fmt(pa)}+t\\cdot${fmt(pb)}`;
  return `\\left(${lerp(a.x, b.x)},${lerp(a.y, b.y)},${lerp(a.z, b.z)}\\right)`;
}

const pushBatch = (calculator: any, chunk: Desmos3DExpression[]) => {
  if (!chunk.length || !calculator) return;
  if (typeof calculator.setExpressions === 'function') {
    calculator.setExpressions(chunk);
    return;
  }
  chunk.forEach(expr => calculator.setExpression(expr));
};

/**
 * 网格 → Desmos 3D 表达式
 * 优先 triangle 面片；过多则抽样；极端大网格改用边线框。
 */
export function meshToDesmos3D(
  meshIn: Mesh3D,
  options?: { maxTriangles?: number; maxEdges?: number; clearFirst?: boolean },
): Model3DConvertResult {
  const maxTriangles = options?.maxTriangles ?? MAX_TRIANGLES;
  const maxEdges = options?.maxEdges ?? MAX_EDGES;
  const mesh = normalizeMesh(meshIn);

  const expressions: Desmos3DExpression[] = [];
  let renderedTriangles = 0;
  let renderedEdges = 0;
  let mode: Model3DConvertResult['mode'] = 'triangles';
  let warning: string | undefined;

  const faceCount = mesh.triangles.length;
  const useWireframe = faceCount > maxTriangles * 3;

  if (useWireframe) {
    mode = 'wireframe';
    warning = 'model_3d_wireframe_fallback';
    const allEdges = uniqueEdges(mesh.triangles);
    const keep = sampleIndices(allEdges.length, maxEdges);
    for (let i = 0; i < keep.length; i++) {
      const [ia, ib] = allEdges[keep[i]];
      const a = mesh.vertices[ia];
      const b = mesh.vertices[ib];
      if (!a || !b) continue;
      expressions.push({
        id: `m3d_e_${i}`,
        latex: edgeLatex(a, b),
        color: MESH_COLORS[i % MESH_COLORS.length],
        lineOpacity: 0.85,
      });
      renderedEdges++;
    }
  } else {
    const keep = sampleIndices(faceCount, maxTriangles);
    if (keep.length < faceCount) {
      warning = 'model_3d_decimated';
      mode = 'mixed';
    }
    for (let i = 0; i < keep.length; i++) {
      const [ia, ib, ic] = mesh.triangles[keep[i]];
      const a = mesh.vertices[ia];
      const b = mesh.vertices[ib];
      const c = mesh.vertices[ic];
      if (!a || !b || !c) continue;
      expressions.push({
        id: `m3d_t_${i}`,
        latex: triangleLatex(a, b, c),
        color: MESH_COLORS[i % MESH_COLORS.length],
        fillOpacity: 0.55,
      });
      renderedTriangles++;
    }
  }

  const noteExpr: any = {
    id: 'm3d_note',
    type: 'text',
    text: `3D mesh · V${mesh.vertices.length} F${faceCount} → tri ${renderedTriangles} / edge ${renderedEdges}`,
  };

  return {
    expressions: [noteExpr, ...expressions],
    vertexCount: mesh.vertices.length,
    faceCount,
    triangleCount: faceCount,
    renderedTriangles,
    renderedEdges,
    mode,
    explanation: 'model_3d_complete',
    warning,
  };
}

/** 渐进写入，避免一次塞入过多表达式卡死主线程 */
export async function applyModel3DExpressionsProgressively(
  calculator: any,
  expressions: Desmos3DExpression[],
  options?: {
    clearFirst?: boolean;
    batchSize?: number;
    signal?: AbortSignal;
    onProgress?: (current: number, total: number) => void;
  },
): Promise<void> {
  if (!calculator || !expressions.length) return;
  const batchSize = options?.batchSize ?? 25;
  const signal = options?.signal;

  if (options?.clearFirst !== false) {
    calculator.setBlank?.();
  }

  for (let i = 0; i < expressions.length; i += batchSize) {
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    const chunk = expressions.slice(i, i + batchSize);
    pushBatch(calculator, chunk);
    options?.onProgress?.(Math.min(i + chunk.length, expressions.length), expressions.length);
    // 让出主线程，便于 UI 更新
    await new Promise<void>(r => setTimeout(r, 0));
  }
}

/** 从 File 读入并转换 */
export async function processObjFileToDesmos3D(
  file: File,
  options?: { maxTriangles?: number; maxEdges?: number },
): Promise<Model3DConvertResult> {
  const unsupported = unsupportedModelMessage(file);
  if (unsupported && !isObjFile(file)) {
    throw new Error(unsupported);
  }

  const text = await file.text();
  if (!text.trim()) {
    throw new Error('OBJ_EMPTY');
  }

  const mesh = parseObj(text);
  return meshToDesmos3D(mesh, options);
}
