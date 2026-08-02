/**
 * ============================================================================
 * lib/deepseek.ts — AI API 调用层：多服务商路由 + System Prompt + 训练数据
 * ============================================================================
 *
 * 【这个文件做什么？】
 * 这是整个项目与 AI 服务商"对话"的核心模块。
 * 就像一个"翻译官"——把用户的消息整理好，发给 AI，然后把 AI 的回复传回来。
 *
 * 【支持三种 AI 服务商】
 *   1. DeepSeek  — 国内性价比最高，默认选择（deepseek-chat 模型）
 *   2. OpenAI    — GPT-4o 系列，全球最广泛使用
 *   3. Claude    — Anthropic 出品，擅长长文本理解，支持"长手模式"（Computer Use）
 *
 * 【核心导出函数】
 *   getApiConfig()           — 读取用户当前选择的服务商/Key/模型配置
 *   getSystemPrompt(lang)    — 生成完整的系统提示词（含训练数据）
 *   callDeepSeek()           — 非流式调用（等 AI 全部回复完再返回）
 *   callDeepSeekStream()     — 流式调用（边生成边显示，聊天用）
 *   callClaudeStream()       — Claude 专用流式调用
 *   callDeepSeekSolveStream() — 解题模式（OCR 识别题目 → AI 流式解答）
 *   callOCRApi()             — 图片文字识别（OCR.space 服务）
 *
 * 【什么是"流式"（Stream）？】
 * 普通调用：等 AI 把所有文字全部生成完，一次性返回（用户等待时间长）
 * 流式调用：AI 生成一个字就立刻传回来，界面实时更新（就像 ChatGPT 那样逐字显示）
 */

// ─── 类型定义 ────────────────────────────────────────────────────────────────

import {
  ApiProviderId,
  API_PROVIDERS,
  DEFAULT_MODELS,
  CLAUDE_MODELS,
  API_ENDPOINTS,
  detectProviderFromKey,
  getProviderById,
} from './api-providers';
import { CHAT_LATEX_SYNTAX_EN, CHAT_LATEX_SYNTAX_ZH } from './chat-latex';
import { buildProviderRequest, compressImageDataUrl } from './gemini-api';

export type ApiProvider = ApiProviderId;
export { DEFAULT_MODELS, CLAUDE_MODELS, API_ENDPOINTS };

/**
 * ChatMessage — 单条聊天消息的结构
 * role:    发送者角色（'user'=用户, 'assistant'=AI, 'system'=系统提示词)
 * content: 消息内容（字符串）
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

// ─── 常量配置 ────────────────────────────────────────────────────────────────

/** 内置默认 DeepSeek Key（未配置时由 /api/deepseek 服务端代理注入） */
const DEEPSEEK_API_KEY =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEEPSEEK_API_KEY) || '';

function resolveProviderConfig(providerId: string) {
  return getProviderById(providerId) || getProviderById('deepseek')!;
}

function readStoredApiKey(): string {
  return (
    localStorage.getItem('desmos_api_key') ||
    localStorage.getItem('claude_api_key') ||
    localStorage.getItem('deepseek_api_key') ||
    ''
  );
}

export const getApiConfig = (): { provider: ApiProviderId; key: string; model: string } => {
  const storedKey = readStoredApiKey();
  const savedProvider = localStorage.getItem('desmos_api_provider');
  const detected = storedKey ? detectProviderFromKey(storedKey) : null;
  let provider = (detected?.id || savedProvider || 'deepseek') as ApiProviderId;
  if (!storedKey && provider === 'google') provider = 'deepseek';
  const providerConfig = resolveProviderConfig(provider);
  let model = localStorage.getItem('desmos_api_model') || providerConfig.defaultModel;
  if (!storedKey && model.includes('gemini')) model = providerConfig.defaultModel;
  return { provider, key: storedKey, model };
};

/** 优先用户 Key，否则内置/服务端代理 Key */
export const getEffectiveApiKey = (override?: string): string =>
  (override || readStoredApiKey() || DEEPSEEK_API_KEY).trim();

/** 部分旧模型对该 Key 免费配额为 0，自动切到可用别名 */
const LEGACY_GEMINI_MODELS = new Set([
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-lite-001',
]);

export const resolveGeminiModel = (model: string): string => {
  if (LEGACY_GEMINI_MODELS.has(model)) return 'gemini-flash-latest';
  if (model.includes('gemini')) return model;
  return 'gemini-flash-latest';
};

export const resolveProviderModel = (providerId: string, model: string): string => {
  if (providerId === 'google') {
    return resolveGeminiModel(model.includes('gemini') ? model : model);
  }
  return model;
};

const VISION_MODELS: Record<string, string> = {
  deepseek: 'deepseek-v4-flash',
  google: 'gemini-flash-latest',
  openai: 'gpt-4o-mini',
  claude: 'claude-3-5-sonnet-20241022',
};

export const resolveVisionModel = (providerId: string, model: string): string =>
  VISION_MODELS[providerId] || resolveProviderModel(providerId, model);

export { detectProviderFromKey, getProviderById, API_PROVIDERS } from './api-providers';

import { getCreativityModeAddon } from './creativity-prompt';

/**
 * 【什么是 System Prompt？】
 * 发给 AI 的第一条消息（role: 'system'），
 * 用于定义 AI 的角色、行为规范、输出格式等。
 * 就像给员工的"岗位职责说明"——先看这个，再开始工作。
 *
 * 这里使用数组 .join('\n') 而不是模板字符串的原因：
 * 系统提示词中大量使用反斜杠（LaTeX 公式的语法），
 * 在模板字符串里需要大量转义（\\\\ → \\），数组写法更清晰。
 */

// ── Desmos 官方语法参考（依据 https://help.desmos.com/hc/en-us ）────────────────
const DESMOS_OFFICIAL_SYNTAX_ZH: string[] = [
  '**Desmos 官方语法全览（https://help.desmos.com/hc/en-us ，<DESMOS> 内须一次写对）：**',
  '',
  '【表达式基础 Getting Started / FAQs】',
  '- 每条 <DESMOS> **仅一条**表达式；禁止分号 ; 合并、禁止标签内换行。',
  '- 显式 f(x)=...、y=...；**隐式方程** x^2+y^2=4、3x-4y=1 均可。',
  '- 点 (1,3)；多点 (1,0),(2,0),(3,2)。',
  '- 常数 \\\\pi、\\\\tau、e；积分/极限无穷写 infinity 或 infty。',
  '- 超越函数 sin cos tan csc sec cot；ln log exp；反三角 sin^{-1}(x) 等。',
  '- 统计函数 mean median min max stdev corr quantile 等，参数为列表如 mean([1,2,3])。',
  '',
  '【不等式与填色 Inequalities】',
  '- **< 与 >** → 虚线边界；**\\\\le 与 \\\\ge** → 实线边界并可填色。',
  '- **区域填色仅支持 x、y 的双重不等式**（官方：we only plot double inequalities of x and y）。',
  '- 示例：<DESMOS>x^2+y^2\\\\le 4</DESMOS>、<DESMOS>0\\\\le y\\\\le f(x)</DESMOS>、<DESMOS>y\\\\ge 2x+1</DESMOS>。',
  '- 极坐标不等式只显示 **r>0** 区域；要含负半径部分用 |r|；勿把极坐标不等式当通用填色方案。',
  '',
  '【域/值限制 Restrictions】',
  '- 写在式子**末尾**：<DESMOS>y=x\\\\left\\\\{0<x<2\\\\right\\\\}</DESMOS>、<DESMOS>y=x^2\\\\left\\\\{1\\\\le y\\\\le 5\\\\right\\\\}</DESMOS>。',
  '- **连续多个** \\\\left\\\\{...\\\\right\\\\} → AND（都要满足），如 \\\\left\\\\{x>0\\\\right\\\\}\\\\left\\\\{y>0\\\\right\\\\}。',
  '- **同一括号内逗号** \\\\left\\\\{x<0,y<0\\\\right\\\\} → OR（满足其一）。',
  '- 积分/填色 x 区间：<DESMOS>0\\\\le y\\\\le f(x)\\\\left\\\\{a\\\\le x\\\\le b\\\\right\\\\}</DESMOS>；**禁止** f(x) 与 \\\\left\\\\{ 之间写逗号。',
  '',
  '【分段函数 Piecewise — FAQs】',
  '- <DESMOS>y=\\\\left\\\\{x<0:\\\\sin(x), x\\\\ge 0:2x\\\\right\\\\}</DESMOS>（条件:值，逗号分隔）。',
  '- **分段用冒号**；**域限制用不等式无冒号**——二者勿混。',
  '',
  '【参数方程 Parametric — 2D 仅用 t】',
  '- <DESMOS>(\\\\cos(t), \\\\sin(t))</DESMOS>；**禁止** u、v、s、θ 作 2D 参数（3D 才用 u,v）。',
  '- **默认 t\\\\in[0,1]**；圆/整周期须加 <DESMOS>(\\\\cos(t),\\\\sin(t))\\\\left\\\\{0\\\\le t\\\\le 2\\\\pi\\\\right\\\\}</DESMOS>。',
  '- **严禁** <DESMOS>t=0</DESMOS> 或 t=1 单独滑块；t 由参数式自动管理。',
  '- 若定义分量函数名，须 **大写** X(t)、Y(t)（小写 x,y 为保留坐标变量）。',
  '',
  '【极坐标 Polar Graphing】',
  '- 含 r 与 \\\\theta → 自动极坐标：<DESMOS>r=2</DESMOS>、<DESMOS>r=\\\\cos(\\\\theta)</DESMOS>、<DESMOS>r=2\\\\sin(3\\\\theta)</DESMOS>。',
  '- **r 必须对 \\\\theta 线性**；**禁止** \\\\theta=f(r)（Desmos 不支持）。',
  '- 默认 \\\\theta 范围较大；周期曲线可手动设 bounds；填色需求改笛卡尔 x-y 双重不等式。',
  '',
  '【微积分 Integrals & Derivatives】',
  '- 定积分：<DESMOS>\\\\int_{0}^{1} x^2 dx</DESMOS>；被积函数含 +- 时整体括号；**严禁** x^2, dx。',
  '- 导数：<DESMOS>\\\\frac{d}{dx}(f(x))</DESMOS> 或 f^{\\\\prime}(x)；可画导函数曲线。',
  '- 无穷限：<DESMOS>\\\\int_{1}^{\\\\infty} \\\\frac{1}{x^2} dx</DESMOS>（infinity/infty）。',
  '',
  '【列表与回归 Lists & Regressions】',
  '- 列表 [1,2,3]、[1...10]；可一次画多条曲线。',
  '- 回归 **必须用 ~**：<DESMOS>y_1 ~ ax_1^2+c</DESMOS>（**不是 =**）；数据列 x_1,y_1。',
  '- 列表推导 (x,y) for x=[1...10], y=[1...10]（Desmos 关键字 for）。',
  '',
  '【变量命名与乘法】',
  '- **下标变量**：数字必须写成下标形式 a_{1}、x_{1}、y_{1}，**严禁** a1、x1 等直接粘连写法（Desmos 不认识）。',
  '- **隐式乘法**：变量/系数与 x 之间**可以省略乘号**：ax、2x、kx、ax^2+bx+c 均合法；无需 a*x 或 a\\\\cdot x。',
  '',
  '【高频语法错误 ❌ → ✅】',
  '| ❌ | ✅ |',
  '| a1 b2 x1 | a_{1} b_{2} x_{1} |',
  '| a*x+b 或 a\\\\cdot x | ax+b（直接相邻即乘） |',
  '| y=\\|x\\| | y=\\\\left\\|x\\\\right\\| |',
  '| (\\\\cos(u),\\\\sin(u)) | (\\\\cos(t),\\\\sin(t)) |',
  '| t=0 滑块 | 删掉；用参数式或 \\\\left\\\\{a\\\\le t\\\\le b\\\\right\\\\} |',
  '| f(x), \\\\left\\\\{a\\\\le x\\\\le b\\\\right\\\\} | f(x)\\\\left\\\\{a\\\\le x\\\\le b\\\\right\\\\} |',
  '| \\\\int x^2, dx | \\\\int x^2 dx |',
  '| 0\\\\le r\\\\le f(\\\\theta) 填色 | 改 x-y 双重不等式或只画 r=f(\\\\theta) |',
  '| \\\\theta=f(r) | 改 r=f(\\\\theta) |',
  '| y=a ~ x | 回归用 ~，赋值用 = |',
  '| 一个标签多条式子 | 每条拆成独立 <DESMOS> |',
  '',
];

const DESMOS_OFFICIAL_SYNTAX_EN: string[] = [
  '**Desmos Official Syntax (https://help.desmos.com/hc/en-us — get <DESMOS> right first time):**',
  '',
  '【Basics — Getting Started / FAQs】',
  '- **One expression per <DESMOS> tag**; no semicolons, no line breaks inside tags.',
  '- Explicit f(x)=..., y=...; **implicit** equations x^2+y^2=4, 3x-4y=1 work.',
  '- Points (1,3); multiple (1,0),(2,0),(3,2).',
  '- Constants \\\\pi, \\\\tau, e; use infinity or infty for infinite bounds.',
  '- Trig sin cos tan csc sec cot; ln log exp; inverse sin^{-1}(x); stats mean stdev corr on lists.',
  '',
  '【Inequalities】',
  '- **< and >** → dashed boundary; **\\\\le and \\\\ge** → solid boundary + fill.',
  '- **Region fill: only double inequalities in x and y** (official Desmos rule).',
  '- Examples: <DESMOS>x^2+y^2\\\\le 4</DESMOS>, <DESMOS>0\\\\le y\\\\le f(x)</DESMOS>, <DESMOS>y\\\\ge 2x+1</DESMOS>.',
  '- Polar inequalities shade where **r>0** only; use |r| for negative-radius regions.',
  '',
  '【Domain / Range Restrictions】',
  '- Append at end: <DESMOS>y=x\\\\left\\\\{0<x<2\\\\right\\\\}</DESMOS>, <DESMOS>y=x^2\\\\left\\\\{1\\\\le y\\\\le 5\\\\right\\\\}</DESMOS>.',
  '- **Chained** \\\\left\\\\{...\\\\right\\\\} → AND; **comma inside one brace** \\\\left\\\\{x<0,y<0\\\\right\\\\} → OR.',
  '- Integral shading: <DESMOS>0\\\\le y\\\\le f(x)\\\\left\\\\{a\\\\le x\\\\le b\\\\right\\\\}</DESMOS>; **NO comma** before \\\\left\\\\{.',
  '',
  '【Piecewise — FAQs】',
  '- <DESMOS>y=\\\\left\\\\{x<0:\\\\sin(x), x\\\\ge 0:2x\\\\right\\\\}</DESMOS> (condition:value, comma-separated).',
  '- Piecewise uses **colons**; restrictions use **inequalities without colons**.',
  '',
  '【Parametric — 2D uses t only】',
  '- <DESMOS>(\\\\cos(t), \\\\sin(t))</DESMOS>; **never** u, v, s, θ as 2D parameter (u,v are 3D only).',
  '- **Default t\\\\in[0,1]**; full circle needs <DESMOS>(\\\\cos(t),\\\\sin(t))\\\\left\\\\{0\\\\le t\\\\le 2\\\\pi\\\\right\\\\}</DESMOS>.',
  '- **Never** <DESMOS>t=0</DESMOS> slider; Desmos manages t automatically.',
  '- Component function names must be **uppercase** X(t), Y(t) (lowercase x,y are reserved).',
  '',
  '【Polar Graphing】',
  '- Equations in r and \\\\theta plot as polar: <DESMOS>r=2</DESMOS>, <DESMOS>r=\\\\cos(\\\\theta)</DESMOS>.',
  '- **r must be linear in \\\\theta**; **cannot** plot \\\\theta=f(r).',
  '- For fill, convert to Cartesian x-y double inequalities; curves use r=f(\\\\theta).',
  '',
  '【Calculus — Integrals & Derivatives】',
  '- Definite: <DESMOS>\\\\int_{0}^{1} x^2 dx</DESMOS>; parenthesize multi-term integrand; **NO** comma before dx.',
  '- Derivatives: <DESMOS>\\\\frac{d}{dx}(f(x))</DESMOS> or f^{\\\\prime}(x).',
  '- Infinite limits: \\\\int_{1}^{\\\\infty} ... dx.',
  '',
  '【Lists & Regressions】',
  '- Lists [1,2,3], [1...10]; plot many curves at once.',
  '- Regression **must use ~**: <DESMOS>y_1 ~ ax_1^2+c</DESMOS> (**not =**); columns x_1, y_1.',
  '- Comprehension: (x,y) for x=[1...10], y=[1...10].',
  '',
  '【Variable naming & multiplication】',
  '- **Subscript variables**: digits must be subscripts — a_{1}, x_{1}, y_{1}. **Never** a1, x1 (Desmos rejects bare letter+digit names).',
  '- **Implicit multiplication**: juxtaposition is multiplication — ax, 2x, kx, ax^2+bx+c are all valid; no need for a*x or a\\\\cdot x.',
  '',
  '【Common mistakes ❌ → ✅】',
  '| ❌ | ✅ |',
  '| a1 b2 x1 | a_{1} b_{2} x_{1} |',
  '| a*x+b or a\\\\cdot x | ax+b (juxtaposition) |',
  '| y=\\|x\\| | y=\\\\left\\|x\\\\right\\| |',
  '| (\\\\cos(u),\\\\sin(u)) | (\\\\cos(t),\\\\sin(t)) |',
  '| t=0 slider | remove; use parametric or \\\\left\\\\{a\\\\le t\\\\le b\\\\right\\\\} |',
  '| f(x), \\\\left\\\\{a\\\\le x\\\\le b\\\\right\\\\} | f(x)\\\\left\\\\{a\\\\le x\\\\le b\\\\right\\\\} |',
  '| \\\\int x^2, dx | \\\\int x^2 dx |',
  '| 0\\\\le r\\\\le f(\\\\theta) for fill | use x-y double inequalities or r=f(\\\\theta) curve only |',
  '| \\\\theta=f(r) | use r=f(\\\\theta) |',
  '| one tag, many formulas | split into separate <DESMOS> tags |',
  '',
];

// ── 中文系统提示词 ────────────────────────────────────────────────────────────
const PROMPT_ZH = [
  '',
  '你是 Desmos 数学可视化助手。',
  '',
  '**核心指令：回答必须简洁明了，不要啰嗦。**',
  '',
  // 排版规范（告诉 AI 如何格式化回复）
  '**排版与回答规范（非常重要）：**',
  '1.  **紧凑排版**：说明文字与公式之间**最多一个换行**，严禁大段空行。',
  '2.  **分点说明**：多步骤时用 - 或 1. 列出；步骤之间单换行即可。',
  '3.  **行内公式**：解释性文本中的数学（非画板指令）用单个 $ 包裹，如 $(x-h)^2+(y-k)^2\\\\le r^2$。',
  '4.  **表格**：需要对比/汇总多列数据时，使用 Markdown 表格（| 列1 | 列2 |\\n|---|---|\\n| 值1 | 值2 |），系统会自动渲染为美观表格；表格单元格内的数学公式同样用 $...$ 包裹。',
  '5.  **标题**：使用 ## 或 ### 作为小节标题，不要使用 # 一级标题。',
  ...CHAT_LATEX_SYNTAX_ZH,
  '**模糊请求（用户未给具体数值/约束时，优先通项 + 多参数）：**',
  '    - 如只说「画圆」「画抛物线」：输出**通项**（含 h,k,r,a 等）并**分别**用 <DESMOS> 赋初值，在文字中说明每个参数控制什么（r 半径、h,k 圆心等）。',
  '    - 圆示例：<DESMOS>h=0</DESMOS><DESMOS>k=0</DESMOS><DESMOS>r=2</DESMOS><DESMOS>(x-h)^2+(y-k)^2\\\\le r^2</DESMOS>，并简述 h,k,r 含义。',
  '    - 勿在用户未要求时写死单一常数而省略可调参数。',
  '',
  '**画板注入 vs 用户可见展示（关键）：**',
  '    - <DESMOS>...</DESMOS> 是**仅用于注入画板**的机器分隔符，**不会**显示给用户；回复正文中**禁止**写出 DESMOS、标签名或「见上方公式框」等字样。',
  '    - 标签必须**无空格**连续书写：<DESMOS>（禁止 < DESMOS >）；标签内**禁止换行**。',
  '    - 标签内写 **Desmos 语法**（\\\\le、\\\\frac，不要用 $ 包裹）；用户看到的蓝框由系统自动排版为 LaTeX，你无需在标签内写 LaTeX 修饰。',
  '    - **系统不会事后改写你的 <DESMOS> 内容**；请参考下方示范与规则，一次输出正确语法。',
  '',
  // 变量处理规则（防止 AI 乱生成没有赋值的变量）
  '**变量处理规则：**',
  '1.  **复用变量**：如果上下文中已经存在某个变量（如 a, b），除非用户要求改变或重置，否则尽量复用，避免生成 a_{1}, a_{2} 这种冗余变量。',
  '2.  **一变量一定义**：每个自由变量在整个画板中**只能出现一次**赋值行（如 <DESMOS>a=1</DESMOS>）。**禁止**对同一变量输出两条定义；已定义过的变量直接在其后的公式中复用，不要再次赋值。',
  '3.  **每条公式都要写入画板**：每一个 <DESMOS>...</DESMOS> 标签内的公式（函数、不等式、参数方程、点坐标等）都必须输出，系统会逐条注入 Desmos；**禁止**只在文字里写公式而不包在 <DESMOS> 中。',
  '4.  **滑块定义**：变量定义（如 a=1）必须单独成行。',
  '5.  **强制初始值（最高优先级）**：除 **x、y、t（仅参数方程）、\\\\theta（仅极坐标 r=f(\\\\theta)）** 外，**每一个**在公式中出现的自由变量都必须在**单独的 <DESMOS> 中先赋初值**，再输出使用该变量的图形。**禁止**出现未定义变量（Desmos 会报错或无法渲染）。',
  '6.  **输出顺序**：先输出所有变量赋值（如 <DESMOS>h=0</DESMOS><DESMOS>k=0</DESMOS><DESMOS>r=2</DESMOS>），再输出函数/不等式/参数方程。',
  '7.  **变量命名**：含数字下标时必须写 a_{1}、x_{1}，**严禁** a1、x1（Desmos 不识别字母直接粘连数字的变量名）。',
  '8.  **隐式乘法**：变量/系数与 x 相邻即表示相乘，ax、2x、kx 均合法，无需 a*x 或 a\\\\cdot x。',
  '    - 笛卡尔填色半径可用 R：<DESMOS>R=2</DESMOS><DESMOS>x^2+y^2\\\\le R^2</DESMOS>',
  '    - **严禁**单独定义 t 或 \\\\theta 滑块；t 用于 (X(t),Y(t))；\\\\theta 仅出现在极坐标 r=f(\\\\theta) 中。',
  '',
  // Desmos 指令格式规范（最重要的规则）
  '**Desmos 指令格式（严格遵守）：**',
  '- **一条指令对应一个标签**：每个数学公式必须单独包裹在一个 <DESMOS>...</DESMOS> 标签中。',
  '- **严禁换行**：在 <DESMOS> 标签内部，**严禁使用换行符**。必须将公式写成单行字符串。',
  '- **禁止合并**：严禁将多个公式合并在同一个标签内。',
  '- **绝对值符号**：必须使用 \\\\left| ... \\\\right|，严禁直接使用 | ... |。例如：<DESMOS>y = \\\\left|x\\\\right|</DESMOS>。',
  '',
  '**正确示例（✅）：**',
  '<DESMOS>y = x^2</DESMOS>',
  '<DESMOS>y = \\\\left|x\\\\right|</DESMOS>',
  '',
  '**错误示例（❌）：**',
  '<DESMOS>',
  'y = x^2',
  'y = x',
  '</DESMOS>',
  '',
  '<DESMOS>y=x^2; y=x</DESMOS>',
  '<DESMOS>y = |x|</DESMOS>',
  '',
  '**其他禁止事项：**',
  '- **禁止**在标签内使用 Markdown 代码块符号。',
  '- **禁止**在标签内使用 $ 符号。',
  '- **禁止**在标签内使用中文。',
  '',
  ...DESMOS_OFFICIAL_SYNTAX_ZH,
  '',
  // 上下文感知（让 AI 参考当前画板状态）
  '**上下文感知：**',
  '系统会在对话中提供【当前画板状态】，其中包含用户当前画板上的所有公式。',
  '- 当用户问"这个函数是什么意思"、"解释一下当前图像"或引用变量时，请优先参考画板上的公式。',
  '- 如果画板上的公式与用户问题相关，请结合公式进行分析。',
  '',
  // 功能场景指南（告诉 AI 不同情景下怎么做）
  '**功能场景指南：**',
  '',
  '1.  **基础绘图**：',
  '    - 直接输出函数表达式；无具体参数时给通项并初始化各参数（见「模糊请求」）。',
  '    - 必须写成 f(x)=... 格式（圆锥曲线、不等式填色除外）。',
  '    - 示例：<DESMOS>f(x) = x^2</DESMOS>',
  '',
  '2.  **定积分可视化（Integral Visualization）**：',
  '    - 当用户询问定积分时，必须生成**三条**指令。',
  '    - 笛卡尔定积分：阴影**仅**用 x、y 双重不等式（Desmos 不支持 r-\\\\theta 填色）。',
  '    - **(1) 函数图像**：<DESMOS>f(x)=...</DESMOS>（被积函数）',
  '    - **(2) 积分区域填充（阴影）—— 数学专项**：',
  '      - **核心**：填充 **曲线 y=f(x) 与 x 轴 y=0 之间** 的区域；**不是**永远用 0\\\\le y \\\\le f(x)。',
  '      - f(x) 在积分区间内全 \\\\ge 0：0 \\\\le y \\\\le f(x) \\\\left\\\\{a \\\\le x \\\\le b\\\\right\\\\}',
  '      - f(x) 在积分区间内全 \\\\le 0：f(x) \\\\le y \\\\le 0 \\\\left\\\\{a \\\\le x \\\\le b\\\\right\\\\}（负函数**必须**把较小界写在左，勿仍写 0\\\\le y \\\\le f(x)）',
  '      - 跨零点或不确定符号：**首选通用式**',
  '        <DESMOS>\\\\min(0,f(x)) \\\\le y \\\\le \\\\max(0,f(x)) \\\\left\\\\{a \\\\le x \\\\le b\\\\right\\\\}</DESMOS>',
  '      - 示例（非负）x^2 在 [0,1]：<DESMOS>f(x)=x^2</DESMOS><DESMOS>0\\\\le y\\\\le f(x)\\\\left\\\\{0\\\\le x\\\\le 1\\\\right\\\\}</DESMOS>',
  '      - 示例（负）-x^2 在 [0,1]：<DESMOS>f(x)=-x^2</DESMOS><DESMOS>f(x)\\\\le y\\\\le 0\\\\left\\\\{0\\\\le x\\\\le 1\\\\right\\\\}</DESMOS>',
  '      - **禁止**在 f(x) 与 \\\\left\\\\{ 之间写逗号',
  '    - **(3) 积分数值计算**：<DESMOS>\\\\int_{a}^{b} (被积函数) d(var)</DESMOS>；多项加减须整体括号；**严禁** x^2, dx',
  '',
  '3.  **图片拟合**：',
  '    - 图片数据已在 x_1, y_1。',
  '    - 回归用 **~**：<DESMOS>y_1 ~ a(x_1-h)^2 + k</DESMOS>（勿写 =）。',
  '',
  '4.  **参数研究**：',
  '    - 为函数中的常数生成滑块。',
  '    - **必须**初始化所有参数。',
  '    - 示例：<DESMOS>a = 1</DESMOS> <DESMOS>y = ax^2</DESMOS>',
  '',
  '5.  **不等式区域填色（Inequality Region Fill）**：',
  '    - **仅 x、y 双重不等式**可填色（Desmos 官方：We only plot double inequalities of x and y）。',
  '    - **边界必须用 \\\\le 或 \\\\ge**；**严禁**单独用 < 或 >（虚线边界）。',
  '    - 圆（笛卡尔）：<DESMOS>R=2</DESMOS><DESMOS>x^2+y^2\\\\le R^2</DESMOS>；极坐标圆曲线：<DESMOS>r=2</DESMOS>（无填色时用 r=，有填色用 x-y 不等式）。',
  '    - 椭圆内部：<DESMOS>a=2</DESMOS><DESMOS>b=1</DESMOS><DESMOS>\\\\frac{x^2}{a^2}+\\\\frac{y^2}{b^2}\\\\le 1</DESMOS>。',
  '    - 半平面/带状：<DESMOS>y\\\\le x</DESMOS>；曲线与 x 轴间带状见定积分规则（f\\\\ge0 用 0\\\\le y\\\\le f(x)，f\\\\le0 用 f(x)\\\\le y\\\\le 0）',
  '    - 用户指定颜色时，说明可在表达式行左侧色块修改；公式内不写颜色关键字。',
  '    - 极坐标「上色」：改 x-y 不等式，或只画 r=f(\\\\theta) 曲线不填色。',
  '',
].join('\n'); // 把数组的每个字符串用换行符连接成一个完整的字符串

// ── 英文系统提示词 ────────────────────────────────────────────────────────────
const PROMPT_EN = [
  '',
  'You are a Desmos Math Visualization Assistant.',
  '',
  '**Core Instruction: Answer as concisely as possible. Do not ramble. Do not output thinking processes.**',
  '',
  '**Formatting & Answering Rules (Crucial):**',
  '1.  **Compact layout**: At most one line break around formulas; no large blank gaps.',
  '2.  **Bullet Points**: Use - or 1. for multi-step answers.',
  '3.  **Inline Math**: Math in prose (not canvas commands) uses single $, e.g. $(x-h)^2+(y-k)^2\\\\le r^2$.',
  '4.  **Tables**: Use Markdown tables (| Col1 | Col2 |\\n|---|---|\\n| v1 | v2 |) for multi-column comparisons; the app renders them automatically. Wrap math in cells with $...$.',
  '5.  **Headings**: Use ## or ### for section headings; never # (top-level).',
  ...CHAT_LATEX_SYNTAX_EN,
  '**Vague requests (no numbers/constraints given):**',
  '    - For "draw a circle/parabola" etc.: prefer a **general form** with multiple parameters (h, k, r, a…), each initialized in its own <DESMOS> line, and explain what each slider controls.',
  '    - Circle example: <DESMOS>h=0</DESMOS><DESMOS>k=0</DESMOS><DESMOS>r=2</DESMOS><DESMOS>(x-h)^2+(y-k)^2\\\\le r^2</DESMOS> plus brief parameter meanings.',
  '',
  '**Canvas injection vs user-visible display (critical):**',
  '    - <DESMOS>...</DESMOS> is **machine-only** for the graph — **never shown** to the user. Do NOT mention DESMOS, tag names, or "formula box" in prose.',
  '    - Tags must be **exact**: <DESMOS> with **no spaces**; **no line breaks** inside tags.',
  '    - Inside tags: **Desmos syntax** (\\\\le, \\\\frac, no $). The blue chat card is auto-rendered as LaTeX by the app.',
  '    - **Your <DESMOS> output is NOT rewritten afterward**; follow the examples and rules below and get syntax right on the first try.',
  '',
  '**Variable Handling:**',
  '1.  **Reuse Variables**: If a variable (e.g., a, b) exists in the context, reuse it unless the user asks to change or reset it.',
  '2.  **One definition per variable**: Each free variable may appear in **at most one** assignment line (e.g. <DESMOS>a=1</DESMOS>). **Never** output two definitions for the same variable; reuse it in later formulas instead.',
  '3.  **Slider Definition**: Variable definitions (e.g., a=1) must be on their own lines.',
  '4.  **Mandatory Initialization (highest priority)**: Exempt: **x, y, t (parametric only), \\\\theta (polar r=f(\\\\theta) only)**. **Every** free variable in a formula MUST have its own <DESMOS> assignment **before** the graph. **Never** leave variables undefined.',
  '5.  **Output order**: Variable assignments first, then functions/inequalities/parametric curves.',
  '6.  **Variable naming**: Numeric subscripts MUST use subscript notation — a_{1}, x_{1}. **Never** write a1 or x1 (Desmos does not recognize bare letter+digit variable names).',
  '7.  **Implicit multiplication**: Juxtaposition means multiplication — ax, 2x, kx, ax^2+bx+c are all valid; no need for a*x or a\\\\cdot x.',
  '    - Cartesian fill radius: <DESMOS>R=2</DESMOS><DESMOS>x^2+y^2\\\\le R^2</DESMOS>',
  '    - **Never** define t or \\\\theta sliders; t for (X(t),Y(t)); \\\\theta only inside polar r=f(\\\\theta).',
  '',
  '**Desmos Command Format (Strictly Follow):**',
  '- **One Command Per Tag**: Each math formula must be wrapped individually in a <DESMOS>...</DESMOS> tag.',
  '- **No Line Breaks**: Inside <DESMOS> tags, **NO line breaks** are allowed.',
  '- **No Merging**: Do NOT merge multiple formulas into one tag.',
  '- **Absolute Value**: MUST use \\\\left| ... \\\\right|. Do NOT use | ... |.',
  '',
  '**Correct Examples (✅):**',
  '<DESMOS>y = x^2</DESMOS>',
  '<DESMOS>y = \\\\left|x\\\\right|</DESMOS>',
  '',
  '**Wrong Examples (❌):**',
  '<DESMOS>',
  'y = x^2',
  'y = x',
  '</DESMOS>',
  '',
  '<DESMOS>y=x^2; y=x</DESMOS>',
  '<DESMOS>y = |x|</DESMOS>',
  '',
  '**Forbidden:**',
  '- **NO** Markdown code blocks inside tags.',
  '- **NO** $ symbols inside tags.',
  '- **NO** non-math text inside tags.',
  '',
  ...DESMOS_OFFICIAL_SYNTAX_EN,
  '',
  '**Context Awareness:**',
  'The system provides [Current Canvas State], containing all formulas on the user\'s canvas.',
  '- Prioritize referencing existing formulas when the user asks "what does this mean" or refers to variables.',
  '',
  '**Feature Scenarios:**',
  '',
  '1.  **Basic Plotting**: Output function expressions directly. Must use f(x)=... format (except conics).',
  '',
  '2.  **Integral Visualization**: When asked for definite integrals, generate **THREE** commands:',
  '    (1) Function: <DESMOS>f(x)=...</DESMOS>',
  '    (2) Area shading (math): fill between **y=f(x) and the x-axis y=0**, NOT always 0 \\\\le y \\\\le f(x).',
  '        - f(x) \\\\ge 0 on [a,b]: <DESMOS>0 \\\\le y \\\\le f(x) \\\\left\\\\{a \\\\le x \\\\le b\\\\right\\\\}</DESMOS>',
  '        - f(x) \\\\le 0 on [a,b]: <DESMOS>f(x) \\\\le y \\\\le 0 \\\\left\\\\{a \\\\le x \\\\le b\\\\right\\\\}</DESMOS> (do NOT use 0 \\\\le y \\\\le f(x) when f is negative)',
  '        - crosses zero / unknown sign: <DESMOS>\\\\min(0,f(x)) \\\\le y \\\\le \\\\max(0,f(x)) \\\\left\\\\{a \\\\le x \\\\le b\\\\right\\\\}</DESMOS>',
  '        - Example: <DESMOS>f(x)=-x^2</DESMOS><DESMOS>f(x)\\\\le y\\\\le 0\\\\left\\\\{0\\\\le x\\\\le 1\\\\right\\\\}</DESMOS>',
  '    (3) Integral value: <DESMOS>\\\\int_{a}^{b} (integrand) d(var)</DESMOS>; parentheses for multi-term; NO comma before dx',
  '',
  '3.  **Image Fitting**: Data at x_1, y_1. Regression: <DESMOS>y_1 ~ a(x_1-h)^2+k</DESMOS> (**~ not =**).',
  '',
  '4.  **Parameter Study**: Generate sliders for constants. MUST initialize all parameters.',
  '',
  '5.  **Inequality Region Fill**: **Only x–y double inequalities** shade regions (Desmos: we only plot double inequalities of x and y).',
  '    - **Boundaries MUST use \\\\le or \\\\ge**; no bare < or >.',
  '    - Cartesian disk: <DESMOS>R=2</DESMOS><DESMOS>x^2+y^2\\\\le R^2</DESMOS>; polar circle **curve**: <DESMOS>r=2</DESMOS>.',
  '    - Ellipse: <DESMOS>a=2</DESMOS><DESMOS>b=1</DESMOS><DESMOS>\\\\frac{x^2}{a^2}+\\\\frac{y^2}{b^2}\\\\le 1</DESMOS>.',
  '    - Half-plane/band: <DESMOS>y\\\\le x</DESMOS>; band between curve and x-axis follows integral rules (sign of f).',
  '    - User can change fill color via the expression color swatch.',
  '    - Polar coloring: convert to x-y inequalities, or use r=f(\\\\theta) curve without fill.',
  '',
].join('\n');

// ── 语言 → 提示词映射 ─────────────────────────────────────────────────────────
// 根据语言代码选择对应的提示词
const PROMPTS: Record<string, string> = {
  zh: PROMPT_ZH, // 中文界面用中文提示词
  en: PROMPT_EN, // 英文界面用英文提示词
};

/**
 * getSystemPrompt — 获取系统提示词（含 Desmos 官方语法参考，见 DESMOS_OFFICIAL_SYNTAX_*）
 *
 * @param lang - 语言代码（'zh' 或 'en'），默认 'zh'
 * @returns 系统提示词字符串
 */
export const getSystemPrompt = (lang: string = 'zh') => {
  const base = PROMPTS[lang] || PROMPTS['zh'];
  return base + getCreativityModeAddon(lang);
};

// ─── 非流式 AI 调用 ──────────────────────────────────────────────────────────

/**
 * callDeepSeek — 非流式调用 AI（等全部回复完再返回）
 *
 * 适用场景：需要完整回复才能处理的情况（如格式解析、批处理）
 * 主聊天场景使用流式（callDeepSeekStream），因为流式体验更好。
 *
 * @param messages - 聊天消息历史数组
 * @param apiKey   - 可选：覆盖默认 Key
 * @param lang     - 语言（'zh' 或 'en'），用于选择系统提示词
 * @returns AI 的完整回复字符串
 */
export const callDeepSeek = async (messages: ChatMessage[], apiKey?: string, lang: string = 'zh', systemOverride?: string) => {
  const cfg = getApiConfig();
  const providerConfig = resolveProviderConfig(cfg.provider);
  const systemPrompt = systemOverride ?? getSystemPrompt(lang);

  if (providerConfig.format === 'anthropic') {
    const key = apiKey || cfg.key;
    if (!key) throw new Error('Claude API key required. Please set it in Settings.');

    const chatMessages = messages.filter(m => m.role !== 'system');
    const extraSystem  = messages.filter(m => m.role === 'system')
                                 .map(m => m.content).join('\n\n');
    const fullSystem = [systemPrompt, extraSystem].filter(Boolean).join('\n\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',            // 告诉服务器请求体是 JSON
        'x-api-key': key,                             // Anthropic 的认证方式（不用 Bearer）
        'anthropic-version': '2023-06-01',            // API 版本号（必须指定）
        'anthropic-dangerous-direct-browser-access': 'true', // 允许浏览器端直接调用（绕过 CORS 限制）
      },
      body: JSON.stringify({       // JSON.stringify 把对象转成 JSON 字符串（请求体）
        model: cfg.model,          // 使用的模型名
        max_tokens: 4096,          // 最大生成 token 数（约等于 3000 个英文单词）
        system: fullSystem,        // 系统提示词
        messages: chatMessages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content
        })),
      }),
    });

    // 处理非成功响应（HTTP 状态码非 2xx）
    if (!response.ok) {
      if (response.status === 401) throw new Error('API Unauthorized');       // Key 无效
      if (response.status === 402 || response.status === 529) throw new Error('API Quota Exceeded'); // 余额不足
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`API Error: ${response.status} ${JSON.stringify(errorData)}`);
    }

    const data = await response.json(); // 解析 JSON 响应体
    // Claude 响应格式：{ content: [{ type: "text", text: "AI的回复..." }] }
    // ?. 可选链：如果 content 或 [0] 不存在，不报错，返回 undefined，最后 || '' 给默认值
    return data.content?.[0]?.text || '';
  }

  // ── DeepSeek / OpenAI 路由 ────────────────────────────────────────────────
  // 优先用户传入的 Key，其次配置中的 Key，最后用内置默认 Key
  const key = getEffectiveApiKey(apiKey);
  const model = resolveProviderModel(providerConfig.id, cfg.model);
  const { url, headers } = buildProviderRequest(providerConfig.id, providerConfig.endpoint, key);

  try {
    const messagesToSend = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: messagesToSend,
        temperature: 0.3,
        stream: false
      })
    });

    if (!response.ok) {
      if (response.status === 402) throw new Error('API Quota Exceeded');
      if (response.status === 401) throw new Error('API Unauthorized');
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`API Error: ${response.status} ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    // OpenAI/DeepSeek 响应格式：{ choices: [{ message: { content: "..." } }] }
    return data.choices[0].message.content;

  } catch (error) {
    console.warn('[callDeepSeek] call failed:', error);
    throw error; // 重新抛出，让调用者处理
  }
};

// ─── 流式调用（主聊天场景）─────────────────────────────────────────────────

/**
 * callDeepSeekStream — 流式调用 AI（逐字输出，聊天主场景）
 *
 * 【什么是 SSE（Server-Sent Events）？】
 * 服务器和客户端建立持久连接，服务器可以持续推送数据。
 * AI 生成每个字时，服务器立刻推送一个数据块（chunk）给浏览器。
 * 每个数据块格式：data: {"choices":[{"delta":{"content":"你"}}]}
 *
 * 我们使用 ReadableStream 读取这些数据块，解码后提取文字，
 * 每次收到文字就调用 onChunk 回调更新界面显示。
 *
 * @param messages       - 聊天消息历史
 * @param onChunk        - 每收到一片文字时的回调函数（用于实时更新 UI）
 * @param apiKey         - DeepSeek/OpenAI 的 API Key
 * @param lang           - 语言（决定系统提示词语言）
 * @param claudeKey      - Claude 的 API Key（只有选择 Claude 时才需要）
 * @param useComputerUse - 是否启用 Claude 长手模式（Computer Use）
 */
export const callDeepSeekStream = async (
  messages: ChatMessage[],
  onChunk: (chunk: string) => void, // 回调函数类型：接收字符串，无返回值
  apiKey?: string,
  lang: string = 'zh',
  claudeKey?: string,
  useComputerUse: boolean = false   // 默认不启用长手模式
) => {
  const cfg = getApiConfig();
  const providerConfig = resolveProviderConfig(cfg.provider);

  if (providerConfig.format === 'anthropic') {
    const key = claudeKey || cfg.key || '';
    if (!key) throw new Error('Claude API key required. Please set it in Settings.');
    return callClaudeStream(messages, onChunk, key, lang, useComputerUse);
  }

  const key = getEffectiveApiKey(apiKey);
  const model = resolveProviderModel(providerConfig.id, cfg.model);
  const { url, headers } = buildProviderRequest(providerConfig.id, providerConfig.endpoint, key);
  const systemPrompt = getSystemPrompt(lang);

  try {
    const messagesToSend = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: messagesToSend,
        temperature: 0.3,
        stream: true // 关键：开启流式输出
      })
    });

    if (!response.ok) {
      if (response.status === 402) throw new Error('Insufficient Balance');
      if (response.status === 401) throw new Error('Unauthorized');
      if (response.status === 429) throw new Error('API Quota Exceeded');
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`API Error: ${response.status} ${JSON.stringify(errorData)}`);
    }

    // ── 读取 SSE 流数据 ────────────────────────────────────────────────────
    // response.body 是一个 ReadableStream（可读流）
    const reader = response.body?.getReader(); // 获取读取器
    // TextDecoder 把 Uint8Array（字节数组）解码成字符串
    const decoder = new TextDecoder('utf-8');
    if (!reader) throw new Error('Response body is unavailable');

    // 持续读取数据块，直到流结束
    while (true) {
      // reader.read() 返回 { done: 是否结束, value: 数据块(Uint8Array) }
      const { done, value } = await reader.read();
      if (done) break; // 流结束，退出循环

      // 把字节数组解码成文本字符串（stream: true 表示这是一个流，不是完整数据）
      const chunk = decoder.decode(value, { stream: true });

      // SSE 数据格式：每行一个事件，以 "data: " 开头
      // 把文本按换行符分割成多行
      const lines = chunk.split('\n');

      for (const line of lines) {
        // 只处理以 "data: " 开头的行（过滤掉空行和注释行）
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6); // 去掉前缀 "data: "（6个字符）

          // "[DONE]" 是 OpenAI/DeepSeek 标准的流结束标记，跳过
          if (jsonStr === '[DONE]') continue;

          try {
            const json = JSON.parse(jsonStr); // 解析 JSON
            // 提取 AI 生成的文字片段
            // choices[0].delta.content 是增量内容（这次新生成的字符）
            const content = json.choices[0]?.delta?.content || '';
            if (content) onChunk(content); // 有内容就触发回调，更新 UI
          } catch (e) {
            // JSON 解析失败（可能是数据块不完整），记录日志但继续处理
            console.warn('[callDeepSeekStream] skipping malformed chunk:', e);
          }
        }
      }
    }

  } catch (error) {
    if (error instanceof TypeError) throw new Error('NetworkError');
    console.warn('[callDeepSeekStream] stream ended with error:', error);
    throw error;
  }
};

// ─── Claude 专用流式调用 ─────────────────────────────────────────────────────

/**
 * callClaudeStream — Claude (Anthropic) 专用的流式响应处理
 *
 * Claude 的 SSE 格式与 OpenAI 不同：
 * OpenAI/DeepSeek 的数据块格式：
 *   data: {"choices":[{"delta":{"content":"文字"}}]}
 *
 * Claude 的数据块格式：
 *   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"文字"}}
 *
 * 所以需要单独处理。
 *
 * 【长手模式（Computer Use）】
 * 启用后，在系��提示词末尾追加一段说明，
 * 告诉 Claude 可以"模拟"浏览器操作步骤（实际操控需要后端支持）。
 *
 * @param messages       - 聊天消息历史
 * @param onChunk        - 文字片段回调
 * @param apiKey         - Anthropic API Key
 * @param lang           - 语言
 * @param useComputerUse - 是否启用长手模式
 */
export const callClaudeStream = async (
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
  apiKey: string,
  lang: string = 'zh',
  useComputerUse: boolean = false
) => {
  const cfg = getApiConfig();
  // 优先用 Claude 配置中的模型，没有就用默认模型
  const model = (cfg.provider === 'claude' ? cfg.model : null) || DEFAULT_MODELS['claude'];
  const systemPrompt = getSystemPrompt(lang);

  // ── 长手模式：追加操作说明到系统提示词 ──────────────────────────────────
  // 三元表达式：useComputerUse 为 true 时拼接额外说明，否则空字符串
  const computerUseNote = useComputerUse
    ? lang === 'zh'
      ? '\n\n【长手模式已启用】你拥有网页浏览与控制能力（模拟模式）。当用户要求你搜索、访问网页或操控浏览器时，请详细描述你将执行的步骤，并基于你的训练数据模拟返回结果。实际的网页控制需要部署后端代理服务。'
      : '\n\n[Long-Hand Mode Active] You have simulated web browsing and control capabilities. When the user asks you to search, visit a URL, or operate a browser, describe the steps you would take in detail and simulate a result based on your training data. Actual browser control requires a backend proxy deployment.'
    : ''; // 未启用长手模式：空字符串

  // ── 分离系统消息和聊天消息 ────────────────────────────────────────────────
  // Claude API 要求：系统提示词必须通过顶级 system 字段传递，不能在 messages 里
  const chatMessages = messages.filter(m => m.role !== 'system');   // 普通对话消息
  const extraSystem  = messages.filter(m => m.role === 'system')    // 额外的系统消息
                               .map(m => m.content).join('\n\n');   // 合并

  // 合并所有系统提示词（基础 + 额外 + 长手说明），过滤空字符串
  const fullSystem = [systemPrompt, extraSystem, computerUseNote].filter(Boolean).join('\n\n');

  // ── 发送请求 ──────────────────────────────────────────────────────────────
  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true', // 允许浏览器直接调用
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: fullSystem,
        messages: chatMessages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content
        })),
        stream: true, // 启用流式输出
      }),
    });
  } catch (networkErr) {
    // 网络错误（断网、DNS 解析失败等）
    console.warn('[callClaudeStream] network error:', networkErr);
    throw networkErr;
  }

  // 处理非成功 HTTP 状态
  if (!response.ok) {
    if (response.status === 401) throw new Error('Unauthorized');
    if (response.status === 402 || response.status === 529) throw new Error('Insufficient Balance');
    const errData = await response.json().catch(() => ({}));
    throw new Error(`API Error: ${response.status} ${JSON.stringify(errData)}`);
  }

  // ── 读取 Claude SSE 流 ────────────────────────────────────────────────────
  const reader = response.body?.getReader();
  const decoder = new TextDecoder('utf-8');
  if (!reader) throw new Error('Response body is unavailable');

  // buffer 用于处理"半截数据块"：
  // SSE 数据可能被分割在两次 read() 中，buffer 积累不完整的行
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // 解码新数据并追加到 buffer
    buffer += decoder.decode(value, { stream: true });

    // 按换行符分割所有行
    const lines = buffer.split('\n');

    // pop() 取出最后一个元素（可能是不完整的行），保留到下次处理
    // 其他完整的行进入 for 循环处理
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const jsonStr = line.slice(6).trim(); // 去掉 "data: " 前缀并去掉首尾空格
        if (!jsonStr) continue; // 空字符串跳过

        try {
          const json = JSON.parse(jsonStr);
          // Claude SSE 事件类型判断：
          // type === 'content_block_delta' 表示有新文字
          // delta.type === 'text_delta' 表示是文字类型的增量
          if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
            const text: string = json.delta.text || '';
            if (text) onChunk(text); // 触发回调，把文字传给 UI 更新
          }
        } catch (e) {
          // 跳过格式错误的 chunk（正常情况偶有发生）
        }
      }
    }
  }
};

// ─── OCR（图片文字识别）─────────────────────────────────────────────────────

/**
 * OCR_API_KEY — OCR.space 服务的 API Key
 * OCR.space 提供免费的图片文字识别 API，支持多种语言包括中文。
 * 这个 Key 是免费套餐的公共 Key。
 */
export const OCR_API_KEY = 'K87411514288957';

/**
 * preprocessForOCR — 图片预处理（提升 OCR 识别率）
 *
 * 【为什么要预处理？】
 * 原始图片可能分辨率低、对比度差，OCR 识别率会很低。
 * 预处理步骤：
 *   1. 缩放到最佳宽度（约 1300px）
 *   2. 转灰度（消除颜色干扰）
 *   3. 增强对比度（让文字更黑、背景更白，接近二值图）
 *   4. 导出 PNG（或降级为 JPEG 防止超过 OCR.space 的 1MB 限制）
 *
 * @param dataUrl - 图片的 base64 Data URL（"data:image/png;base64,..."）
 * @returns 预处理后的 Data URL（Promise 是异步操作的容器）
 */
const preprocessForOCR = (dataUrl: string): Promise<string> =>
  new Promise((resolve, reject) => {
    // 创建一个 Image 对象来加载图片
    const img = new Image();
    img.crossOrigin = 'anonymous'; // 跨域图片需要这个属性

    // 图片加载完成后执行
    img.onload = () => {
      // 1. 计算缩放比例，目标宽度 1300px
      const TARGET_W = 1300;
      const scale = img.width === 0 ? 1 : TARGET_W / img.width;
      const finalScale = Math.min(scale, 2); // 最多放大 2 倍（防止放大噪点）
      // Math.max 确保最小尺寸（防止图片太小）
      const w = Math.max(Math.round(img.width * finalScale), 200);
      const h = Math.max(Math.round(img.height * finalScale), 50);

      // 2. 创建 Canvas 并绘制图片
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!; // ! 告诉 TypeScript 这里一定不为 null

      // 先填充白色背景（防止透明通道影响灰度计算）
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h); // 把图片绘制到 canvas

      // 3. 灰度 + 对比度增强
      // getImageData 获取像素数据（每个像素 4 个字节：R G B A）
      const imgData = ctx.getImageData(0, 0, w, h);
      const d = imgData.data; // Uint8Array：[R0, G0, B0, A0, R1, G1, B1, A1, ...]

      // 逐像素处理（每 4 个字节是一个像素）
      for (let i = 0; i < d.length; i += 4) {
        // 感知亮度公式（人眼对绿色最敏感）：Y = 0.299R + 0.587G + 0.114B
        const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

        // Sigmoid 风格对比度增强：把中间值向两端推
        // 亮的更亮（→255白），暗的更暗（→0黑），中间的灰度被压缩
        const contrast = gray < 128
          ? Math.max(0, gray - Math.round((128 - gray) * 0.45))   // 暗区域：更暗
          : Math.min(255, gray + Math.round((gray - 128) * 0.45)); // 亮区域：更亮

        // 把三个通道都设为同一个灰度值（灰度图）
        d[i] = d[i + 1] = d[i + 2] = contrast;
        // d[i + 3] 是 Alpha（透明度），不修改
      }

      // 把修改后的像素数据写回 canvas
      ctx.putImageData(imgData, 0, 0);

      // 4. 导出为 Data URL（OCR.space 接受 base64 格式）
      const MAX_CHARS = 1_200_000; // OCR.space 的 base64 大小限制约 1MB
      let result = canvas.toDataURL('image/png');

      if (result.length > MAX_CHARS) {
        // 图片太大：缩小后导出 JPEG（JPEG 压缩率高）
        const ratio = Math.sqrt(MAX_CHARS / result.length) * 0.95; // 计算缩放比
        const c2 = document.createElement('canvas');
        c2.width = Math.round(w * ratio);
        c2.height = Math.round(h * ratio);
        const ctx2 = c2.getContext('2d')!;
        ctx2.fillStyle = '#ffffff';
        ctx2.fillRect(0, 0, c2.width, c2.height);
        ctx2.drawImage(canvas, 0, 0, c2.width, c2.height);
        result = c2.toDataURL('image/jpeg', 0.92); // JPEG 质量 92%
      }

      resolve(result); // 成功：把结果传给 Promise 的 then()
    };

    img.onerror = reject; // 失败：把错误传给 Promise 的 catch()
    img.src = dataUrl;    // 触发图片加载
  });

/**
 * callOCREngine — 调用 OCR.space 的单个识别引擎
 *
 * OCR.space 提供两种引擎：
 * - 引擎 1（Tesseract）：开源，擅长纯英文
 * - 引擎 2（专有引擎）：商业，对中文/混合内容更好
 *
 * @param dataUrl - 预处理后的图片 base64
 * @param engine  - '1' 或 '2'
 * @returns 识别出的文字，失败时返回 null
 */
const callOCREngine = async (
  dataUrl: string,
  engine: '1' | '2',
): Promise<string | null> => {
  // FormData 是 multipart/form-data 格式的请求体（类似 HTML 表单提交）
  const fd = new FormData();
  fd.append('base64Image', dataUrl);           // 图片的 base64 数据
  fd.append('language', 'chs');                // 语言：简体中文（也支持英文）
  fd.append('isOverlayRequired', 'false');     // 不需要文字位置信息（减小响应体积）
  fd.append('OCREngine', engine);              // 指定引擎版本
  fd.append('detectOrientation', 'true');      // 自动检测并纠正图片方向
  fd.append('scale', 'true');                  // 允许服务端缩放以提高识别率
  fd.append('isCreateSearchablePdf', 'false'); // 不生成可搜索 PDF（节省时间）

  let response: Response;
  try {
    response = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { apikey: OCR_API_KEY }, // OCR.space 通过 apikey 请求头认证
      body: fd,
    });
  } catch {
    return null; // 网络错误：返回 null（让调用方尝试另一个引擎）
  }

  if (!response.ok) return null; // HTTP 错误：返回 null

  // 解析响应 JSON
  let data: any;
  try { data = await response.json(); } catch { return null; }

  // IsErroredOnProcessing：OCR.space 内部处理出错
  if (data?.IsErroredOnProcessing) return null;

  // 提取识别出的文字
  // ParsedResults 是数组（一张图可能识别出多个区域）
  // 把所有区域的文字用换行连接
  const text: string = (data?.ParsedResults ?? [])
    .map((r: any) => (r?.ParsedText ?? '').trim()) // 取每个区域的文字并去空白
    .filter(Boolean)  // 过滤掉空字符串
    .join('\n')       // 用换行连接
    .trim();

  return text || null; // 空字符串也返回 null（表示没识别到内容）
};

/**
 * callOCRApi — OCR 主入口函数
 *
 * 处理管线：
 *   1. 图片预处理（灰度 + 对比度增强）
 *   2. 优先尝试引擎 2（专有引擎，对中文更好）
 *   3. 如果引擎 2 失败或结果太短，回退到引擎 1（Tesseract）
 *   4. 两个引擎都失败 → 抛出异常
 *
 * @param imageDataUrl - 原始图片的 Data URL
 * @returns 识别出的文字字符串
 * @throws OCREmpty — 两个引擎都未识别到有效文字
 */
export const callOCRApi = async (imageDataUrl: string): Promise<string> => {
  // 步骤 1：图片预处理
  let processed: string;
  try {
    processed = await preprocessForOCR(imageDataUrl); // 等待预处理完成（异步）
  } catch {
    processed = imageDataUrl; // 预处理失败则使用原图继续尝试
  }

  // 步骤 2：尝试引擎 2（专有引擎）
  // 结果长度 >= 4 才认为有效（少于 4 个字符可能是噪声）
  const result2 = await callOCREngine(processed, '2');
  if (result2 && result2.length >= 4) return result2;

  // 步骤 3：回退到引擎 1（Tesseract）
  const result1 = await callOCREngine(processed, '1');
  if (result1 && result1.length >= 4) return result1;

  // 步骤 4：使用任何有内容的结果（即使很短）
  if (result2) return result2;
  if (result1) return result1;

  // 两个引擎都完全没有识别到内容
  throw new Error('OCREmpty'); // 抛出特定错误码，ChatInterface 可以识别并显示友好提示
};

// ─── 解题模式（OCR → AI 流式解答）────────────────────────────────────────────

/**
 * SOLVE_SYSTEM — 解题模式的专用系统提示词
 * 与绘图模式的提示词完全不同：
 * - 绘图模式：要求 AI 输出 <DESMOS> 标签
 * - 解题模式：要求 AI 用数学公式（$...$ 格式）解答题目
 *
 * Record<'zh' | 'en', string> 表示键只能是 'zh' 或 'en'，值是字符串
 */
const SOLVE_SYSTEM: Record<'zh' | 'en', string> = {
  zh: [
    '你是一位专业的解题助手，擅长数学、物理、化学等理科题目。',
    '用户会直接上传题目图片，请**直接阅读图片中的题目**并解答（无需依赖外部 OCR）。',
    '若图片模糊或手写难辨，请根据可见信息合理推断并说明假设。',
    '',
    '**排版与 LaTeX 规范（必须遵守）：**',
    '1. 步骤清晰，分点说明；不同步骤之间空一行。',
    ...CHAT_LATEX_SYNTAX_ZH,
    '2. 如有多问，逐一回答；不要重复题目原文。',
    '',
    '**Desmos 绘图（与文字解答分开）：**',
    '- 题目中的函数/方程/图形，每个可绘制对象单独放在 <DESMOS>...</DESMOS> 中',
    '- 标签内是 Desmos 语法（单行、无 $ 符号），须遵守 help.desmos.com 规则：一条一式、\\\\le/\\\\ge 填色、参数式仅用 t、极坐标 r=f(\\\\theta)、回归用 ~、积分无逗号 dx',
    '- 示例：<DESMOS>y=x^2</DESMOS>、<DESMOS>0\\\\le y\\\\le f(x)\\\\left\\\\{0\\\\le x\\\\le 1\\\\right\\\\}</DESMOS>',
    '- 在给出解答的同时，把相关图形画到 Desmos 上',
  ].join('\n'),
  en: [
    'You are a professional problem-solving assistant specializing in math, physics, and chemistry.',
    'The user uploads a problem image directly — **read the image yourself** and solve (no external OCR).',
    'If the image is blurry or handwritten, infer reasonably and state your assumptions.',
    '',
    '**Formatting & LaTeX (required):**',
    '1. Clear steps with bullet points or numbered lists; blank line between sections.',
    ...CHAT_LATEX_SYNTAX_EN,
    '2. Answer each sub-question; do NOT repeat the problem statement.',
    '',
    '**Desmos plotting (separate from LaTeX text):**',
    '- Put each plottable object in its own <DESMOS>...</DESMOS> tag',
    '- Inside tags: Desmos syntax only, single line, NO $; follow help.desmos.com: one expr/tag, \\\\le/\\\\ge for fill, parametric uses t only, polar r=f(\\\\theta), regression uses ~, no comma before dx',
    '- Examples: <DESMOS>y=x^2</DESMOS>, <DESMOS>0\\\\le y\\\\le f(x)\\\\left\\\\{0\\\\le x\\\\le 1\\\\right\\\\}</DESMOS>',
    '- Plot all relevant graphs while solving',
  ].join('\n'),
};

/**
 * SOLVE_USER_PROMPTS — 解题模式的用户指令前缀
 * 根据用户选择的解题风格（hint/answer/full），在 OCR 内容后追加不同的指令
 *
 * Record<'hint' | 'answer' | 'full', Record<'zh' | 'en', string>>
 * = 两层嵌套的映射：解题模式 → 语言 → 指令字符串
 */
const SOLVE_USER_PROMPTS: Record<'hint' | 'answer' | 'full', Record<'zh' | 'en', string>> = {
  hint: {
    zh: '请**只提供解题思路、关键步骤和所用方法**��不要给出具体数值答案。',
    en: '**Only provide the approach, key steps, and methods** — do NOT give the final numerical answer.',
  },
  answer: {
    zh: '请**直接给出完整解题过程和最终答案**。',
    en: '**Give the complete step-by-step solution and final answer** directly.',
  },
  full: {
    zh: '请**①先简要说明解题思路，②再给出完整解题过程和最终答案**。',
    en: '**① First briefly explain the approach, ② then give the complete step-by-step solution and final answer.**',
  },
};

/**
 * callDeepSeekSolveStream — 解题模式：Gemini 视觉直读图片，流式解答（跳过 OCR）
 */
const buildSolveVisionUserContent = (
  imageDataUrl: string,
  solveMode: 'hint' | 'answer' | 'full',
  lang: 'zh' | 'en',
) => {
  const prompt = lang === 'zh'
    ? `请直接阅读附件题目图片并解答。\n\n${SOLVE_USER_PROMPTS[solveMode].zh}`
    : `Read the attached problem image and solve it.\n\n${SOLVE_USER_PROMPTS[solveMode].en}`;
  return [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: imageDataUrl } },
  ];
};

const buildClaudeSolveVisionContent = (
  imageDataUrl: string,
  solveMode: 'hint' | 'answer' | 'full',
  lang: 'zh' | 'en',
) => {
  const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
  const mediaType = imageDataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
  const prompt = lang === 'zh'
    ? `请直接阅读附件题目图片并解答。\n\n${SOLVE_USER_PROMPTS[solveMode].zh}`
    : `Read the attached problem image and solve it.\n\n${SOLVE_USER_PROMPTS[solveMode].en}`;
  return [
    {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: base64 },
    },
    { type: 'text', text: prompt },
  ];
};

export const callDeepSeekSolveStream = async (
  imageDataUrl: string,
  solveMode: 'hint' | 'answer' | 'full',
  onChunk: (chunk: string) => void,
  apiKey?: string,
  lang: string = 'zh',
  onProgress?: (stage: 'ocr' | 'analyzing') => void
): Promise<void> => {
  const cfg = getApiConfig();
  const providerConfig = resolveProviderConfig(cfg.provider);
  const key = getEffectiveApiKey(apiKey);
  const l = (lang === 'en' ? 'en' : 'zh') as 'zh' | 'en';
  const visionModel = resolveVisionModel(providerConfig.id, cfg.model);

  onProgress?.('analyzing');

  const compressedImage = await compressImageDataUrl(imageDataUrl);

  if (providerConfig.format === 'anthropic') {
    if (!key) throw new Error('Claude API key required. Please set it in Settings.');

    const response = await fetch(providerConfig.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 4096,
        system: SOLVE_SYSTEM[l],
        messages: [{
          role: 'user',
          content: buildClaudeSolveVisionContent(compressedImage, solveMode, l),
        }],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 401) throw new Error('Unauthorized');
      if (response.status === 402 || response.status === 529) throw new Error('Insufficient Balance');
      const errData = await response.json().catch(() => ({}));
      throw new Error(`API Error: ${response.status} ${JSON.stringify(errData)}`);
    }

    // 读取 Claude SSE 流（与 callClaudeStream 相同的逻辑）
    const reader = response.body?.getReader();
    const decoder = new TextDecoder('utf-8');
    if (!reader) throw new Error('Response body is unavailable');

    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        try {
          const json = JSON.parse(jsonStr);
          if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
            const text = json.delta.text || '';
            if (text) onChunk(text);
          }
        } catch (e) { /* 跳过格式错误的 chunk */ }
      }
    }
    return; // Claude 处理完成，函数结束
  }

  const { url, headers } = buildProviderRequest(providerConfig.id, providerConfig.endpoint, key);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: visionModel,
      messages: [
        { role: 'system', content: SOLVE_SYSTEM[l] },
        { role: 'user', content: buildSolveVisionUserContent(compressedImage, solveMode, l) },
      ],
      temperature: 0.2,
      stream: true,
    }),
  });

  if (!response.ok) {
    if (response.status === 402) throw new Error('Insufficient Balance');
    if (response.status === 401) throw new Error('Unauthorized');
    if (response.status === 429) throw new Error('API Quota Exceeded');
    const errData = await response.json().catch(() => ({}));
    throw new Error(`API Error: ${response.status} ${JSON.stringify(errData)}`);
  }

  // 读取 SSE 流（与 callDeepSeekStream 相同的逻辑）
  const reader = response.body?.getReader();
  const decoder = new TextDecoder('utf-8');
  if (!reader) throw new Error('Response body is unavailable');

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6);
      if (jsonStr === '[DONE]') continue;
      try {
        const json = JSON.parse(jsonStr);
        const content = json.choices[0]?.delta?.content || '';
        if (content) onChunk(content);
      } catch (e) {
        // 跳过格式错误的 chunk
      }
    }
  }
};
