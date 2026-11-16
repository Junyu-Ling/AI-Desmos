/**
 * model-3d.ts — OBJ(+MTL) 高保真网格 → Desmos Calculator3D 表达式
 *
 * 借鉴 The Meadow / Colormap Canyon 两张 Desmos 3D 作品的做法，不再「一个三角形一条表达式」：
 *
 *   1) 检测到球 / 柱 / 盒 → 直接输出解析原语（sphere、参数曲面 (cx+r·cos u, cy+r·sin u, cz+v)…），
 *      u、v 区间走 parametricDomain3Du/v。
 *   2) 其余网格 → 焊接重合顶点 → QEM 二次误差边折叠（保形、保轮廓、保色）→
 *      整张网格编码成顶点列表 V + 索引列表 A/B/D + 逐面颜色列表，
 *      每块用一条 triangle(V[A],V[B],V[D]) 画出至多 1000 个三角形。
 *   3) 通过 calculator.setState 注入（colorLatex 只有状态注入才生效）。
 *
 * 精度：旧版 2800 条独立三角形（直接丢面、会开洞）→ 现在最多 30000 个折叠后的着色三角形（按 1000 面/块自动分块），
 *       表达式数量从数千条降到约 7·块数。
 */

import {
  applyDesmos3DExpressions,
  hexToPacked,
  meshToListExpressions,
  type Desmos3DExpression,
} from './desmos-3d-lists';
import { simplifyMesh } from './mesh-simplify';
import {
  buildTexturedTriangles,
  loadTextureImages,
  parseMtlTextures,
  isImageFile,
  type TextureImage,
  type TextureMap,
} from './obj-texture';

export type { Desmos3DExpression } from './desmos-3d-lists';
export type Vec3 = { x: number; y: number; z: number };

export type Mesh3D = {
  vertices: Vec3[];
  /** 每顶点可选 RGB（0–1 或 0–255，解析时统一到 0–1） */
  vertexColors?: Array<{ r: number; g: number; b: number } | null>;
  triangles: [number, number, number][];
  /** 每三角面颜色（#rrggbb）；缺省时由顶点色/材质回退 */
  faceColors?: (string | null)[];
  /** vt 表（OBJ 的 vt u v） */
  uvs?: Array<[number, number]>;
  /** 每三角面三个角的 vt 下标（-1 = 无） */
  triangleUV?: Array<[number, number, number]>;
  /** 每三角面的材质名 */
  faceMaterials?: (string | null)[];
  /** 材质名 → 贴图键（来自 MTL 的 map_Kd） */
  materialTextures?: Map<string, string>;
};

export type Model3DConvertResult = {
  expressions: Desmos3DExpression[];
  vertexCount: number;
  faceCount: number;
  triangleCount: number;
  renderedTriangles: number;
  renderedEdges: number;
  analyticCount: number;
  mode: 'triangles' | 'wireframe' | 'mixed' | 'analytic' | 'hybrid';
  explanation: string;
  warning?: string;
  colorSource: 'vertex' | 'mtl' | 'none' | 'mixed' | 'texture';
};

/** 三角形预算：只是安全阀（每块 ≤ 1000 面，自动分块）。小于它的模型原样保留，不做减面 */
export const MAX_TRIANGLES = 30000;
/** 兼容旧导出（已不再使用线框回退） */
export const MAX_EDGES = 0;
export const TARGET_HALF_EXTENT = 9;
export const WIREFRAME_FACE_THRESHOLD = Number.POSITIVE_INFINITY;


const DEFAULT_MESH_COLOR = '#2d70b3';

const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return '0';
  const t = Math.round(n * 1e4) / 1e4;
  if (Object.is(t, -0)) return '0';
  return String(t);
};

const fmtPt = (p: Vec3): string =>
  `\\left(${fmt(p.x)},${fmt(p.y)},${fmt(p.z)}\\right)`;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

const rgbToHex = (r: number, g: number, b: number): string => {
  const to = (v: number) => {
    const n = Math.round(clamp01(v) * 255);
    return n.toString(16).padStart(2, '0');
  };
  return `#${to(r)}${to(g)}${to(b)}`;
};

const parseRgbTriplet = (parts: string[], start: number): { r: number; g: number; b: number } | null => {
  if (parts.length < start + 3) return null;
  let r = Number(parts[start]);
  let g = Number(parts[start + 1]);
  let b = Number(parts[start + 2]);
  if (![r, g, b].every(Number.isFinite)) return null;
  // OBJ 顶点色常见 0–1；若任一 >1 则按 0–255
  if (r > 1 || g > 1 || b > 1) {
    r /= 255;
    g /= 255;
    b /= 255;
  }
  return { r: clamp01(r), g: clamp01(g), b: clamp01(b) };
};

export function isObjFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.obj') || file.type === 'model/obj' || file.type === 'text/plain';
}

export function isMtlFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.mtl');
}

export function unsupportedModelMessage(file: File): string | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.obj') || name.endsWith('.mtl')) return null;
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

export type MtlLibrary = Map<string, string>;

/** 解析 Wavefront MTL：取 newmtl + Kd 漫反射色 */
export function parseMtl(text: string): MtlLibrary {
  const map: MtlLibrary = new Map();
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.toLowerCase().startsWith('newmtl ')) {
      current = line.slice(7).trim();
      if (current && !map.has(current)) map.set(current, DEFAULT_MESH_COLOR);
      continue;
    }
    if (!current) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith('kd ')) {
      const parts = line.slice(3).trim().split(/\s+/);
      const rgb = parseRgbTriplet(parts, 0);
      if (rgb) map.set(current, rgbToHex(rgb.r, rgb.g, rgb.b));
    }
  }
  return map;
}

/**
 * 解析 Wavefront OBJ
 * - v x y z [r g b]
 * - usemtl / mtllib（mtllib 名仅记录；颜色靠外部 MTL）
 * - f 扇形三角化
 */
export function parseObj(
  text: string,
  materials?: MtlLibrary,
  materialTextures?: Map<string, string>,
): Mesh3D & { mtllibNames: string[] } {
  const vertices: Vec3[] = [];
  const vertexColors: Array<{ r: number; g: number; b: number } | null> = [];
  const triangles: [number, number, number][] = [];
  const faceColors: (string | null)[] = [];
  const uvs: Array<[number, number]> = [];
  const triangleUV: Array<[number, number, number]> = [];
  const faceMaterials: (string | null)[] = [];
  let activeMaterial: string | null = null;
  const mtllibNames: string[] = [];
  let activeColor: string | null = null;
  let sawVertexColor = false;
  let sawMtlColor = false;

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.toLowerCase().startsWith('mtllib ')) {
      const name = line.slice(7).trim();
      if (name) mtllibNames.push(name);
      continue;
    }

    if (line.toLowerCase().startsWith('usemtl ')) {
      const name = line.slice(7).trim();
      activeMaterial = name;
      if (materials?.has(name)) {
        activeColor = materials.get(name)!;
        sawMtlColor = true;
      } else if (materials) {
        // 给了 MTL 却找不到该材质：用材质名哈希出稳定色以区分部件
        activeColor = hashNameToColor(name);
        sawMtlColor = true;
      } else {
        // 没有 MTL：材质名无法还原真实颜色，随机哈希色只会显得「古怪」→ 统一用默认色
        activeColor = null;
      }
      continue;
    }

    if (line.startsWith('vt ')) {
      const parts = line.slice(3).trim().split(/\s+/);
      const u = Number(parts[0]), v = Number(parts[1] ?? 0);
      uvs.push([Number.isFinite(u) ? u : 0, Number.isFinite(v) ? v : 0]);
      continue;
    }

    if (line.startsWith('v ')) {
      const parts = line.slice(2).trim().split(/\s+/);
      if (parts.length < 3) continue;
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      const z = Number(parts[2]);
      if (![x, y, z].every(Number.isFinite)) continue;
      vertices.push({ x, y, z });
      // v x y z r g b  （部分导出器；跳过可选 w）
      let rgb: { r: number; g: number; b: number } | null = null;
      if (parts.length >= 6) {
        const start = parts.length >= 7 ? 4 : 3;
        rgb = parseRgbTriplet(parts, start);
      }
      if (rgb) sawVertexColor = true;
      vertexColors.push(rgb);
      continue;
    }

    if (line.startsWith('f ')) {
      const parts = line.slice(2).trim().split(/\s+/);
      const idxs: number[] = [];
      const uvIdx: number[] = [];
      for (const part of parts) {
        const seg = part.split('/');
        const n = Number(seg[0]);
        if (!Number.isFinite(n) || n === 0) continue;
        const idx = n < 0 ? vertices.length + n : n - 1;
        if (idx < 0 || idx >= vertices.length) continue;
        idxs.push(idx);
        const tn = seg[1] ? Number(seg[1]) : NaN;
        let ti = -1;
        if (Number.isFinite(tn) && tn !== 0) {
          ti = tn < 0 ? uvs.length + tn : tn - 1;
          if (ti < 0 || ti >= uvs.length) ti = -1;
        }
        uvIdx.push(ti);
      }
      if (idxs.length < 3) continue;
      for (let i = 1; i < idxs.length - 1; i++) {
        triangles.push([idxs[0], idxs[i], idxs[i + 1]]);
        triangleUV.push([uvIdx[0], uvIdx[i], uvIdx[i + 1]]);
        faceColors.push(activeColor);
        faceMaterials.push(activeMaterial);
      }
    }
  }

  if (vertices.length === 0) throw new Error('OBJ_NO_VERTICES');
  if (triangles.length === 0) throw new Error('OBJ_NO_FACES');

  const hasAnyVertColor = vertexColors.some(Boolean);
  const resolvedFaceColors = triangles.map((tri, i) => {
    if (faceColors[i]) return faceColors[i];
    if (!hasAnyVertColor) return null;
    const cols = [vertexColors[tri[0]], vertexColors[tri[1]], vertexColors[tri[2]]].filter(
      Boolean,
    ) as Array<{ r: number; g: number; b: number }>;
    if (!cols.length) return null;
    const r = cols.reduce((s, c) => s + c.r, 0) / cols.length;
    const g = cols.reduce((s, c) => s + c.g, 0) / cols.length;
    const b = cols.reduce((s, c) => s + c.b, 0) / cols.length;
    return rgbToHex(r, g, b);
  });

  void sawVertexColor;
  void sawMtlColor;

  return {
    vertices,
    vertexColors: hasAnyVertColor ? vertexColors : undefined,
    triangles,
    faceColors: resolvedFaceColors,
    uvs: uvs.length ? uvs : undefined,
    triangleUV: uvs.length ? triangleUV : undefined,
    faceMaterials,
    materialTextures,
    mtllibNames,
  };
}

function hashNameToColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const r = 0.25 + ((h >> 0) & 255) / 255 * 0.55;
  const g = 0.25 + ((h >> 8) & 255) / 255 * 0.55;
  const b = 0.25 + ((h >> 16) & 255) / 255 * 0.55;
  return rgbToHex(r, g, b);
}

export function normalizeMesh(mesh: Mesh3D, halfExtent = TARGET_HALF_EXTENT): Mesh3D {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  // 只统计被三角面引用的顶点：游离顶点会把包围盒撑大，模型就缩成一小团
  const used = new Uint8Array(mesh.vertices.length);
  for (const t of mesh.triangles) { used[t[0]] = 1; used[t[1]] = 1; used[t[2]] = 1; }
  for (let i = 0; i < mesh.vertices.length; i++) {
    if (!used[i]) continue;
    const v = mesh.vertices[i];
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
    ...mesh,
    vertices: mesh.vertices.map(v => ({
      x: (v.x - cx) * scale,
      y: (v.y - cy) * scale,
      z: (v.z - cz) * scale,
    })),
    vertexColors: mesh.vertexColors?.slice(),
    triangles: mesh.triangles.slice(),
    faceColors: mesh.faceColors?.slice(),
  };
}

type AnalyticPrimitive =
  | { kind: 'sphere'; center: Vec3; radius: number; color: string }
  | { kind: 'box'; min: Vec3; max: Vec3; color: string }
  | { kind: 'cylinder'; axis: 'x' | 'y' | 'z'; center: Vec3; radius: number; halfLen: number; color: string };

function averageFaceColor(mesh: Mesh3D): string {
  const colors = (mesh.faceColors || []).filter(Boolean) as string[];
  if (!colors.length) return DEFAULT_MESH_COLOR;
  let r = 0, g = 0, b = 0;
  for (const hex of colors) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) continue;
    r += parseInt(m[1].slice(0, 2), 16);
    g += parseInt(m[1].slice(2, 4), 16);
    b += parseInt(m[1].slice(4, 6), 16);
  }
  const n = colors.length;
  return rgbToHex(r / n / 255, g / n / 255, b / n / 255);
}

/** 简单几何原语检测（高置信才启用） */
export function detectAnalyticPrimitives(mesh: Mesh3D): AnalyticPrimitive[] {
  const verts = mesh.vertices;
  if (verts.length < 8) return [];

  // 带有丰富颜色/贴图的模型不能用单色原语替代，否则会丢颜色
  const distinctColors = new Set((mesh.faceColors || []).filter(Boolean) as string[]);
  if (distinctColors.size > 2) return [];

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let sx = 0, sy = 0, sz = 0;
  for (const v of verts) {
    sx += v.x; sy += v.y; sz += v.z;
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.z < minZ) minZ = v.z;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
    if (v.z > maxZ) maxZ = v.z;
  }
  const n = verts.length;
  const cx = sx / n, cy = sy / n, cz = sz / n;
  const color = averageFaceColor(mesh);

  // Sphere：半径变异系数小
  const radii = verts.map(v => Math.hypot(v.x - cx, v.y - cy, v.z - cz));
  const meanR = radii.reduce((a, b) => a + b, 0) / n;
  if (meanR > 0.5) {
    let varSum = 0;
    for (const r of radii) varSum += (r - meanR) ** 2;
    const cv = Math.sqrt(varSum / n) / meanR;
    if (cv < 0.06 && mesh.triangles.length >= 20) {
      return [{ kind: 'sphere', center: { x: cx, y: cy, z: cz }, radius: meanR, color }];
    }
  }

  // Box：顶点几乎落在 AABB 八角附近
  const corners: Vec3[] = [
    { x: minX, y: minY, z: minZ }, { x: maxX, y: minY, z: minZ },
    { x: minX, y: maxY, z: minZ }, { x: maxX, y: maxY, z: minZ },
    { x: minX, y: minY, z: maxZ }, { x: maxX, y: minY, z: maxZ },
    { x: minX, y: maxY, z: maxZ }, { x: maxX, y: maxY, z: maxZ },
  ];
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  let nearCorner = 0;
  for (const v of verts) {
    let best = Infinity;
    for (const c of corners) {
      const d = Math.hypot(v.x - c.x, v.y - c.y, v.z - c.z);
      if (d < best) best = d;
    }
    if (best < diag * 0.08) nearCorner++;
  }
  const extentX = maxX - minX, extentY = maxY - minY, extentZ = maxZ - minZ;
  if (nearCorner / n > 0.55 && n <= 24 && Math.min(extentX, extentY, extentZ) > 0.2) {
    return [{
      kind: 'box',
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
      color,
    }];
  }

  // Cylinder：某一轴上径向距离稳定
  const tryAxis = (axis: 'x' | 'y' | 'z'): AnalyticPrimitive | null => {
    const rads: number[] = [];
    let axisMin = Infinity, axisMax = -Infinity;
    for (const v of verts) {
      let r: number;
      let along: number;
      if (axis === 'z') {
        r = Math.hypot(v.x - cx, v.y - cy);
        along = v.z;
      } else if (axis === 'y') {
        r = Math.hypot(v.x - cx, v.z - cz);
        along = v.y;
      } else {
        r = Math.hypot(v.y - cy, v.z - cz);
        along = v.x;
      }
      rads.push(r);
      if (along < axisMin) axisMin = along;
      if (along > axisMax) axisMax = along;
    }
    const mean = rads.reduce((a, b) => a + b, 0) / n;
    if (mean < 0.4) return null;
    let vs = 0;
    for (const r of rads) vs += (r - mean) ** 2;
    const cv = Math.sqrt(vs / n) / mean;
    const half = (axisMax - axisMin) / 2;
    if (cv < 0.08 && half > mean * 0.35) {
      return {
        kind: 'cylinder',
        axis,
        center: { x: cx, y: cy, z: cz },
        radius: mean,
        halfLen: half,
        color,
      };
    }
    return null;
  };

  for (const axis of ['z', 'y', 'x'] as const) {
    const hit = tryAxis(axis);
    if (hit) return [hit];
  }

  return [];
}

function analyticToExpressions(primitives: AnalyticPrimitive[]): Desmos3DExpression[] {
  const out: Desmos3DExpression[] = [];
  primitives.forEach((p, i) => {
    if (p.kind === 'sphere') {
      out.push({
        id: `m3d_sphere_${i}`,
        latex: `\\operatorname{sphere}\\left(${fmtPt(p.center)},${fmt(p.radius)}\\right)`,
        color: p.color,
        fillOpacity: 1,
      });
      return;
    }
    if (p.kind === 'box') {
      // 8 顶点 + 12 三角面 → 一条列表表达式
      const { min: a, max: b } = p;
      const pos = [
        a.x, a.y, a.z, b.x, a.y, a.z, b.x, b.y, a.z, a.x, b.y, a.z,
        a.x, a.y, b.z, b.x, a.y, b.z, b.x, b.y, b.z, a.x, b.y, b.z,
      ];
      const faces = [
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
        2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7,
      ];
      const col = hexToPacked(p.color, 0x2d70b3);
      const built = meshToListExpressions(pos, faces, new Array(12).fill(col), `m3d_box${i}`);
      out.push(...built.expressions);
      return;
    }
    // 圆柱：侧面 + 两端圆盖（均为参数曲面，区间走 parametricDomain3D）
    const { center: c, radius: r, halfLen: h, axis, color } = p;
    const side = (u: string, v: string, w: string) =>
      `\\left(${fmt(c.x)}+${u},${fmt(c.y)}+${v},${fmt(c.z)}+${w}\\right)`;
    const cu = `${fmt(r)}\\cos\\left(u\\right)`;
    const su = `${fmt(r)}\\sin\\left(u\\right)`;
    let sideLatex: string;
    if (axis === 'z') sideLatex = side(cu, su, 'v');
    else if (axis === 'y') sideLatex = side(cu, 'v', su);
    else sideLatex = side('v', cu, su);
    out.push({
      id: `m3d_cyl_${i}`,
      latex: sideLatex,
      color,
      fillOpacity: 1,
      parametricDomain3Du: { min: '0', max: '2\\pi' },
      parametricDomain3Dv: { min: fmt(-h), max: fmt(h) },
    });
    for (const sign of [-1, 1]) {
      const rc = 'v\\cos\\left(u\\right)';
      const rs = 'v\\sin\\left(u\\right)';
      const off = fmt(sign * h);
      const capLatex =
        axis === 'z' ? side(rc, rs, off) : axis === 'y' ? side(rc, off, rs) : side(off, rc, rs);
      out.push({
        id: `m3d_cyl_${i}_cap${sign}`,
        latex: capLatex,
        color,
        fillOpacity: 1,
        parametricDomain3Du: { min: '0', max: '2\\pi' },
        parametricDomain3Dv: { min: '0', max: fmt(r) },
      });
    }
  });
  return out;
}

function detectColorSource(mesh: Mesh3D): Model3DConvertResult['colorSource'] {
  const faces = mesh.faceColors || [];
  const colored = faces.filter(Boolean).length;
  if (!colored) return 'none';
  if (mesh.vertexColors?.some(Boolean)) return colored < faces.length ? 'mixed' : 'vertex';
  return 'mtl';
}

/**
 * 网格 → Desmos 3D 表达式
 * 解析原语优先；其余走 QEM 折叠 + 列表网格编码。
 */
export function meshToDesmos3D(
  meshIn: Mesh3D,
  options?: { maxTriangles?: number; maxEdges?: number; textures?: TextureMap },
): Model3DConvertResult {
  const maxTriangles = options?.maxTriangles ?? MAX_TRIANGLES;
  // OBJ 约定 Y 向上；Desmos 3D 是 Z 向上 → (x,y,z) ↦ (x,−z,y)，模型正面（OBJ +z）朝向默认相机
  let zUp: Mesh3D = {
    ...meshIn,
    vertices: meshIn.vertices.map(v => ({ x: v.x, y: -v.z, z: v.y })),
  };
  // 自动转正：模型「深度」（沿视线）明显大于「宽度」时（车、枪、长条物体），绕竖直轴转 90°，
  // 让最大的一面朝向相机，而不是正对着枪口/车头看成一小团。
  {
    const used = new Uint8Array(zUp.vertices.length);
    for (const t of zUp.triangles) { used[t[0]] = 1; used[t[1]] = 1; used[t[2]] = 1; }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    zUp.vertices.forEach((v, i) => {
      if (!used[i]) return;
      if (v.x < x0) x0 = v.x;
      if (v.x > x1) x1 = v.x;
      if (v.y < y0) y0 = v.y;
      if (v.y > y1) y1 = v.y;
    });
    if (y1 - y0 > 1.35 * (x1 - x0)) {
      zUp = { ...zUp, vertices: zUp.vertices.map(v => ({ x: -v.y, y: v.x, z: v.z })) };
    }
  }
  const mesh = normalizeMesh(zUp);
  const faceCount = mesh.triangles.length;
  const colorSource = detectColorSource(mesh);

  // 贴图：材质带 map_Kd 且用户一并给了图片 → 按 UV 采样（并细分以带走贴图细节）
  const faceTexture: Array<TextureImage | null> | null = (() => {
    const tex = options?.textures;
    if (!tex || tex.size === 0 || !mesh.uvs || !mesh.triangleUV || !mesh.materialTextures || !mesh.faceMaterials) {
      return null;
    }
    let any = false;
    const arr = mesh.triangles.map((_, i) => {
      const mat = mesh.faceMaterials![i];
      const key = mat ? mesh.materialTextures!.get(mat) : undefined;
      const img = key ? tex.get(key) ?? null : null;
      if (img) any = true;
      return img;
    });
    return any ? arr : null;
  })();

  const primitives = faceTexture ? [] : detectAnalyticPrimitives(mesh);
  if (primitives.length > 0) {
    const analyticExprs = analyticToExpressions(primitives);
    const noteExpr: Desmos3DExpression = {
      id: 'm3d_note',
      type: 'text',
      text: `3D analytic · ${primitives.map(p => p.kind).join('+')} · V${mesh.vertices.length} F${faceCount}`,
    };
    return {
      expressions: [noteExpr, ...analyticExprs],
      vertexCount: mesh.vertices.length,
      faceCount,
      triangleCount: faceCount,
      renderedTriangles: 0,
      renderedEdges: 0,
      analyticCount: analyticExprs.length,
      mode: 'analytic',
      explanation: 'model_3d_complete_hi',
      colorSource,
    };
  }

  // 打包顶点与面颜色
  const nV = mesh.vertices.length;
  const positions = new Float64Array(nV * 3);
  mesh.vertices.forEach((v, i) => {
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
  });
  const fallbackColor = hexToPacked(DEFAULT_MESH_COLOR, 0x2d70b3);
  const faces = new Int32Array(faceCount * 3);
  const faceColor = new Int32Array(faceCount);
  mesh.triangles.forEach((t, i) => {
    faces[i * 3] = t[0];
    faces[i * 3 + 1] = t[1];
    faces[i * 3 + 2] = t[2];
    faceColor[i] = hexToPacked(mesh.faceColors?.[i], fallbackColor);
  });

  let simplified;
  if (faceTexture) {
    const textured = buildTexturedTriangles(
      {
        positions,
        triangles: mesh.triangles,
        uvs: mesh.uvs!,
        triangleUV: mesh.triangleUV!,
        faceTexture,
        fallbackColor: faceColor,
      },
      maxTriangles,
    );
    simplified = simplifyMesh(textured, maxTriangles);
  } else {
    simplified = simplifyMesh({ positions, faces, faceColor }, maxTriangles);
  }
  const built = meshToListExpressions(simplified.positions, simplified.faces, simplified.faceColor, 'm3d');
  const rendered = built.triangleCount;

  let mode: Model3DConvertResult['mode'] = 'triangles';
  let warning: string | undefined;
  if (rendered < faceCount * 0.97) {
    mode = 'mixed';
    warning = 'model_3d_decimated_hi';
  }

  const noteExpr: Desmos3DExpression = {
    id: 'm3d_note',
    type: 'text',
    text: `3D mesh · V${nV} F${faceCount} → QEM ${rendered} tri · ${built.chunkCount} list blocks · ${built.colorCount} colors`,
  };

  return {
    expressions: [noteExpr, ...built.expressions],
    vertexCount: nV,
    faceCount,
    triangleCount: faceCount,
    renderedTriangles: rendered,
    renderedEdges: 0,
    analyticCount: 0,
    mode,
    explanation: 'model_3d_complete_hi',
    warning,
    colorSource,
  };
}

/** 渐进写入（getState / setState，以便 colorLatex 与参数区间生效） */
export const applyModel3DExpressionsProgressively = applyDesmos3DExpressions;

export async function processObjTextToDesmos3D(
  objText: string,
  mtlText?: string,
  options?: { maxTriangles?: number; maxEdges?: number; textures?: TextureMap },
): Promise<Model3DConvertResult> {
  if (!objText.trim()) throw new Error('OBJ_EMPTY');
  const materials = mtlText ? parseMtl(mtlText) : undefined;
  const materialTextures = mtlText ? parseMtlTextures(mtlText) : undefined;
  const mesh = parseObj(objText, materials, materialTextures);
  const result = await Promise.resolve(meshToDesmos3D(mesh, options));
  if (options?.textures && options.textures.size > 0 && materialTextures && materialTextures.size > 0) {
    result.colorSource = 'texture';
  }
  return result;
}

/** 从 File 读入并转换；可选附带 MTL File */
export async function processObjFileToDesmos3D(
  file: File,
  options?: { maxTriangles?: number; maxEdges?: number; mtlFile?: File | null; textureFiles?: File[] },
): Promise<Model3DConvertResult> {
  const unsupported = unsupportedModelMessage(file);
  if (unsupported && !isObjFile(file)) {
    throw new Error(unsupported);
  }

  const text = await file.text();
  let mtlText: string | undefined;
  if (options?.mtlFile) {
    mtlText = await options.mtlFile.text();
  }
  const textures = options?.textureFiles?.length ? await loadTextureImages(options.textureFiles) : undefined;
  return processObjTextToDesmos3D(text, mtlText, { ...options, textures });
}

/** 从多选 FileList 中配对 .obj + .mtl */
export function pairObjAndMtl(files: File[]): { obj: File; mtl?: File; textures: File[] } | null {
  const list = Array.from(files);
  const obj = list.find(f => f.name.toLowerCase().endsWith('.obj')) ?? list.find(isObjFile);
  if (!obj) return null;
  const mtl = list.find(isMtlFile);
  const textures = list.filter(f => f !== obj && f !== mtl && isImageFile(f));
  return { obj, mtl, textures };
}