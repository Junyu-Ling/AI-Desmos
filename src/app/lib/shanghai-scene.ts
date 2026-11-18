/**
 * 上海陆家嘴 · 四季 —— Desmos 3D 场景
 *
 * 1 单位 = 100 米，x 向东、y 向北、z 向上，建筑高度按真实比例：
 *   东方明珠 468 m、上海中心 632 m、环球金融中心 492 m、金茂大厦 421 m。
 * 黄浦江自南向北流经外滩，在陆家嘴北侧折向东；外滩万国建筑群在西岸，陆家嘴在弯道内侧。
 *
 * 写法借鉴 Desmos 3D 大赛作品：
 *   · 季节滑块 t₀ 驱动所有颜色（The Meadow 的 lerp 混色）
 *   · 一个楼块函数 B(p,…) + 列表推导批量生成楼群（Crossroads 的工具函数复用）
 *   · 平面 + 区域限制做地面与江面，参数曲面（u、v 归一化到 [0,1]）做塔身
 *   · 随位置变化的颜色画出幕墙楼层线（Bathroom Sink 的纹理色）
 */

import type { Desmos3DExpression } from './desmos-3d-lists';
import { uprightViewMatrix } from './desmos-3d-lists';

type Building = { x: number; y: number; w: number; d: number; h: number; k: number; l: number; a: number; c: [number, number, number] };

const f = (v: number, digits = 3) => {
  const s = v.toFixed(digits).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};
const list = (vals: string[]) => `\\left[${vals.join(',')}\\right]`;
const pt = (x: number, y: number, z: number) => `\\left(${f(x)},${f(y)},${f(z)}\\right)`;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 黄浦江中心线距离（与 LaTeX 里的 d_{r} 保持一致） */
const riverDist = (x: number, y: number) => {
  if (y < 1) return Math.abs(x + 2.6);
  if (x > 2) return Math.abs(y - 5.6);
  return Math.abs(Math.hypot(x - 2, y - 1) - 4.6);
};
const RIVER_HALF = 1.7;

const PEARL = { x: 0.6, y: 2.4 };
const JINMAO = { x: 4.4, y: -1.5 };
const SWFC = { x: 5.9, y: -1.2 };
const SHTOWER = { x: 4.5, y: -3.2 };
const GREEN = { x: 2.2, y: -0.9, r: 0.85 };

function scatterBuildings(
  rnd: () => number,
  n: number,
  region: { x0: number; x1: number; y0: number; y1: number },
  accept: (x: number, y: number) => boolean,
  make: (x: number, y: number) => Omit<Building, 'x' | 'y'>,
  minGap: number,
  existing: Building[],
): Building[] {
  const out: Building[] = [];
  for (let tries = 0; out.length < n && tries < n * 200; tries++) {
    const x = region.x0 + rnd() * (region.x1 - region.x0);
    const y = region.y0 + rnd() * (region.y1 - region.y0);
    if (!accept(x, y)) continue;
    if ([...existing, ...out].some(b => Math.hypot(b.x - x, b.y - y) < minGap)) continue;
    out.push({ x, y, ...make(x, y) });
  }
  return out;
}

/** 整体明暗抖动（三通道同一偏移，避免偏色成粉紫） */
const shade = (base: [number, number, number], rnd: () => number, amt = 18): [number, number, number] => {
  const d = (rnd() - 0.5) * 2 * amt;
  return base.map(v => Math.max(0, Math.min(255, Math.round(v + d)))) as [number, number, number];
};

function buildCity() {
  const rnd = mulberry32(20261117);

  // 外滩万国建筑群：沿江一排，石材暖色
  const bund: Building[] = [];
  const stone: [number, number, number][] = [[214, 200, 170], [200, 184, 150], [226, 214, 190], [188, 170, 140], [208, 196, 176]];
  for (let y = -8.0; y < 0.7; ) {
    const w = 0.12 + rnd() * 0.12;
    const yc = y + w;
    bund.push({ x: -5.45, y: yc, w: 0.42, d: w * 0.92, h: 0.28 + rnd() * 0.3, k: 1, l: 1, a: 0, c: shade(stone[Math.floor(rnd() * stone.length)], rnd, 10) });
    y += 2 * w + 0.04;
  }
  // 海关大楼钟楼、和平饭店、汇丰银行风格（绿色金字塔顶在单独的表达式里）
  const customs = bund.reduce((best, b) => (Math.abs(b.y + 3.2) < Math.abs(best.y + 3.2) ? b : best), bund[0]);
  customs.h = 0.48;
  customs.w = 0.48;
  customs.c = [218, 204, 176];
  const peace = bund.reduce((best, b) => (Math.abs(b.y + 1.6) < Math.abs(best.y + 1.6) ? b : best), bund[0]);
  peace.h = 0.72;
  peace.w = 0.5;
  peace.c = [232, 224, 208];
  const hsbc = bund.reduce((best, b) => (Math.abs(b.y + 2.4) < Math.abs(best.y + 2.4) ? b : best), bund[0]);
  hsbc.h = 0.55;
  hsbc.w = 0.5;
  hsbc.c = [210, 198, 172];
  const bundTowers: Building[] = [
    { x: customs.x + 0.12, y: customs.y, w: 0.1, d: 0.1, h: 0.48 + 0.52, k: 0.75, l: 0.75, a: 0, c: [222, 210, 182] },
  ];

  // 浦西纵深：现代高楼（数量控制在展示流畅的范围内）
  const puxi = scatterBuildings(
    rnd, 16,
    { x0: -7.4, x1: -6.15, y0: -8.1, y1: 4 },
    (x, y) => riverDist(x, y) > RIVER_HALF + 0.6,
    (x, y) => {
      const t = rnd();
      return { w: 0.2 + rnd() * 0.18, d: 0.2 + rnd() * 0.18, h: 0.45 + t * t * 0.95, k: 0.9 + rnd() * 0.1, l: 0.9 + rnd() * 0.1, a: rnd() * 0.5 - 0.25, c: shade(t > 0.6 ? [150, 172, 190] : [176, 170, 162], rnd) };
    },
    0.78, bund,
  );

  // 北岸（虹口、北外滩）
  const north = scatterBuildings(
    rnd, 14,
    { x0: -7.4, x1: 8.9, y0: 7.55, y1: 8.1 },
    (x, y) => riverDist(x, y) > RIVER_HALF + 0.5,
    () => {
      const t = rnd();
      return { w: 0.2 + rnd() * 0.18, d: 0.2 + rnd() * 0.16, h: 0.4 + t * t * 1.7, k: 0.92 + rnd() * 0.08, l: 0.92 + rnd() * 0.08, a: rnd() * 0.6 - 0.3, c: shade(t > 0.55 ? [140, 165, 182] : [184, 176, 166], rnd) };
    },
    0.75, [],
  );

  // 陆家嘴楼群：越靠近三塔越高（减量保流畅，靠层次与配色撑观感）
  const keep = [PEARL, JINMAO, SWFC, SHTOWER, { x: 3.15, y: -2.55 }, { x: 3.55, y: -2.25 }, { x: 2.55, y: -3.35 }];
  const lujiazui = scatterBuildings(
    rnd, 32,
    { x0: -0.6, x1: 8.9, y0: -8.1, y1: 4.6 },
    (x, y) =>
      riverDist(x, y) > RIVER_HALF + 0.75 &&
      keep.every(p => Math.hypot(p.x - x, p.y - y) > 0.9) &&
      Math.hypot(GREEN.x - x, GREEN.y - y) > GREEN.r + 0.35 &&
      Math.abs(centuryAvenueDist(x, y)) > 0.4,
    (x, y) => {
      const near = Math.exp(-((x - 4.6) ** 2 + (y + 2) ** 2) / 14);
      const t = rnd();
      const glass = t > 0.28;
      return {
        w: 0.2 + rnd() * 0.18, d: 0.2 + rnd() * 0.18,
        h: 0.6 + near * (1.1 + 1.5 * t) + t * 0.55,
        k: 0.85 + rnd() * 0.15, l: 0.85 + rnd() * 0.15,
        a: -0.42 + (rnd() - 0.5) * 0.2,
        c: shade(glass ? [118, 148, 170] : [188, 184, 176], rnd, 16),
      };
    },
    0.78, [],
  );

  // 金茂大厦：塔式逐层收分
  const jinmao: Building[] = [];
  let z = 0;
  const tiers = [0.62, 0.5, 0.42, 0.36, 0.3, 0.26, 0.22, 0.2, 0.18, 0.16, 0.14, 0.13, 0.12];
  tiers.forEach((h, i) => {
    const w = 0.27 - i * 0.0105;
    jinmao.push({ x: JINMAO.x, y: JINMAO.y, w, d: w, h, k: 0.93, l: 0.93, a: -0.42, c: i % 2 ? [128, 140, 150] : [150, 160, 168] });
    (jinmao[jinmao.length - 1] as any).z = z;
    z += h;
  });
  const crown = { x: JINMAO.x, y: JINMAO.y, w: 0.13, d: 0.13, h: 0.3, k: 0.35, l: 0.35, a: -0.42, c: [176, 168, 140] as [number, number, number] };
  (crown as any).z = z;
  jinmao.push(crown);
  const jinmaoTop = z + 0.3;

  // 环球金融中心：一侧收窄成刀锋，顶部「开瓶器」洞口
  const swfc: Building = { x: SWFC.x, y: SWFC.y, w: 0.29, d: 0.29, h: 4.92, k: 1, l: 0.16, a: 0.35, c: [132, 158, 178] };

  // 陆家嘴特色裙楼 / 国金中心风格双塔底座附近的中高层
  const ifc: Building[] = [
    { x: 3.15, y: -2.55, w: 0.22, d: 0.22, h: 2.45, k: 0.92, l: 0.92, a: -0.35, c: [132, 158, 176] },
    { x: 3.55, y: -2.25, w: 0.2, d: 0.2, h: 2.15, k: 0.94, l: 0.94, a: -0.35, c: [140, 164, 180] },
    { x: 2.55, y: -3.35, w: 0.28, d: 0.18, h: 0.42, k: 1, l: 1, a: -0.4, c: [176, 168, 158] },
  ];

  return { bund, bundTowers, puxi, north, lujiazui, jinmao, jinmaoTop, swfc, ifc, peace, customs };
}

/** 世纪大道：从东方明珠向东南延伸 */
function centuryAvenueDist(x: number, y: number) {
  const ax = PEARL.x + 0.6, ay = PEARL.y - 0.5, dx = Math.cos(-0.72), dy = Math.sin(-0.72);
  return (x - ax) * -dy + (y - ay) * dx;
}

/** 南浦桥占位走廊：树与路灯避开，避免穿模 */
const BRIDGE = { x0: -5.7, x1: 0.45, y0: -5.85, y1: -4.55, y: -5.2 };

/**
 * 行道树：参考 Ultra OBJ 的滨江布局，但强制最小间距、避开建筑/桥/江，
 * 杜绝「扎堆球体」与穿楼。
 */
/** 树的几何模型不变（树干 segment + 树冠 sphere）；这里只疏间隔、避开桥/楼/江 */
function buildTrees(obstacles: { x: number; y: number; r: number }[]) {
  const rnd = mulberry32(42);
  const raw: [number, number][] = [];
  for (let y = -7.9; y <= 0.6; y += 0.55) raw.push([-4.62, y]);
  for (let a = 1.75; a <= 3.05; a += 0.16) {
    const r = 4.6 - RIVER_HALF - 0.35;
    raw.push([2 + r * Math.cos(a), 1 + r * Math.sin(a)]);
  }
  for (let i = 0; i < 12; i++) {
    const ang = rnd() * Math.PI * 2;
    const rr = Math.sqrt(rnd()) * (GREEN.r - 0.12);
    raw.push([GREEN.x + rr * Math.cos(ang), GREEN.y + rr * Math.sin(ang)]);
  }
  const ax = PEARL.x + 0.6, ay = PEARL.y - 0.5, dx = Math.cos(-0.72), dy = Math.sin(-0.72);
  for (let s = 0.4; s < 9; s += 0.7) {
    for (const side of [-0.3, 0.3]) raw.push([ax + dx * s - dy * side, ay + dy * s + dx * side]);
  }

  const minGap = 0.5;
  const out: [number, number][] = [];
  for (const [x, y] of raw) {
    if (riverDist(x, y) <= RIVER_HALF + 0.15) continue;
    if (x <= -7.4 || x >= 8.9 || Math.abs(y) >= 8.15) continue;
    if (Math.hypot(x - PEARL.x, y - PEARL.y) <= 0.8) continue;
    if (x > BRIDGE.x0 && x < BRIDGE.x1 && y > BRIDGE.y0 && y < BRIDGE.y1) continue;
    if (obstacles.some(o => Math.hypot(o.x - x, o.y - y) < o.r)) continue;
    if (out.some(([ox, oy]) => Math.hypot(ox - x, oy - y) < minGap)) continue;
    out.push([x, y]);
  }
  return out;
}

/** 生成场景的全部表达式（全部明文列出，不隐藏、不压缩） */
export function buildShanghaiSceneExpressions(lang: string = 'zh'): Desmos3DExpression[] {
  const zh = lang !== 'en';
  const city = buildCity();
  const footprint = (b: Building, pad = 0.22) => ({
    x: b.x, y: b.y, r: Math.max(b.w, b.d) * 0.75 + pad,
  });
  const treeObstacles = [
    ...city.bund, ...city.bundTowers, ...city.puxi, ...city.north, ...city.lujiazui, ...city.ifc, city.swfc,
  ].map(b => footprint(b));
  treeObstacles.push(
    { x: PEARL.x, y: PEARL.y, r: 1.05 },
    { x: JINMAO.x, y: JINMAO.y, r: 0.7 },
    { x: SWFC.x, y: SWFC.y, r: 0.65 },
    { x: SHTOWER.x, y: SHTOWER.y, r: 0.85 },
  );
  const trees = buildTrees(treeObstacles);
  const out: Desmos3DExpression[] = [];
  let seq = 0;
  const id = (p: string) => `sh_${p}_${seq++}`;
  const text = (zhText: string, enText: string) => out.push({ id: id('t'), type: 'text', text: zh ? zhText : enText });
  const ex = (latex: string, extra: Partial<Desmos3DExpression> = {}) => out.push({ id: id('e'), latex, ...extra });

  text(
    '上海陆家嘴 · 四季（完稿）｜1 单位 = 100 米。公式全部明文列出。辅助点列/色场只关「绘图」（不是 secret），避免 Desmos 把 P_*/U_*/T_r 画成满屏的点。',
    'Shanghai Lujiazui · Four Seasons (final) | Helper point lists keep plot off (not secret) so Desmos does not scatter dots.',
  );

  // ── 四季 ──
  text('🍂 四季：t₀ 决定季节，n₀/n₁ 是当前与下一季，g_s 在每季末尾 35% 平滑过渡；M(L) 从四季数值列表 L=[春,夏,秋,冬] 中取值。', '🍂 Seasons: n₀/n₁ = current/next season, g_s blends over the last 35% of each season; M(L) picks from L=[spring,summer,autumn,winter].');
  ex('t_{0}=0.3', { slider: { hardMin: true, hardMax: true, min: '0', max: '1', step: '0.005', animationPeriod: 60000, loopMode: 'LOOP_FORWARD' } } as any);
  ex('n_{0}=\\operatorname{mod}\\left(\\operatorname{floor}\\left(4t_{0}\\right),4\\right)+1');
  ex('n_{1}=\\operatorname{mod}\\left(n_{0},4\\right)+1');
  ex('f_{s}=\\min\\left(1,\\max\\left(0,\\frac{4t_{0}-\\operatorname{floor}\\left(4t_{0}\\right)-0.65}{0.35}\\right)\\right)');
  ex('g_{s}=f_{s}^{2}\\left(3-2f_{s}\\right)');
  ex('M\\left(L\\right)=L\\left[n_{0}\\right]+\\left(L\\left[n_{1}\\right]-L\\left[n_{0}\\right]\\right)g_{s}');
  ex('S_{c}\\left(R,G,B\\right)=\\operatorname{rgb}\\left(M\\left(R\\right),M\\left(G\\right),M\\left(B\\right)\\right)');
  text('季节颜色：地面、草坪、江水、树冠；k_leaf 是树冠大小（冬季落叶缩小），s_now 是屋顶积雪厚度（非冬季藏在屋顶里）。', 'Season colors for ground, lawn, river, foliage; k_leaf = crown size, s_now = roof snow depth.');
  ex('C_{ground}=S_{c}\\left(\\left[186,182,178,226\\right],\\left[180,178,170,229\\right],\\left[172,166,150,236\\right]\\right)');
  ex('C_{grass}=S_{c}\\left(\\left[150,62,196,232\\right],\\left[200,138,156,236\\right],\\left[96,58,62,240\\right]\\right)');
  ex('C_{water}=S_{c}\\left(\\left[96,78,104,128\\right],\\left[128,116,116,140\\right],\\left[112,104,100,150\\right]\\right)');
  ex('C_{leaf}=S_{c}\\left(\\left[246,58,222,128\\right],\\left[188,132,158,104\\right],\\left[214,52,48,84\\right]\\right)');
  ex('C_{trunk}=\\operatorname{rgb}\\left(110,84,64\\right)');
  ex('C_{snow}=\\operatorname{rgb}\\left(244,247,252\\right)');
  ex('k_{leaf}=M\\left(\\left[0.95,1.05,0.95,0.42\\right]\\right)');
  ex('s_{now}=M\\left(\\left[-0.03,-0.03,-0.03,0.045\\right]\\right)');
  ex('s_{w}=\\max\\left(0,\\min\\left(1,\\frac{s_{now}}{0.04}\\right)\\right)');

  // 幕墙色场：依赖 x,y,z / u，若「画出来」Desmos 会当成曲面铺满屏幕，所以只关绘图、仍完整出现在左侧列表。
  text('🪟 幕墙色场 f_ace / C_glass / C_podium / C_jinmao / C_st：公式完整写在列表里；仅关闭「绘图」避免被当成曲面。Landmark 塔楼用它们上色，外滩另加楼层线。', '🪟 Facade color fields stay fully listed; plotting is off so Desmos does not treat them as surfaces.');
  ex('f_{ace}=\\min\\left(1,\\max\\left(0,\\cos\\left(\\frac{2\\pi x}{0.06}\\right)\\right)^{12}+\\max\\left(0,\\cos\\left(\\frac{2\\pi y}{0.06}\\right)\\right)^{12}+\\max\\left(0,\\cos\\left(\\frac{2\\pi z}{0.1}\\right)\\right)^{8}\\right)', { hidden: true });
  ex('C_{glass}=\\operatorname{rgb}\\left(96+42\\sin\\left(2.2x\\right)-58f_{ace},138+22\\sin\\left(2.2y\\right)-42f_{ace},172-16f_{ace}\\right)', { hidden: true });
  ex('C_{podium}=\\operatorname{rgb}\\left(150-28f_{ace},142-22f_{ace},132-14f_{ace}\\right)', { hidden: true });
  ex('C_{roof}=\\operatorname{rgb}\\left(148+96s_{w},160+90s_{w},174+78s_{w}\\right)');
  ex('C_{mullion}=\\operatorname{rgb}\\left(46,58,70\\right)');
  ex('C_{jinmao}=\\operatorname{rgb}\\left(166+55\\max\\left(0,\\cos\\left(\\frac{26\\pi z}{4.02}\\right)\\right)^{6}-52f_{ace},140+40\\max\\left(0,\\cos\\left(\\frac{26\\pi z}{4.02}\\right)\\right)^{6}-36f_{ace},108-14f_{ace}\\right)', { hidden: true });

  // ── 工具函数 ──
  text('🧰 工具函数：U_a/U_b/U_c 是单位立方体 10 个三角面顶点；B(p,c,w,d,h,k,l,a) 把单位立方体变成楼块。全部明文列出。', '🧰 Helpers: unit-cube face lists and block mapper B(...). All listed in full.');
  const faces: [number[], number[], number[]][] = [
    [[0, 0, 1], [1, 0, 1], [1, 1, 1]], [[0, 0, 1], [1, 1, 1], [0, 1, 1]],
    [[0, 0, 0], [1, 0, 0], [1, 0, 1]], [[0, 0, 0], [1, 0, 1], [0, 0, 1]],
    [[0, 1, 0], [1, 1, 0], [1, 1, 1]], [[0, 1, 0], [1, 1, 1], [0, 1, 1]],
    [[0, 0, 0], [0, 1, 0], [0, 1, 1]], [[0, 0, 0], [0, 1, 1], [0, 0, 1]],
    [[1, 0, 0], [1, 1, 0], [1, 1, 1]], [[1, 0, 0], [1, 1, 1], [1, 0, 1]],
  ];
  // 点列若开着绘图，Desmos 3D 会铺满「莫名其妙的点」；公式仍完整留在列表，只关绘图
  (['a', 'b', 'c'] as const).forEach((n, k) =>
    ex(`U_{${n}}=${list(faces.map(t => `\\left(${t[k].join(',')}\\right)`))}`, { hidden: true }),
  );
  ex('B\\left(p,c,w,d,h,k,l,a\\right)=c+\\left(Q.x\\cos\\left(a\\right)-Q.y\\sin\\left(a\\right),Q.x\\sin\\left(a\\right)+Q.y\\cos\\left(a\\right),hp.z\\right)\\operatorname{with}Q=\\left(\\left(2p.x-1\\right)w\\left(1-\\left(1-k\\right)p.z\\right),\\left(2p.y-1\\right)d\\left(1-\\left(1-l\\right)p.z\\right)\\right)');
  // d_r(x,y) 若绘图会铺成曲面，只关绘图、公式仍在列表
  ex('d_{r}\\left(x,y\\right)=\\left\\{y<1:\\left|x+2.6\\right|,x>2:\\left|y-5.6\\right|,\\left|\\sqrt{\\left(x-2\\right)^{2}+\\left(y-1\\right)^{2}}-4.6\\right|\\right\\}', { hidden: true });

  // ── 地面与黄浦江 ──
  text('🌊 地面与黄浦江：d_r 到江心线距离，半宽 170 m；护岸、世纪大道、外滩步道分层。水面用轻微波纹。', '🌊 Ground & river with embankments, Century Avenue, Bund promenade, light ripples.');
  // 地面 / 水面高度错开，减少与桥面、护岸的深度冲突
  ex(`z=-0.02\\left\\{d_{r}\\left(x,y\\right)>${RIVER_HALF}\\right\\}\\left\\{-7.5<x<9\\right\\}\\left\\{-8.25<y<8.25\\right\\}`, { colorLatex: 'C_{ground}' });
  ex(`z=-0.06+0.004\\sin\\left(2.6x+1.5y\\right)\\left\\{d_{r}\\left(x,y\\right)<${RIVER_HALF}\\right\\}\\left\\{-7.5<x<9\\right\\}\\left\\{-8.25<y<8.25\\right\\}`, { colorLatex: 'C_{water}' });
  // 单层护岸（避免双层边界闪烁穿模）
  ex(`z=0.035\\left\\{${RIVER_HALF}<d_{r}\\left(x,y\\right)<${f(RIVER_HALF + 0.15)}\\right\\}\\left\\{-7.5<x<9\\right\\}\\left\\{-8.25<y<8.25\\right\\}`, { color: '#8a8278' });
  ex(`z=0.01\\left\\{\\left(x-${f(GREEN.x)}\\right)^{2}+\\left(y-${f(GREEN.y)}\\right)^{2}<${f(GREEN.r ** 2)}\\right\\}`, { colorLatex: 'C_{grass}' });
  ex(`z=0.006\\left\\{\\left|\\left(x-${f(PEARL.x + 0.6)}\\right)\\sin\\left(0.72\\right)+\\left(y-${f(PEARL.y - 0.5)}\\right)\\cos\\left(0.72\\right)\\right|<0.14\\right\\}\\left\\{\\left(x-${f(PEARL.x + 0.6)}\\right)\\cos\\left(0.72\\right)-\\left(y-${f(PEARL.y - 0.5)}\\right)\\sin\\left(0.72\\right)>0\\right\\}\\left\\{-7.5<x<9\\right\\}\\left\\{-8.25<y<8.25\\right\\}`, { color: '#55585e' });
  ex('z=0.008\\left\\{-4.92<x<-4.35\\right\\}\\left\\{-8.2<y<0.9\\right\\}', { color: '#b9ab94' });
  ex('z=0.018\\left\\{-4.55<x<-4.15\\right\\}\\left\\{-7.6<y<0.55\\right\\}', { color: '#d2c6b4' });
  // 外滩路灯：躲开南浦桥走廊
  {
    const bases: string[] = [];
    const tops: string[] = [];
    for (let y = -7.4; y <= 0.4; y += 1.2) {
      if (y > BRIDGE.y0 - 0.15 && y < BRIDGE.y1 + 0.15) continue;
      bases.push(pt(-4.28, y, 0));
      tops.push(pt(-4.28, y, 0.28));
    }
    ex(`\\operatorname{segment}\\left(${list(bases)},${list(tops)}\\right)`, { color: '#5a564e' });
    ex(`\\operatorname{sphere}\\left(${list(tops)},0.03\\right)`, { color: '#f2e6c4' });
  }

  // ── 楼群 ──
  // detail='full'：外滩加楼层线+冬雪；其余楼群只画主体，保证流畅
  const group = (tag: string, title: [string, string], bs: Building[], detail: 'full' | 'simple' = 'simple', zOf?: (b: Building) => number) => {
    text(title[0], title[1]);
    const P = list(bs.map(b => pt(b.x, b.y, zOf ? zOf(b) : 0)));
    ex(`P_{${tag}}=${P}`, { hidden: true });
    ex(`W_{${tag}}=${list(bs.map(b => f(b.w)))}`);
    ex(`D_{${tag}}=${list(bs.map(b => f(b.d)))}`);
    ex(`H_{${tag}}=${list(bs.map(b => f(b.h)))}`);
    ex(`K_{${tag}}=${list(bs.map(b => f(b.k)))}`);
    ex(`L_{${tag}}=${list(bs.map(b => f(b.l)))}`);
    ex(`A_{${tag}}=${list(bs.map(b => f(b.a)))}`);
    ex(`G_{${tag}}=\\operatorname{rgb}\\left(${list(bs.map(b => String(b.c[0])))},${list(bs.map(b => String(b.c[1])))},${list(bs.map(b => String(b.c[2])))}\\right)`);
    const n = bs.length;
    const args = (U: string) =>
      `B\\left(U_{${U}}\\left[j\\right],P_{${tag}}\\left[i\\right],W_{${tag}}\\left[i\\right],D_{${tag}}\\left[i\\right],H_{${tag}}\\left[i\\right],K_{${tag}}\\left[i\\right],L_{${tag}}\\left[i\\right],A_{${tag}}\\left[i\\right]\\right)`;
    ex(`Q_{${tag}}=\\left[G_{${tag}}\\left[i\\right]\\operatorname{for}j=\\left[1...10\\right],i=\\left[1...${n}\\right]\\right]`);
    ex(`\\left[\\operatorname{triangle}\\left(${args('a')},${args('b')},${args('c')}\\right)\\operatorname{for}j=\\left[1...10\\right],i=\\left[1...${n}\\right]\\right]`, { colorLatex: `Q_{${tag}}` });
    if (detail === 'full') {
      const snowArgs = (U: string) =>
        `B\\left(U_{${U}}\\left[j\\right],P_{${tag}}\\left[i\\right]+\\left(0,0,H_{${tag}}\\left[i\\right]-0.03\\right),W_{${tag}}\\left[i\\right]K_{${tag}}\\left[i\\right]+0.004,D_{${tag}}\\left[i\\right]L_{${tag}}\\left[i\\right]+0.004,0.03+s_{now},1,1,A_{${tag}}\\left[i\\right]\\right)`;
      ex(`\\left[\\operatorname{triangle}\\left(${snowArgs('a')},${snowArgs('b')},${snowArgs('c')}\\right)\\operatorname{for}j=\\left[1...10\\right],i=\\left[1...${n}\\right]\\right]`, { colorLatex: 'C_{snow}' });
      const plate = (U: string) =>
        `B\\left(U_{${U}}\\left[j\\right],P_{${tag}}\\left[i\\right]+\\left(0,0,H_{${tag}}\\left[i\\right]\\cdot\\frac{k}{4}\\right),1.035\\cdot W_{${tag}}\\left[i\\right],1.035\\cdot D_{${tag}}\\left[i\\right],0.01,1,1,A_{${tag}}\\left[i\\right]\\right)`;
      // 只保留一道楼层线，避免三角面爆炸
      ex(`\\left[\\operatorname{triangle}\\left(${plate('a')},${plate('b')},${plate('c')}\\right)\\operatorname{for}j=\\left[3...10\\right],k=\\left[2\\right],i=\\left[1...${n}\\right]\\right]`, { colorLatex: 'C_{mullion}' });
    }
  };

  // 方截面楼身：u 绕一圈，v 从下到上。列表广播成一整片楼。
  const RHO = '\\sec\\left(\\operatorname{mod}\\left(2\\pi u-\\frac{\\pi}{4},\\frac{\\pi}{2}\\right)-\\frac{\\pi}{4}\\right)';
  const putLists = (tag: string, bs: Building[]) => {
    const num = (sel: (b: Building) => number) => list(bs.map(b => f(sel(b))));
    ex(`X_{${tag}}=${num(b => b.x)}`);
    ex(`Y_{${tag}}=${num(b => b.y)}`);
    ex(`W_{${tag}}=${num(b => b.w)}`);
    ex(`D_{${tag}}=${num(b => b.d)}`);
    ex(`H_{${tag}}=${num(b => b.h)}`);
    ex(`K_{${tag}}=${num(b => b.k)}`);
    ex(`L_{${tag}}=${num(b => b.l)}`);
    ex(`A_{${tag}}=${num(b => b.a)}`);
  };
  const wall = (tag: string, zLatex: string, wMul: string, dMul: string, taper: boolean) => {
    const tx = taper ? `\\left(1-\\left(1-K_{${tag}}\\right)v\\right)` : '1';
    const ty = taper ? `\\left(1-\\left(1-L_{${tag}}\\right)v\\right)` : '1';
    return `\\left(X_{${tag}}+q_{x}\\cos\\left(A_{${tag}}\\right)-q_{y}\\sin\\left(A_{${tag}}\\right),Y_{${tag}}+q_{x}\\sin\\left(A_{${tag}}\\right)+q_{y}\\cos\\left(A_{${tag}}\\right),${zLatex}\\right)\\operatorname{with}q_{x}=${wMul}W_{${tag}}${RHO}\\cos\\left(2\\pi u\\right)${tx},q_{y}=${dMul}D_{${tag}}${RHO}\\sin\\left(2\\pi u\\right)${ty}`;
  };
  const lid = (tag: string, zLatex: string, wMul: string, dMul: string) =>
    `\\left(X_{${tag}}+v\\cdot q_{x}\\cos\\left(A_{${tag}}\\right)-v\\cdot q_{y}\\sin\\left(A_{${tag}}\\right),Y_{${tag}}+v\\cdot q_{x}\\sin\\left(A_{${tag}}\\right)+v\\cdot q_{y}\\cos\\left(A_{${tag}}\\right),${zLatex}\\right)\\operatorname{with}q_{x}=${wMul}W_{${tag}}${RHO}\\cos\\left(2\\pi u\\right),q_{y}=${dMul}D_{${tag}}${RHO}\\sin\\left(2\\pi u\\right)`;

  group('bund', ['🏛 外滩万国建筑群：石材楼身 + 楼层线，含海关大楼钟楼与和平饭店（绿色金字塔顶）。', '🏛 The Bund: stone blocks with floor plates, Customs House and Peace Hotel.'], city.bund, 'full');
  group('bt', ['海关大楼钟楼。', 'Customs House clock tower.'], city.bundTowers, 'full');
  const p = city.peace;
  const top = p.h, ph = 0.22;
  ex(`\\operatorname{triangle}\\left(${list([pt(p.x - 0.12, p.y - 0.12, top), pt(p.x + 0.12, p.y - 0.12, top), pt(p.x + 0.12, p.y + 0.12, top), pt(p.x - 0.12, p.y + 0.12, top)])},${list([pt(p.x + 0.12, p.y - 0.12, top), pt(p.x + 0.12, p.y + 0.12, top), pt(p.x - 0.12, p.y + 0.12, top), pt(p.x - 0.12, p.y - 0.12, top)])},${pt(p.x, p.y, top + ph)}\\right)`, { color: '#3f8f6b' });
  ex(`\\operatorname{sphere}\\left(${pt(city.customs.x + 0.2, city.customs.y, 0.74)},0.04\\right)`, { color: '#f2ead2' });

  group('px', ['🏙 浦西纵深高楼。', '🏙 Puxi high-rises.'], city.puxi, 'simple');
  group('nb', ['🏙 北岸（北外滩、虹口）。', '🏙 North bank (North Bund, Hongkou).'], city.north, 'simple');
  const heroes = [...city.lujiazui].sort((a, b) => b.h - a.h).slice(0, 5);
  const heroSet = new Set(heroes);
  group('lj', ['🏙 陆家嘴楼群：越靠近三塔越高。最高 5 栋用玻璃幕墙参数曲面。', '🏙 Lujiazui towers; top 5 use glass parametric facades.'], city.lujiazui.filter(b => !heroSet.has(b)), 'simple');
  group('ifc', ['🏙 国金中心风格双塔与裙楼。', '🏙 IFC-style twin towers and podium.'], city.ifc, 'simple');
  text('最高的 5 栋陆家嘴塔楼：方截面幕墙，竖梃/楼层线来自 f_ace，向上收分。', 'Top 5 Lujiazui towers: square curtain walls with f_ace mullions, tapering up.');
  putLists('hero', heroes);
  ex(wall('hero', 'H_{hero}v', '1', '1', true), { colorLatex: 'C_{glass}' });
  ex(lid('hero', 'H_{hero}', 'K_{hero}', 'L_{hero}'), { colorLatex: 'C_{roof}' });

  // ── 金茂：八边形截面，逐层出檐 ──
  text('🗼 金茂大厦（421 m）：八边形截面，沿高度 13 次出檐收分，青铜色幕墙，顶部金色尖塔。', '🗼 Jin Mao Tower (421 m): octagonal section with 13 eaves, bronze curtain wall and a gold spire.');
  ex('r_{jm}\\left(v\\right)=0.30-0.15v+0.022\\max\\left(0,\\cos\\left(26\\pi v\\right)\\right)^{6}');
  ex(`\\left(${f(JINMAO.x)}+q_{x}\\cos\\left(-0.42\\right)-q_{y}\\sin\\left(-0.42\\right),${f(JINMAO.y)}+q_{x}\\sin\\left(-0.42\\right)+q_{y}\\cos\\left(-0.42\\right),4.02v\\right)\\operatorname{with}q_{x}=r_{jm}\\left(v\\right)\\sec\\left(\\operatorname{mod}\\left(2\\pi u,\\frac{\\pi}{4}\\right)-\\frac{\\pi}{8}\\right)\\cos\\left(2\\pi u\\right),q_{y}=r_{jm}\\left(v\\right)\\sec\\left(\\operatorname{mod}\\left(2\\pi u,\\frac{\\pi}{4}\\right)-\\frac{\\pi}{8}\\right)\\sin\\left(2\\pi u\\right)`, { colorLatex: 'C_{jinmao}' });
  ex(`\\left(${f(JINMAO.x)}+0.42v\\sec\\left(\\operatorname{mod}\\left(2\\pi u-\\frac{\\pi}{4},\\frac{\\pi}{2}\\right)-\\frac{\\pi}{4}\\right)\\cos\\left(2\\pi u-0.42\\right),${f(JINMAO.y)}+0.42v\\sec\\left(\\operatorname{mod}\\left(2\\pi u-\\frac{\\pi}{4},\\frac{\\pi}{2}\\right)-\\frac{\\pi}{4}\\right)\\sin\\left(2\\pi u-0.42\\right),0.16\\right)`, { colorLatex: 'C_{podium}' });
  ex(`\\left(${f(JINMAO.x)}+0.05\\left(1-v\\right)\\cos\\left(2\\pi u\\right),${f(JINMAO.y)}+0.05\\left(1-v\\right)\\sin\\left(2\\pi u\\right),4.02+0.19v\\right)`, { color: '#e6d7a2' });

  // ── 环球金融中心：一个方向收到刀锋，洞口用四根框而不是一块挡板 ──
  text('🗼 上海环球金融中心（492 m）：梯形刀锋收分，幕墙有窗格，顶部「开瓶器」是透空的框。', '🗼 Shanghai World Financial Center (492 m): tapers to a blade, with a window grid and an open bottle-opener frame.');
  ex(`\\left(${f(SWFC.x)}+q_{x}\\cos\\left(0.35\\right)-q_{y}\\sin\\left(0.35\\right),${f(SWFC.y)}+q_{x}\\sin\\left(0.35\\right)+q_{y}\\cos\\left(0.35\\right),4.92v\\right)\\operatorname{with}q_{x}=0.3\\left(1-0.12v\\right)${RHO}\\cos\\left(2\\pi u\\right),q_{y}=0.3\\left(1-0.82v\\right)${RHO}\\sin\\left(2\\pi u\\right)`, { colorLatex: 'C_{glass}' });
  {
    const a = 0.35, c = Math.cos(a), s = Math.sin(a);
    const at = (lx: number, ly: number, z: number): Building => ({
      x: SWFC.x + lx * c - ly * s, y: SWFC.y + lx * s + ly * c,
      w: 0.02, d: 0.018, h: 0.04, k: 1, l: 1, a, c: [232, 240, 246],
    });
    const frame: Building[] = [
      { ...at(-0.1, 0, 4.42), w: 0.016, d: 0.02, h: 0.36 },
      { ...at(0.1, 0, 4.42), w: 0.016, d: 0.02, h: 0.36 },
      { ...at(0, 0, 4.42), w: 0.11, d: 0.016, h: 0.028 },
      { ...at(0, 0, 4.75), w: 0.1, d: 0.014, h: 0.028 },
    ];
    group('swh', ['开瓶器洞口：左右两根立柱加上下两根横梁，中间是空的。', 'Aperture: two posts and two beams, open in the middle.'], frame, 'simple', b => [4.42, 4.42, 4.42, 4.75][frame.indexOf(b)]);
  }

  // ── 上海中心 ──
  text('🗼 上海中心大厦（632 m）：圆角三角形截面，自下而上收分并扭转 120°。设备层亮带与竖梃来自 C_st。', '🗼 Shanghai Tower (632 m): rounded-triangle taper + 120° twist; C_st for bands/mullions.');
  ex('C_{st}=\\operatorname{rgb}\\left(150+70\\max\\left(0,\\cos\\left(9z\\right)\\right)^{30}-42\\max\\left(0,\\cos\\left(16\\pi u\\right)\\right)^{8}-22\\max\\left(0,\\cos\\left(\\frac{2\\pi z}{0.08}\\right)\\right)^{8},178+55\\max\\left(0,\\cos\\left(9z\\right)\\right)^{30}-30\\max\\left(0,\\cos\\left(16\\pi u\\right)\\right)^{8}-16\\max\\left(0,\\cos\\left(\\frac{2\\pi z}{0.08}\\right)\\right)^{8},196+45\\max\\left(0,\\cos\\left(9z\\right)\\right)^{30}-18\\max\\left(0,\\cos\\left(16\\pi u\\right)\\right)^{8}\\right)', { hidden: true });
  ex(`r_{st}\\left(u,v\\right)=0.43\\left(1-0.55v\\right)\\left(1+0.11\\cos\\left(3\\left(2\\pi u-\\frac{2\\pi}{3}v\\right)\\right)\\right)`);
  // 裙楼底座
  ex(`\\left(${f(SHTOWER.x)}+0.55v\\sec\\left(\\operatorname{mod}\\left(2\\pi u-\\frac{\\pi}{4},\\frac{\\pi}{2}\\right)-\\frac{\\pi}{4}\\right)\\cos\\left(2\\pi u\\right),${f(SHTOWER.y)}+0.55v\\sec\\left(\\operatorname{mod}\\left(2\\pi u-\\frac{\\pi}{4},\\frac{\\pi}{2}\\right)-\\frac{\\pi}{4}\\right)\\sin\\left(2\\pi u\\right),0.22\\right)`, { colorLatex: 'C_{podium}' });
  ex(`\\left(${f(SHTOWER.x)}+r_{st}\\left(u,v\\right)\\cos\\left(2\\pi u\\right),${f(SHTOWER.y)}+r_{st}\\left(u,v\\right)\\sin\\left(2\\pi u\\right),0.22+5.88v\\right)`, { colorLatex: 'C_{st}' });
  ex(`\\left(${f(SHTOWER.x)}+r_{st}\\left(u,1\\right)\\cos\\left(2\\pi u\\right),${f(SHTOWER.y)}+r_{st}\\left(u,1\\right)\\sin\\left(2\\pi u\\right),6.1+0.22v\\left(1+\\cos\\left(2\\pi u-\\frac{2\\pi}{3}\\right)\\right)\\right)`, { color: '#a9c3d2' });
  ex(`\\left(${f(SHTOWER.x)}+vr_{st}\\left(u,1\\right)\\cos\\left(2\\pi u\\right),${f(SHTOWER.y)}+vr_{st}\\left(u,1\\right)\\sin\\left(2\\pi u\\right),6.1\\right)`, { color: '#8fa9b8' });

  // ── 东方明珠 ──
  const P = PEARL;
  text('🔴 东方明珠（468 m）：三根立柱 + 三根斜撑 + 下球（直径 50 m）+ 五颗小球 + 上球（直径 45 m）+ 太空舱 + 天线；底部有圆形观景平台。', '🔴 Oriental Pearl Tower (468 m): columns, slanted legs, spheres, space module, antenna and a circular podium.');
  ex('C_{pearl}=\\operatorname{rgb}\\left(196,46,104\\right)');
  // 底座圆环平台
  ex(`\\left(${f(P.x)}+\\left(0.55+0.12v\\right)\\cos\\left(2\\pi u\\right),${f(P.y)}+\\left(0.55+0.12v\\right)\\sin\\left(2\\pi u\\right),0.02+0.06v\\right)`, { color: '#d8d0c6' });
  ex(`\\left(${f(P.x)}+0.11\\cos\\left(\\frac{2\\pi}{3}\\cdot\\left[0,1,2\\right]\\right)+0.045\\cos\\left(2\\pi u\\right),${f(P.y)}+0.11\\sin\\left(\\frac{2\\pi}{3}\\cdot\\left[0,1,2\\right]\\right)+0.045\\sin\\left(2\\pi u\\right),2.75v\\right)`, { color: '#e3ddd6' });
  ex(`\\left(${f(P.x)}+\\left(0.6-0.5v\\right)\\cos\\left(\\frac{2\\pi}{3}\\cdot\\left[0,1,2\\right]+\\frac{\\pi}{3}\\right)+0.04\\cos\\left(2\\pi u\\right),${f(P.y)}+\\left(0.6-0.5v\\right)\\sin\\left(\\frac{2\\pi}{3}\\cdot\\left[0,1,2\\right]+\\frac{\\pi}{3}\\right)+0.04\\sin\\left(2\\pi u\\right),0.95v\\right)`, { color: '#e3ddd6' });
  ex(`\\operatorname{sphere}\\left(${pt(P.x, P.y, 0.93)},0.25\\right)`, { colorLatex: 'C_{pearl}' });
  ex(`\\left(${f(P.x)}+\\left(0.25+0.014\\cos\\left(2\\pi v\\right)\\right)\\cos\\left(2\\pi u\\right),${f(P.y)}+\\left(0.25+0.014\\cos\\left(2\\pi v\\right)\\right)\\sin\\left(2\\pi u\\right),0.93+0.014\\sin\\left(2\\pi v\\right)\\right)`, { color: '#f7e7ee' });
  ex(`\\operatorname{sphere}\\left(\\left(${f(P.x)}+0.11\\cos\\left(\\frac{2\\pi}{3}\\cdot\\left[0,1,2,0,1\\right]\\right),${f(P.y)}+0.11\\sin\\left(\\frac{2\\pi}{3}\\cdot\\left[0,1,2,0,1\\right]\\right),\\left[1.45,1.62,1.79,1.96,2.13\\right]\\right),0.07\\right)`, { colorLatex: 'C_{pearl}' });
  ex(`\\operatorname{sphere}\\left(${pt(P.x, P.y, 2.63)},0.225\\right)`, { colorLatex: 'C_{pearl}' });
  ex(`\\left(${f(P.x)}+\\left(0.225+0.014\\cos\\left(2\\pi v\\right)\\right)\\cos\\left(2\\pi u\\right),${f(P.y)}+\\left(0.225+0.014\\cos\\left(2\\pi v\\right)\\right)\\sin\\left(2\\pi u\\right),2.63+0.014\\sin\\left(2\\pi v\\right)\\right)`, { color: '#f7e7ee' });
  ex(`\\left(${f(P.x)}+0.05\\cos\\left(2\\pi u\\right),${f(P.y)}+0.05\\sin\\left(2\\pi u\\right),2.75+0.75v\\right)`, { color: '#e3ddd6' });
  ex(`\\operatorname{sphere}\\left(${pt(P.x, P.y, 3.5)},0.08\\right)`, { colorLatex: 'C_{pearl}' });
  ex(`\\left(${f(P.x)}+0.03\\left(1-v\\right)\\cos\\left(2\\pi u\\right),${f(P.y)}+0.03\\left(1-v\\right)\\sin\\left(2\\pi u\\right),3.55+1.13v\\right)`, { color: '#d9d9d9' });
  ex(`\\operatorname{sphere}\\left(${pt(P.x, P.y, 4.68)},0.025\\right)`, { color: '#c8c8c8' });
  ex(`\\left(${f(P.x)}+0.75v\\cos\\left(2\\pi u\\right),${f(P.y)}+0.75v\\sin\\left(2\\pi u\\right),0.014\\right)`, { color: '#cfc6bb' });

  // ── 南浦大桥（实体桥面 + 线段拱，参考 Ultra OBJ，去掉会穿模的参数曲面）──
  text(
    '🌉 南浦大桥：桥墩/桥面用三角体抬高离开江面与护岸；双拱与吊索只用线段，避免参数曲面穿进水面。',
    '🌉 Nanpu Bridge: solid deck/piers clear of water; arches & hangers are segments only (no parametric z-fighting).',
  );
  {
    const by = BRIDGE.y;
    const zDeck = 0.22;
    const deckH = 0.055;
    const x0 = -5.2;
    const x1 = 0.05;
    const xMid = (x0 + x1) / 2;
    const halfLen = (x1 - x0) / 2;
    // 桥墩略低于桥面底，避免共面闪烁；桥面抬高离开水面/护岸
    const brParts: Building[] = [
      { x: xMid, y: by, w: halfLen, d: 0.18, h: deckH, k: 1, l: 1, a: 0, c: [108, 116, 124] },
      { x: x0 + 0.16, y: by, w: 0.1, d: 0.14, h: zDeck - 0.01, k: 1, l: 1, a: 0, c: [82, 86, 92] },
      { x: x1 - 0.16, y: by, w: 0.1, d: 0.14, h: zDeck - 0.01, k: 1, l: 1, a: 0, c: [82, 86, 92] },
    ];
    (brParts[0] as any).z0 = zDeck;
    (brParts[1] as any).z0 = 0;
    (brParts[2] as any).z0 = 0;
    group(
      'br',
      ['桥面与桥墩（实体，z 与水面错开）。', 'Deck and piers (solid, z-clear of water).'],
      brParts,
      'simple',
      b => (b as any).z0 ?? 0,
    );

    const peak = 0.95;
    const N = 12;
    const archY = [by - 0.14, by + 0.14];
    for (const yArch of archY) {
      const pts: string[] = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const x = x0 + (x1 - x0) * t;
        const z = zDeck + deckH + peak * 4 * t * (1 - t);
        pts.push(pt(x, yArch, z));
      }
      ex(`\\operatorname{segment}\\left(${list(pts.slice(0, -1))},${list(pts.slice(1))}\\right)`, { color: '#c84a34' });
    }
    const hangTop: string[] = [];
    const hangBot: string[] = [];
    for (let i = 2; i <= N - 2; i += 2) {
      const t = i / N;
      const x = x0 + (x1 - x0) * t;
      const z = zDeck + deckH + peak * 4 * t * (1 - t);
      for (const yArch of archY) {
        hangTop.push(pt(x, yArch, z));
        hangBot.push(pt(x, by + (yArch - by) * 0.25, zDeck + deckH));
      }
    }
    ex(`\\operatorname{segment}\\left(${list(hangTop)},${list(hangBot)}\\right)`, { color: '#b7bdc4' });
  }

  // ── 行道树（模型不变；T_r 点列关绘图，否则每个树脚都会变成一个点）──
  text(
    `🌳 行道树 ${trees.length} 棵：模型仍是树干+球形树冠；只加大间距并避开建筑/桥。T_r 公式在列表中，关闭绘图避免脚点。`,
    `🌳 ${trees.length} trees: same trunk+sphere model; spacing only. T_r listed but plot off so bases are not dots.`,
  );
  ex(`T_{r}=${list(trees.map(([x, y]) => pt(x, y, 0)))}`, { hidden: true });
  ex('\\operatorname{segment}\\left(T_{r},T_{r}+\\left(0,0,0.16\\right)\\right)', { colorLatex: 'C_{trunk}' });
  ex('\\operatorname{sphere}\\left(T_{r}+\\left(0,0,0.2\\right),0.1k_{leaf}\\right)', { colorLatex: 'C_{leaf}' });

  // ── 渡轮沿江航行（默认不自动播放，避免进场时每帧重算）──
  text('⛴ 渡轮：b_t 默认自动播放，两艘船沿黄浦江心线南→北→东循环；可点滑块暂停。', '⛴ Ferries: b_t auto-plays along the Huangpu; pause on the slider if needed.');
  ex('b_{t}=0.2', { slider: { hardMin: true, hardMax: true, min: '0', max: '1', step: '0.002', animationPeriod: 28000, loopMode: 'LOOP_FORWARD', isPlaying: true } } as any);
  ex('s_{1}=0.387');
  ex('s_{2}=0.699');
  // 航道函数若开绘图会铺成怪曲线；船位点列同理会变成点
  ex('R_{x}\\left(s\\right)=\\left\\{s<s_{1}:-2.6,s<s_{2}:2+4.6\\cos\\left(\\pi-\\frac{\\pi\\left(s-s_{1}\\right)}{2\\left(s_{2}-s_{1}\\right)}\\right),2+\\frac{7\\left(s-s_{2}\\right)}{1-s_{2}}\\right\\}', { hidden: true });
  ex('R_{y}\\left(s\\right)=\\left\\{s<s_{1}:-8+\\frac{9s}{s_{1}},s<s_{2}:1+4.6\\sin\\left(\\pi-\\frac{\\pi\\left(s-s_{1}\\right)}{2\\left(s_{2}-s_{1}\\right)}\\right),5.6\\right\\}', { hidden: true });
  ex('R_{a}\\left(s\\right)=\\left\\{s<s_{1}:0,s<s_{2}:-\\frac{\\pi\\left(s-s_{1}\\right)}{2\\left(s_{2}-s_{1}\\right)},-\\frac{\\pi}{2}\\right\\}', { hidden: true });
  ex('\\Phi=\\left[0,0.5\\right]');
  ex('S_{bo}=\\left[\\operatorname{mod}\\left(b_{t}+\\Phi\\left[i\\right],1\\right)\\operatorname{for}i=\\left[1...2\\right]\\right]');
  ex('P_{bo}=\\left[\\left(R_{x}\\left(S_{bo}\\left[i\\right]\\right),R_{y}\\left(S_{bo}\\left[i\\right]\\right),-0.03\\right)\\operatorname{for}i=\\left[1...2\\right]\\right]', { hidden: true });
  ex('A_{bo}=\\left[R_{a}\\left(S_{bo}\\left[i\\right]\\right)\\operatorname{for}i=\\left[1...2\\right]\\right]');
  ex('W_{bo}=\\left[0.11,0.095\\right]');
  ex('D_{bo}=\\left[0.34,0.28\\right]');
  ex('H_{bo}=\\left[0.075,0.065\\right]');
  ex('G_{bo}=\\operatorname{rgb}\\left(\\left[240,248\\right],\\left[240,248\\right],\\left[236,240\\right]\\right)');
  {
    const hull = (U: string) =>
      `B\\left(U_{${U}}\\left[j\\right],P_{bo}\\left[i\\right],W_{bo}\\left[i\\right],D_{bo}\\left[i\\right],H_{bo}\\left[i\\right],0.7,0.55,A_{bo}\\left[i\\right]\\right)`;
    ex(`Q_{bo}=\\left[G_{bo}\\left[i\\right]\\operatorname{for}j=\\left[1...10\\right],i=\\left[1...2\\right]\\right]`);
    ex(`\\left[\\operatorname{triangle}\\left(${hull('a')},${hull('b')},${hull('c')}\\right)\\operatorname{for}j=\\left[1...10\\right],i=\\left[1...2\\right]\\right]`, { colorLatex: 'Q_{bo}' });
    const cabin = (U: string) =>
      `B\\left(U_{${U}}\\left[j\\right],P_{bo}\\left[i\\right]+\\left(0,0,H_{bo}\\left[i\\right]\\right),0.5\\cdot W_{bo}\\left[i\\right],0.32\\cdot D_{bo}\\left[i\\right],0.045,1,1,A_{bo}\\left[i\\right]\\right)`;
    ex(`\\left[\\operatorname{triangle}\\left(${cabin('a')},${cabin('b')},${cabin('c')}\\right)\\operatorname{for}j=\\left[1...10\\right],i=\\left[1...2\\right]\\right]`, { color: '#3d7ea6' });
  }

  return out;
}

/** 摄像机：贴近外滩西岸、略抬高，向东望陆家嘴天际线（明信片构图） */
export const SHANGHAI_VIEW = {
  viewport: { xmin: -7.5, xmax: 9, ymin: -8.25, ymax: 8.25, zmin: -5, zmax: 11.5 },
  rotation: () => uprightViewMatrix(-98, 14),
};

function toStateList(exprs: Desmos3DExpression[]): Record<string, unknown>[] {
  return exprs.map(e => {
    if (e.type === 'text') return { type: 'text', id: e.id, text: e.text ?? '' };
    const o: Record<string, unknown> = { type: 'expression', id: e.id, latex: e.latex };
    if (e.color) o.color = e.color;
    if (e.colorLatex) o.colorLatex = e.colorLatex;
    // hidden 只关「绘图」，左侧列表仍完整展示每一行（绝不 secret / 压缩省略）
    if (e.hidden) o.hidden = true;
    if ((e as any).slider) o.slider = (e as any).slider;
    return o;
  });
}

function applyShanghaiViewport(st: any) {
  const v = SHANGHAI_VIEW.viewport;
  st.graph = {
    ...(st.graph || {}),
    viewport: { ...v },
    __v12ViewportLatexStash: Object.fromEntries(Object.entries(v).map(([k, n]) => [k, String(n)])),
    worldRotation3D: SHANGHAI_VIEW.rotation(),
    showBox3D: false,
    showPlane3D: false,
    showAxis3D: false,
    showNumbers3D: false,
    showAxisLabels3D: false,
  };
}

/** 同步写入（测试 / 兼容）。大场景更推荐 loadShanghaiSceneProgressive */
export function loadShanghaiScene(calculator: any, lang: string = 'zh'): number {
  const list = toStateList(buildShanghaiSceneExpressions(lang));
  const st = calculator.getState();
  st.expressions = { ...(st.expressions || {}), list };
  applyShanghaiViewport(st);
  calculator.setState(st, { allowUndo: true });
  try {
    const boat = list.find((e: any) => typeof e.latex === 'string' && /^b_\{t\}=/.test(e.latex));
    if (boat?.id && typeof calculator.setExpression === 'function') {
      calculator.setExpression({
        id: boat.id,
        latex: boat.latex,
        slider: { ...(boat.slider || {}), isPlaying: true, loopMode: 'LOOP_FORWARD' },
      });
    }
  } catch {
    /* ignore */
  }
  return list.length;
}

function yieldToRenderer(ms = 28): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(resolve, ms));
    } else {
      setTimeout(resolve, ms);
    }
  });
}

/**
 * 分批写入场景，避免一次 setState 卡住导致「加载不全」。
 * 每一行公式仍完整进入左侧列表，不做 secret、不截断。
 * 末尾再整表落盘一次，防止中途丢行。
 */
export async function loadShanghaiSceneProgressive(
  calculator: any,
  lang: string = 'zh',
  options?: {
    batchSize?: number;
    signal?: AbortSignal;
    onProgress?: (current: number, total: number) => void;
  },
): Promise<number> {
  const exprs = buildShanghaiSceneExpressions(lang);
  const list = toStateList(exprs);
  const batchSize = Math.max(6, options?.batchSize ?? 12);
  const signal = options?.signal;

  const abortIfNeeded = () => {
    if (!signal?.aborted) return;
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  };

  // 先清空并设好视角，再分批追加
  {
    const st = calculator.getState();
    st.expressions = { ...(st.expressions || {}), list: [] };
    applyShanghaiViewport(st);
    calculator.setState(st, { allowUndo: true });
  }
  await yieldToRenderer(40);

  for (let i = 0; i < list.length; i += batchSize) {
    abortIfNeeded();
    const chunk = list.slice(i, i + batchSize);
    const st = calculator.getState();
    const cur: any[] = (st.expressions && st.expressions.list) || [];
    st.expressions = { ...(st.expressions || {}), list: cur.concat(chunk) };
    // 视角只在首批保留；后续批不覆盖用户旋转
    if (i === 0) applyShanghaiViewport(st);
    calculator.setState(st, { allowUndo: true });
    options?.onProgress?.(Math.min(i + chunk.length, list.length), list.length);
    // 重负载批（三角楼群）多让出一点时间，降低「画到一半卡住」概率
    const heavy = chunk.some(e => typeof e.latex === 'string' && e.latex.includes('triangle'));
    await yieldToRenderer(heavy ? 48 : 28);
  }

  // 保险：整表再写一次，确保左侧列表与画布一致、无丢行
  abortIfNeeded();
  {
    const st = calculator.getState();
    st.expressions = { ...(st.expressions || {}), list };
    applyShanghaiViewport(st);
    calculator.setState(st, { allowUndo: true });
  }
  options?.onProgress?.(list.length, list.length);
  await yieldToRenderer(60);

  // 部分 Desmos 版本 setState 会丢掉 isPlaying，再点一次确保渡轮动起来
  try {
    const st = calculator.getState();
    const boat = ((st.expressions && st.expressions.list) || []).find(
      (e: any) => typeof e.latex === 'string' && /^b_\{t\}=/.test(e.latex),
    );
    if (boat?.id && typeof calculator.setExpression === 'function') {
      calculator.setExpression({
        id: boat.id,
        latex: boat.latex,
        slider: { ...(boat.slider || {}), isPlaying: true, loopMode: 'LOOP_FORWARD' },
      });
    }
  } catch {
    /* ignore */
  }

  return list.length;
}
