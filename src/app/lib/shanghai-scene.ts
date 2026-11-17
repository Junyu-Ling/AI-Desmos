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
  // 海关大楼钟楼、和平饭店（绿色金字塔顶在单独的表达式里）
  const customs = bund.reduce((best, b) => (Math.abs(b.y + 3.2) < Math.abs(best.y + 3.2) ? b : best), bund[0]);
  customs.h = 0.42;
  const peace = bund.reduce((best, b) => (Math.abs(b.y + 1.6) < Math.abs(best.y + 1.6) ? b : best), bund[0]);
  peace.h = 0.62;
  const bundTowers: Building[] = [
    { x: customs.x + 0.12, y: customs.y, w: 0.1, d: 0.1, h: 0.42 + 0.48, k: 0.8, l: 0.8, a: 0, c: [222, 210, 182] },
  ];

  // 浦西纵深：现代高楼
  const puxi = scatterBuildings(
    rnd, 34,
    { x0: -7.4, x1: -6.15, y0: -8.1, y1: 4 },
    (x, y) => riverDist(x, y) > RIVER_HALF + 0.6,
    (x, y) => {
      const t = rnd();
      return { w: 0.18 + rnd() * 0.2, d: 0.18 + rnd() * 0.2, h: 0.4 + t * t * 0.9, k: 0.9 + rnd() * 0.1, l: 0.9 + rnd() * 0.1, a: rnd() * 0.5 - 0.25, c: shade(t > 0.6 ? [150, 172, 190] : [176, 170, 162], rnd) };
    },
    0.62, bund,
  );

  // 北岸（虹口、北外滩）
  const north = scatterBuildings(
    rnd, 30,
    { x0: -7.4, x1: 8.9, y0: 7.55, y1: 8.1 },
    (x, y) => riverDist(x, y) > RIVER_HALF + 0.5,
    () => {
      const t = rnd();
      return { w: 0.18 + rnd() * 0.2, d: 0.18 + rnd() * 0.18, h: 0.35 + t * t * 1.9, k: 0.92 + rnd() * 0.08, l: 0.92 + rnd() * 0.08, a: rnd() * 0.6 - 0.3, c: shade(t > 0.55 ? [140, 165, 182] : [184, 176, 166], rnd) };
    },
    0.6, [],
  );

  // 陆家嘴楼群：越靠近三塔越高
  const keep = [PEARL, JINMAO, SWFC, SHTOWER];
  const lujiazui = scatterBuildings(
    rnd, 52,
    { x0: -0.6, x1: 8.9, y0: -8.1, y1: 4.6 },
    (x, y) =>
      riverDist(x, y) > RIVER_HALF + 0.75 &&
      keep.every(p => Math.hypot(p.x - x, p.y - y) > 0.95) &&
      Math.hypot(GREEN.x - x, GREEN.y - y) > GREEN.r + 0.35 &&
      Math.abs(centuryAvenueDist(x, y)) > 0.4,
    (x, y) => {
      const near = Math.exp(-((x - 4.6) ** 2 + (y + 2) ** 2) / 14);
      const t = rnd();
      const glass = t > 0.3;
      return {
        w: 0.2 + rnd() * 0.18, d: 0.2 + rnd() * 0.18,
        h: 0.5 + near * (0.9 + 1.3 * t) + t * 0.5,
        k: 0.85 + rnd() * 0.15, l: 0.85 + rnd() * 0.15,
        a: -0.42 + (rnd() - 0.5) * 0.2,
        c: shade(glass ? [120, 150, 172] : [190, 186, 178], rnd, 16),
      };
    },
    0.7, [],
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

  // 江上渡轮
  const boats: Building[] = [
    { x: -2.2, y: -3.5, w: 0.08, d: 0.26, h: 0.08, k: 0.9, l: 0.8, a: 0.05, c: [236, 236, 230] },
    { x: -3.0, y: -0.8, w: 0.07, d: 0.22, h: 0.07, k: 0.9, l: 0.8, a: -0.05, c: [210, 60, 50] },
    { x: 5.5, y: 5.4, w: 0.24, d: 0.08, h: 0.08, k: 0.8, l: 0.9, a: 0, c: [236, 236, 230] },
  ];

  return { bund, bundTowers, puxi, north, lujiazui, jinmao, jinmaoTop, swfc, boats, peace, customs };
}

/** 世纪大道：从东方明珠向东南延伸 */
function centuryAvenueDist(x: number, y: number) {
  const ax = PEARL.x + 0.6, ay = PEARL.y - 0.5, dx = Math.cos(-0.72), dy = Math.sin(-0.72);
  return (x - ax) * -dy + (y - ay) * dx;
}

function buildTrees() {
  const rnd = mulberry32(42);
  const pts: [number, number][] = [];
  for (let y = -7.9; y <= 0.6; y += 0.32) pts.push([-4.62, y]);
  for (let a = 1.75; a <= 3.05; a += 0.085) {
    const r = 4.6 - RIVER_HALF - 0.35;
    pts.push([2 + r * Math.cos(a), 1 + r * Math.sin(a)]);
  }
  for (let i = 0; i < 26; i++) {
    const ang = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * (GREEN.r - 0.12);
    pts.push([GREEN.x + rr * Math.cos(ang), GREEN.y + rr * Math.sin(ang)]);
  }
  const ax = PEARL.x + 0.6, ay = PEARL.y - 0.5, dx = Math.cos(-0.72), dy = Math.sin(-0.72);
  for (let s = 0.3; s < 9; s += 0.38) {
    for (const side of [-0.3, 0.3]) pts.push([ax + dx * s - dy * side, ay + dy * s + dx * side]);
  }
  return pts.filter(([x, y]) => riverDist(x, y) > RIVER_HALF + 0.15 && x > -7.4 && x < 8.9 && Math.abs(y) < 8.15 && Math.hypot(x - PEARL.x, y - PEARL.y) > 0.8);
}

/** 生成场景的全部表达式（全部明文列出，不隐藏、不压缩） */
export function buildShanghaiSceneExpressions(lang: string = 'zh'): Desmos3DExpression[] {
  const zh = lang !== 'en';
  const city = buildCity();
  const trees = buildTrees();
  const out: Desmos3DExpression[] = [];
  let seq = 0;
  const id = (p: string) => `sh_${p}_${seq++}`;
  const text = (zhText: string, enText: string) => out.push({ id: id('t'), type: 'text', text: zh ? zhText : enText });
  const ex = (latex: string, extra: Partial<Desmos3DExpression> = {}) => out.push({ id: id('e'), latex, ...extra });

  text(
    '上海陆家嘴 · 四季｜1 单位 = 100 米，建筑按真实高度：东方明珠 468 m、上海中心 632 m、环球金融中心 492 m、金茂 421 m。拖动 t₀ 看一年四季：0 春 → 0.25 夏 → 0.5 秋 → 0.75 冬（点滑块的播放键可自动循环）。',
    'Shanghai Lujiazui · Four Seasons | 1 unit = 100 m with real heights. Drag t₀ through the year: 0 spring → 0.25 summer → 0.5 autumn → 0.75 winter (press play to loop).',
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

  // ── 工具函数 ──
  text('🧰 工具函数：U_a/U_b/U_c 是单位立方体 10 个三角面（不含底面）的顶点；B(p,c,w,d,h,k,l,a) 把单位立方体变成底心 c、半宽 w×d、高 h、顶部收分 k/l、转角 a 的楼块。', '🧰 Helpers: U_a/U_b/U_c are the 10 faces of a unit cube; B(p,c,w,d,h,k,l,a) maps it to a block with base center c, half sizes w×d, height h, top taper k/l, rotation a.');
  const faces: [number[], number[], number[]][] = [
    [[0, 0, 1], [1, 0, 1], [1, 1, 1]], [[0, 0, 1], [1, 1, 1], [0, 1, 1]],
    [[0, 0, 0], [1, 0, 0], [1, 0, 1]], [[0, 0, 0], [1, 0, 1], [0, 0, 1]],
    [[0, 1, 0], [1, 1, 0], [1, 1, 1]], [[0, 1, 0], [1, 1, 1], [0, 1, 1]],
    [[0, 0, 0], [0, 1, 0], [0, 1, 1]], [[0, 0, 0], [0, 1, 1], [0, 0, 1]],
    [[1, 0, 0], [1, 1, 0], [1, 1, 1]], [[1, 0, 0], [1, 1, 1], [1, 0, 1]],
  ];
  (['a', 'b', 'c'] as const).forEach((n, k) =>
    ex(`U_{${n}}=${list(faces.map(t => `\\left(${t[k].join(',')}\\right)`))}`, { hidden: true }),
  );
  ex('B\\left(p,c,w,d,h,k,l,a\\right)=c+\\left(Q.x\\cos\\left(a\\right)-Q.y\\sin\\left(a\\right),Q.x\\sin\\left(a\\right)+Q.y\\cos\\left(a\\right),hp.z\\right)\\operatorname{with}Q=\\left(\\left(2p.x-1\\right)w\\left(1-\\left(1-k\\right)p.z\\right),\\left(2p.y-1\\right)d\\left(1-\\left(1-l\\right)p.z\\right)\\right)');
  ex('d_{r}\\left(x,y\\right)=\\left\\{y<1:\\left|x+2.6\\right|,x>2:\\left|y-5.6\\right|,\\left|\\sqrt{\\left(x-2\\right)^{2}+\\left(y-1\\right)^{2}}-4.6\\right|\\right\\}', { hidden: true });

  // ── 地面与黄浦江 ──
  text('🌊 地面与黄浦江：d_r 是到江心线的距离（自南向北流经外滩，在陆家嘴北侧折向东），江面半宽 170 m；平面 + 区域限制得到陆地、江面、草坪和世纪大道。', '🌊 Ground & Huangpu River: d_r = distance to the river centerline; planes + region restrictions give land, water, lawn and Century Avenue.');
  ex(`z=0\\left\\{d_{r}\\left(x,y\\right)>${RIVER_HALF}\\right\\}\\left\\{-7.5<x<9\\right\\}\\left\\{-8.25<y<8.25\\right\\}`, { colorLatex: 'C_{ground}' });
  ex(`z=-0.06+0.012\\sin\\left(5x+3y\\right)\\sin\\left(4y-2x\\right)\\left\\{d_{r}\\left(x,y\\right)<${RIVER_HALF}\\right\\}\\left\\{-7.5<x<9\\right\\}\\left\\{-8.25<y<8.25\\right\\}`, { colorLatex: 'C_{water}' });
  ex(`z=0.012\\left\\{\\left(x-${f(GREEN.x)}\\right)^{2}+\\left(y-${f(GREEN.y)}\\right)^{2}<${f(GREEN.r ** 2)}\\right\\}`, { colorLatex: 'C_{grass}' });
  ex(`z=0.008\\left\\{\\left|\\left(x-${f(PEARL.x + 0.6)}\\right)\\sin\\left(0.72\\right)+\\left(y-${f(PEARL.y - 0.5)}\\right)\\cos\\left(0.72\\right)\\right|<0.14\\right\\}\\left\\{\\left(x-${f(PEARL.x + 0.6)}\\right)\\cos\\left(0.72\\right)-\\left(y-${f(PEARL.y - 0.5)}\\right)\\sin\\left(0.72\\right)>0\\right\\}\\left\\{-7.5<x<9\\right\\}\\left\\{-8.25<y<8.25\\right\\}`, { color: '#55585e' });
  ex('z=0.006\\left\\{-4.92<x<-4.35\\right\\}\\left\\{-8.2<y<0.9\\right\\}', { color: '#b9ab94' });

  // ── 楼群 ──
  const group = (tag: string, title: [string, string], bs: Building[], withSnow: boolean, zOf?: (b: Building) => number) => {
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
    if (withSnow) {
      const snowArgs = (U: string) =>
        `B\\left(U_{${U}}\\left[j\\right],P_{${tag}}\\left[i\\right]+\\left(0,0,H_{${tag}}\\left[i\\right]-0.03\\right),W_{${tag}}\\left[i\\right]K_{${tag}}\\left[i\\right]+0.004,D_{${tag}}\\left[i\\right]L_{${tag}}\\left[i\\right]+0.004,0.03+s_{now},1,1,A_{${tag}}\\left[i\\right]\\right)`;
      ex(`\\left[\\operatorname{triangle}\\left(${snowArgs('a')},${snowArgs('b')},${snowArgs('c')}\\right)\\operatorname{for}j=\\left[1...10\\right],i=\\left[1...${n}\\right]\\right]`, { colorLatex: 'C_{snow}' });
    }
  };

  group('bund', ['🏛 外滩万国建筑群：沿江一排石材建筑，含海关大楼钟楼与和平饭店（绿色金字塔顶）。', '🏛 The Bund: a riverside row of stone buildings incl. the Customs House clock tower and the Peace Hotel.'], city.bund, true);
  group('bt', ['海关大楼钟楼', 'Customs House clock tower'], city.bundTowers, true, () => 0);
  const p = city.peace;
  const top = p.h, ph = 0.22;
  ex(`\\operatorname{triangle}\\left(${list([pt(p.x - 0.12, p.y - 0.12, top), pt(p.x + 0.12, p.y - 0.12, top), pt(p.x + 0.12, p.y + 0.12, top), pt(p.x - 0.12, p.y + 0.12, top)])},${list([pt(p.x + 0.12, p.y - 0.12, top), pt(p.x + 0.12, p.y + 0.12, top), pt(p.x - 0.12, p.y + 0.12, top), pt(p.x - 0.12, p.y - 0.12, top)])},${pt(p.x, p.y, top + ph)}\\right)`, { color: '#3f8f6b' });
  ex(`\\operatorname{sphere}\\left(${pt(city.customs.x + 0.2, city.customs.y, 0.74)},0.04\\right)`, { color: '#f2ead2' });

  group('px', ['🏙 浦西纵深的高楼。', '🏙 Puxi high-rises behind the Bund.'], city.puxi, true);
  group('nb', ['🏙 北岸（北外滩、虹口）。', '🏙 North bank (North Bund, Hongkou).'], city.north, true);
  group('lj', ['🏙 陆家嘴楼群：越靠近三塔越高，街区整体转角约 −24°。', '🏙 Lujiazui towers: taller near the super-tall trio, street grid rotated about −24°.'], city.lujiazui, true);

  // ── 金茂 ──
  group('jm', ['🗼 金茂大厦（421 m）：13 层塔式逐层收分 + 冠顶 + 尖塔。', '🗼 Jin Mao Tower (421 m): 13 pagoda-like setbacks, crown and spire.'], city.jinmao, false, b => (b as any).z);
  ex(`\\left(${f(JINMAO.x)}+0.06\\left(1-v\\right)\\cos\\left(2\\pi u\\right),${f(JINMAO.y)}+0.06\\left(1-v\\right)\\sin\\left(2\\pi u\\right),${f(city.jinmaoTop)}+${f(4.21 - city.jinmaoTop)}v\\right)`, { color: '#c9b98c' });

  // ── 环球金融中心 ──
  group('sw', ['🗼 上海环球金融中心（492 m）：一个方向收窄成刀锋，顶部有「开瓶器」洞口（浅色面板表示透空）。', '🗼 Shanghai World Financial Center (492 m): tapers to a blade with the "bottle-opener" aperture.'], [city.swfc], true);
  group('swh', ['开瓶器洞口', 'Aperture'], [{ x: SWFC.x, y: SWFC.y, w: 0.13, d: 0.088, h: 0.36, k: 1, l: 0.75, a: 0.35, c: [214, 232, 244] }], false, () => 4.38);

  // ── 上海中心 ──
  text('🗼 上海中心大厦（632 m）：圆角三角形截面，自下而上收分并扭转 120°；颜色随高度 z 变化画出 9 个分区的设备层。', '🗼 Shanghai Tower (632 m): rounded-triangle section tapering and twisting 120°, colored by height to show its 9 zones.');
  ex('C_{st}=\\operatorname{rgb}\\left(150+60\\max\\left(0,\\cos\\left(9z\\right)\\right)^{30},178+50\\max\\left(0,\\cos\\left(9z\\right)\\right)^{30},196+40\\max\\left(0,\\cos\\left(9z\\right)\\right)^{30}\\right)');
  ex(`r_{st}\\left(u,v\\right)=0.43\\left(1-0.55v\\right)\\left(1+0.11\\cos\\left(3\\left(2\\pi u-\\frac{2\\pi}{3}v\\right)\\right)\\right)`, { hidden: true });
  ex(`\\left(${f(SHTOWER.x)}+r_{st}\\left(u,v\\right)\\cos\\left(2\\pi u\\right),${f(SHTOWER.y)}+r_{st}\\left(u,v\\right)\\sin\\left(2\\pi u\\right),6.1v\\right)`, { colorLatex: 'C_{st}' });
  ex(`\\left(${f(SHTOWER.x)}+r_{st}\\left(u,1\\right)\\cos\\left(2\\pi u\\right),${f(SHTOWER.y)}+r_{st}\\left(u,1\\right)\\sin\\left(2\\pi u\\right),6.1+0.22v\\left(1+\\cos\\left(2\\pi u-\\frac{2\\pi}{3}\\right)\\right)\\right)`, { color: '#a9c3d2' });
  ex(`\\left(${f(SHTOWER.x)}+vr_{st}\\left(u,1\\right)\\cos\\left(2\\pi u\\right),${f(SHTOWER.y)}+vr_{st}\\left(u,1\\right)\\sin\\left(2\\pi u\\right),6.1\\right)`, { color: '#8fa9b8' });

  // ── 东方明珠 ──
  const P = PEARL;
  text('🔴 东方明珠（468 m）：三根立柱 + 三根斜撑 + 下球（直径 50 m）+ 五颗小球 + 上球（直径 45 m）+ 太空舱 + 天线。', '🔴 Oriental Pearl Tower (468 m): three columns, three slanted legs, lower sphere, five small pearls, upper sphere, space module and antenna.');
  ex('C_{pearl}=\\operatorname{rgb}\\left(196,46,104\\right)');
  ex(`\\left(${f(P.x)}+0.11\\cos\\left(\\frac{2\\pi}{3}\\left[0,1,2\\right]\\right)+0.045\\cos\\left(2\\pi u\\right),${f(P.y)}+0.11\\sin\\left(\\frac{2\\pi}{3}\\left[0,1,2\\right]\\right)+0.045\\sin\\left(2\\pi u\\right),2.75v\\right)`, { color: '#e3ddd6' });
  ex(`\\left(${f(P.x)}+\\left(0.6-0.5v\\right)\\cos\\left(\\frac{2\\pi}{3}\\left[0,1,2\\right]+\\frac{\\pi}{3}\\right)+0.04\\cos\\left(2\\pi u\\right),${f(P.y)}+\\left(0.6-0.5v\\right)\\sin\\left(\\frac{2\\pi}{3}\\left[0,1,2\\right]+\\frac{\\pi}{3}\\right)+0.04\\sin\\left(2\\pi u\\right),0.95v\\right)`, { color: '#e3ddd6' });
  ex(`\\operatorname{sphere}\\left(${pt(P.x, P.y, 0.93)},0.25\\right)`, { colorLatex: 'C_{pearl}' });
  ex(`\\operatorname{sphere}\\left(\\left(${f(P.x)}+0.11\\cos\\left(\\frac{2\\pi}{3}\\left[0,1,2,0,1\\right]\\right),${f(P.y)}+0.11\\sin\\left(\\frac{2\\pi}{3}\\left[0,1,2,0,1\\right]\\right),\\left[1.45,1.62,1.79,1.96,2.13\\right]\\right),0.07\\right)`, { colorLatex: 'C_{pearl}' });
  ex(`\\operatorname{sphere}\\left(${pt(P.x, P.y, 2.63)},0.225\\right)`, { colorLatex: 'C_{pearl}' });
  ex(`\\left(${f(P.x)}+0.05\\cos\\left(2\\pi u\\right),${f(P.y)}+0.05\\sin\\left(2\\pi u\\right),2.75+0.75v\\right)`, { color: '#e3ddd6' });
  ex(`\\operatorname{sphere}\\left(${pt(P.x, P.y, 3.5)},0.08\\right)`, { colorLatex: 'C_{pearl}' });
  ex(`\\left(${f(P.x)}+0.03\\left(1-v\\right)\\cos\\left(2\\pi u\\right),${f(P.y)}+0.03\\left(1-v\\right)\\sin\\left(2\\pi u\\right),3.55+1.13v\\right)`, { color: '#d9d9d9' });
  ex(`\\left(${f(P.x)}+0.75v\\cos\\left(2\\pi u\\right),${f(P.y)}+0.75v\\sin\\left(2\\pi u\\right),0.014\\right)`, { color: '#cfc6bb' });

  // ── 行道树 ──
  text('🌳 行道树与公园：外滩滨江、陆家嘴滨江、中心绿地、世纪大道两侧。树冠大小 k_leaf 与颜色 C_leaf 随季节变化：春樱粉、夏浓绿、秋梧桐金黄、冬季落叶。', '🌳 Street trees & parks; crown size k_leaf and color C_leaf follow the season.');
  ex(`T_{r}=${list(trees.map(([x, y]) => pt(x, y, 0)))}`, { hidden: true });
  ex('\\operatorname{segment}\\left(T_{r},T_{r}+\\left(0,0,0.16\\right)\\right)', { colorLatex: 'C_{trunk}' });
  ex('\\operatorname{sphere}\\left(T_{r}+\\left(0,0,0.2\\right),0.1k_{leaf}\\right)', { colorLatex: 'C_{leaf}' });

  // ── 江上渡轮 ──
  group('bo', ['⛴ 黄浦江上的渡轮。', '⛴ Ferries on the Huangpu.'], city.boats, false, () => -0.04);

  return out;
}

/** 摄像机：从外滩上空向东望陆家嘴 */
export const SHANGHAI_VIEW = {
  viewport: { xmin: -7.5, xmax: 9, ymin: -8.25, ymax: 8.25, zmin: -5, zmax: 11.5 },
  rotation: () => uprightViewMatrix(-104, 17),
};

/** 一次性写入整个场景（colorLatex、滑块、视角只有 setState 才能生效） */
export function loadShanghaiScene(calculator: any, lang: string = 'zh'): number {
  const exprs = buildShanghaiSceneExpressions(lang);
  const list = exprs.map(e => {
    if (e.type === 'text') return { type: 'text', id: e.id, text: e.text ?? '' };
    const o: Record<string, unknown> = { type: 'expression', id: e.id, latex: e.latex };
    if (e.color) o.color = e.color;
    if (e.colorLatex) o.colorLatex = e.colorLatex;
    if (e.hidden) o.hidden = true;
    if ((e as any).slider) o.slider = (e as any).slider;
    return o;
  });
  const st = calculator.getState();
  const v = SHANGHAI_VIEW.viewport;
  st.expressions = { ...(st.expressions || {}), list };
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
  calculator.setState(st, { allowUndo: true });
  return list.length;
}
