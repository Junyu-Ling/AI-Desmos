import { normalizeDesmosAbsoluteValue } from './desmos-display';

/** 聊天 LaTeX 语法参考（中文，供 AI 系统提示词） */
export const CHAT_LATEX_SYNTAX_ZH: string[] = [
  '**聊天 LaTeX 语法全览（https://www.uinio.com/Math/LaTex/ ，KaTeX 渲染，仅用于 $...$ / $$...$$）：**',
  '',
  '【分隔符】行内 $f(x)$；独立一行 $$\\\\int_0^1 x^2\\\\,dx$$。解释文字里的变量也必须包在 $ 内。',
  '',
  '【分数与根式】\\\\frac{分子}{分母}（必须两个 {}）；\\\\sqrt{x}、\\\\sqrt[n]{x}。禁止 \\\\frac{58658}、\\\\sqrt{\\\\frac{58658}} 漏分母或未闭合。',
  '',
  '【上下标】a^2、a^{n+1}、a_2、a_{ij}；多字符下标/上标**必须花括号**：$s_{C}$、$n_{N}$，勿写 s_C、x^10 应写 x^{10}。',
  '',
  '【希腊字母】\\\\alpha \\\\beta \\\\gamma \\\\Delta \\\\theta \\\\lambda \\\\mu \\\\pi \\\\sigma \\\\omega 等；统计常用 \\\\bar{x}、\\\\hat{p}。',
  '',
  '【关系与运算】\\\\le \\\\ge \\\\ne \\\\equiv \\\\approx \\\\pm \\\\times \\\\cdot \\\\div \\\\infty。',
  '',
  '【函数】\\\\sin \\\\cos \\\\tan \\\\ln \\\\log \\\\exp \\\\min \\\\max \\\\gcd；特殊函数 \\\\operatorname{sgn}、\\\\operatorname{lcm}。',
  '',
  '【微积分】\\\\int_{a}^{b} f(x)\\\\,dx（微分前用 \\\\, 不用逗号）；\\\\sum_{k=1}^{n}；\\\\lim_{n \\\\to \\\\infty}；\\\\frac{d}{dx}(f(x))、f^{\\\\prime}(x)、f^{\\\\prime\\\\prime}(x)。',
  '',
  '【括号】复杂式子用 \\\\left( \\\\right)、\\\\left| \\\\right|、\\\\left\\\\{ \\\\right\\\\}；例 $\\\\left|\\\\frac{a}{b}\\\\right|$，勿在分式里裸写 |x|。',
  '',
  '【矩阵与方程组】$$\\\\begin{pmatrix} a & b \\\\\\\\ c & d \\\\end{pmatrix}$$；分段 $$f(x)=\\\\begin{cases} x^2, & x\\\\ge 0 \\\\\\\\ -x, & x<0 \\\\end{cases}$$；多行推导可用 align/cases 环境。',
  '',
  '【集合与逻辑】\\\\in \\\\notin \\\\subset \\\\cup \\\\cap \\\\emptyset；\\\\forall \\\\exists \\\\Rightarrow \\\\Leftrightarrow。',
  '',
  '【链式等式示范】$SE = \\\\sqrt{\\\\frac{s_{C}^2}{n_{C}} + \\\\frac{s_{N}^2}{n_{N}}} = \\\\sqrt{\\\\frac{225}{58} + \\\\frac{361}{58}} = \\\\sqrt{\\\\frac{586}{58}}$',
  '',
  '【禁止】Unicode 上下标（x²）；未闭合花括号；\\\\int f(x), dx；一个 $ 内混写中文说明。',
  '',
];

/** Chat LaTeX syntax reference (English, for AI system prompts) */
export const CHAT_LATEX_SYNTAX_EN: string[] = [
  '**Chat LaTeX syntax (https://www.uinio.com/Math/LaTex/ , KaTeX renderer, $...$ / $$...$$ only):**',
  '',
  '【Delimiters】Inline $f(x)$; display $$\\\\int_0^1 x^2\\\\,dx$$. Wrap all variables in prose with $.',
  '',
  '【Fractions & roots】\\\\frac{num}{den} (two braces required); \\\\sqrt{x}, \\\\sqrt[n]{x}. Never \\\\frac{58658} or unclosed \\\\sqrt{\\\\frac{...}}.',
  '',
  '【Sub/superscripts】a^2, a^{n+1}, a_2, a_{ij}; multi-char **must use braces**: $s_{C}$, not s_C; x^{10} not x^10.',
  '',
  '【Greek】\\\\alpha \\\\beta \\\\gamma \\\\Delta \\\\theta \\\\lambda \\\\mu \\\\pi \\\\sigma \\\\omega; stats: \\\\bar{x}, \\\\hat{p}.',
  '',
  '【Relations & ops】\\\\le \\\\ge \\\\ne \\\\equiv \\\\approx \\\\pm \\\\times \\\\cdot \\\\div \\\\infty.',
  '',
  '【Functions】\\\\sin \\\\cos \\\\tan \\\\ln \\\\log \\\\exp \\\\min \\\\max \\\\gcd; \\\\operatorname{sgn}, \\\\operatorname{lcm}.',
  '',
  '【Calculus】\\\\int_{a}^{b} f(x)\\\\,dx (use \\\\, not comma before dx); \\\\sum_{k=1}^{n}; \\\\lim_{n \\\\to \\\\infty}; \\\\frac{d}{dx}(f(x)), f^{\\\\prime}(x).',
  '',
  '【Brackets】Use \\\\left( \\\\right), \\\\left| \\\\right|, \\\\left\\\\{ \\\\right\\\\} in complex exprs; e.g. $\\\\left|\\\\frac{a}{b}\\\\right|$.',
  '',
  '【Matrices & systems】$$\\\\begin{pmatrix} a & b \\\\\\\\ c & d \\\\end{pmatrix}$$; piecewise $$f(x)=\\\\begin{cases} x^2, & x\\\\ge 0 \\\\\\\\ -x, & x<0 \\\\end{cases}$$.',
  '',
  '【Sets & logic】\\\\in \\\\notin \\\\subset \\\\cup \\\\cap \\\\emptyset; \\\\forall \\\\exists \\\\Rightarrow \\\\Leftrightarrow.',
  '',
  '【Chained equality example】$SE = \\\\sqrt{\\\\frac{s_{C}^2}{n_{C}} + \\\\frac{s_{N}^2}{n_{N}}} = \\\\sqrt{\\\\frac{586}{58}}$',
  '',
  '【Forbidden】Unicode superscripts (x²); unclosed braces; \\\\int f(x), dx; Chinese text inside $...$.',
  '',
];

export type LatexSegment =
  | { type: 'text'; data: string }
  | { type: 'math'; data: string; display: boolean };

/** 修正常见 LLM LaTeX 笔误（聊天 KaTeX 渲染前） */
export function fixChatLatexMathBody(latex: string): string {
  let s = latex.trim();

  // s_C、n_N → s_{C}、n_{N}
  s = s.replace(/([A-Za-z])_([A-Za-z]{1,4})(?![A-Za-z{])/g, '$1_{$2}');

  // \sqrt{\frac{digits}} 缺分母时，尝试拆成 \frac{前3}{后2}（如 58658 → 586/58）
  s = s.replace(
    /\\sqrt\s*\{\s*\\frac\s*\{(\d{4,})\}\s*\}/g,
    (_m, digits: string) => {
      const splitAt = digits.length - 2;
      if (splitAt <= 0) return _m;
      return `\\sqrt{\\frac{${digits.slice(0, splitAt)}}{${digits.slice(splitAt)}}}`;
    },
  );

  // \int ... , dx → \int ... \, dx
  s = s.replace(/,\s*(d[a-zA-Zθωπ]+)\b/g, '\\,$1');

  // x^10 等多位数字上标补花括号（仅纯数字）
  s = s.replace(/\^(\d{2,})(?![\d{])/g, '^{$1}');

  s = normalizeDesmosAbsoluteValue(s);

  return s;
}

/** 修正并统一 LaTeX 分隔符，确保 \[ \] 等块级公式可被识别 */
export function normalizeChatLatexText(text: string): string {
  let s = text;

  // LLM / JSON 里常见的双反斜杠分隔符
  s = s.replace(/\\\\\[/g, '\\[');
  s = s.replace(/\\\\\]/g, '\\]');
  s = s.replace(/\\\\\(/g, '\\(');
  s = s.replace(/\\\\\)/g, '\\)');

  // 分隔符两侧多余空白
  s = s.replace(/\\\[\s+/g, '\\[');
  s = s.replace(/\s+\\\]/g, '\\]');

  // 将 \[ ... \] 统一为 $$ ... $$（最稳妥的块级分隔）
  s = s.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_m, body) =>
    `\n$$${fixChatLatexMathBody(String(body).trim())}$$\n`);

  // \( ... \) → $ ... $
  s = s.replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_m, body) => `$${fixChatLatexMathBody(String(body))}$`);

  // 修正 $...$ 与 $$...$$ 内的常见笔误
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_m, body) => `$$${fixChatLatexMathBody(String(body))}$$`);
  s = s.replace(/(^|[^\\$])\$([^$\n]+?)\$(?!\$)/g, (_m, prefix, body) =>
    `${prefix}$${fixChatLatexMathBody(String(body))}$`);

  return s;
}

/** 顺序重要：先匹配 $$，再匹配行内 $ */
export const CHAT_LATEX_DELIMITERS = [
  { left: '$$', right: '$$', display: true },
  { left: '$', right: '$', display: false },
];

const escapeRegex = (s: string) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

const findEndOfMath = (delimiter: string, text: string, start: number): number => {
  let index = start;
  let braceLevel = 0;
  const len = delimiter.length;
  while (index < text.length) {
    if (braceLevel <= 0 && text.slice(index, index + len) === delimiter) {
      return index;
    }
    const ch = text[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === '{') braceLevel += 1;
    else if (ch === '}') braceLevel -= 1;
    index += 1;
  }
  return -1;
};

/** 按 LaTeX 分隔符切分 */
export function splitChatLatexSegments(text: string): LatexSegment[] {
  const delimiters = CHAT_LATEX_DELIMITERS;
  let rest = text;
  const data: LatexSegment[] = [];
  const regexLeft = new RegExp(
    `(${delimiters.map(d => escapeRegex(d.left)).join('|')})`,
  );

  while (true) {
    const match = rest.search(regexLeft);
    if (match === -1) break;

    if (match > 0) {
      data.push({ type: 'text', data: rest.slice(0, match) });
      rest = rest.slice(match);
    }

    const di = delimiters.findIndex(d => rest.startsWith(d.left));
    if (di === -1) break;

    const end = findEndOfMath(delimiters[di].right, rest, delimiters[di].left.length);
    if (end === -1) break;

    const math = rest.slice(delimiters[di].left.length, end).trim();
    data.push({ type: 'math', data: math, display: delimiters[di].display });
    rest = rest.slice(end + delimiters[di].right.length);
  }

  if (rest !== '') {
    data.push({ type: 'text', data: rest });
  }

  return data;
}
