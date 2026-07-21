/**
 * Desmos 标签规范化、画板注入语法 vs 聊天 LaTeX 展示
 */

/** 匹配 <DESMOS>…</DESMOS>（允许标签名与斜杠两侧有空格） */
export const DESMOS_TAG_PATTERN = /<\s*DESMOS\s*>([\s\S]*?)<\s*\/\s*DESMOS\s*>/i;

const desmosTagGlobal = () => new RegExp(DESMOS_TAG_PATTERN.source, 'gi');

/** @deprecated 请用 DESMOS_TAG_PATTERN + desmosTagGlobal() */
export const DESMOS_TAG_REGEX = desmosTagGlobal();

/** 统一标签写法，并压平标签内的换行 */
export function normalizeDesmosTagsInText(text: string): string {
  let s = text
    .replace(/<\s*\/\s*desmos\s*>/gi, '</DESMOS>')
    .replace(/<\s*desmos\s*>/gi, '<DESMOS>');

  s = s.replace(desmosTagGlobal(), (_m, inner) => {
    const body = String(inner).replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
    return body ? `<DESMOS>${body}</DESMOS>` : '';
  });

  return s;
}

/**
 * 规范化 Desmos 公式（注入画板与聊天展示共用）
 * - 逗号域条件 → \left\{...\right\}
 * - 去掉 \left\{ 前多余逗号、末尾孤立逗号
 */
export function normalizeDesmosFormulaLatex(formula: string): string {
  let clean = formula
    .replace(/[\n\r]+/g, ' ')
    .replace(/`/g, '')
    .trim()
    .replace(/\\\\/g, '\\');

  // a1 / b12 → a_{1} / b_{12}（Desmos 不支持字母紧接数字作变量名，必须用下标）
  // 排除：反斜杠命令（\sin1 不转）、已有下标（a_1 不动）、字母序列（sin、cos 等函数名）
  clean = clean.replace(/(?<![\\a-zA-Z_])([a-zA-Z])(\d+)(?![a-zA-Z_{])/g, '$1_{$2}');

  // \int ... x^2, dx → 去掉微分符号前的逗号
  clean = clean.replace(/,\s*(d[a-zA-Zθωπ]+)\b/g, ' $1');

  // AI 常写 "x^2, \left\{..." — 去掉 \left\{ 前的逗号
  clean = clean.replace(/,\s*(\\left\s*\\{)/g, ' $1');

  // AI 常写 f(x) \{0\le x\le 1\} — 补全为 \left\{...\right\}（勿破坏已有 \left\{...\right\}）
  clean = clean.replace(/\\{([^}]+)\}/g, (match, inner, offset, full) => {
    const before = full.slice(Math.max(0, offset - 6), offset);
    if (before.endsWith('left\\') || before.endsWith('left')) return match;
    if (before.endsWith('_') || before.endsWith('^')) return match;
    if (/^\d+$/.test(String(inner).trim())) return match;
    if (/\\right\s*\\?\}$/.test(full.slice(offset + match.length))) return match;
    const domain = String(inner).trim().replace(/\\+$/g, '');
    return `\\left\\{${domain}\\right\\}`;
  });

  if (clean.includes(',') && !clean.includes('\\{')) {
    if (/[<>]=?|\\le(?![a-zA-Z])|\\ge(?![a-zA-Z])/.test(clean)) {
      const lastCommaIdx = clean.lastIndexOf(',');
      if (lastCommaIdx !== -1) {
        const mainPart = clean.substring(0, lastCommaIdx).trim();
        const conditionPart = clean.substring(lastCommaIdx + 1).trim();
        if (conditionPart) {
          clean = `${mainPart} \\left\\{${conditionPart}\\right\\}`;
        }
      }
    }
  }

  // f(x)=x^2, 或 integrand 后多余逗号
  clean = clean.replace(/,\s*(\\right\\}|\\}|$)/g, ' $1');
  clean = clean.replace(/,\s*$/, '').trim();

  clean = wrapIntegralIntegrandInParens(clean);
  return clean;
}

const isBalancedParenExpr = (s: string): boolean => {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
};

/** 统一被积函数括号：\left/\right、\) 残片 → 普通圆括号 */
function normalizeIntegralIntegrandDelimiters(integrand: string): string {
  let b = integrand.trim();
  b = b.replace(/\\left\s*\(/g, '(').replace(/\\right\s*\)/g, ')');
  b = b.replace(/\\\(/g, '(').replace(/\\\)/g, ')');

  while (b.startsWith('((') && b.endsWith('))') && isBalancedParenExpr(b.slice(1, -1))) {
    b = b.slice(1, -1).trim();
  }
  // 剥掉最外层一对冗余括号（AI 已写 (expr) 时勿再叠一层）
  if (
    b.startsWith('(') &&
    b.endsWith(')') &&
    isBalancedParenExpr(b) &&
    isBalancedParenExpr(b.slice(1, -1))
  ) {
    const inner = b.slice(1, -1).trim();
    if (/[+-]/.test(inner)) b = inner;
  }
  b = b.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');
  return b;
}

/** 定积分被积函数含多项加减时，Desmos 需用括号包裹整个被积函数 */
function wrapIntegralIntegrandInParens(formula: string): string {
  if (!/\\int/i.test(formula)) return formula;

  return formula.replace(
    /\\int((?:_\{[^}]+\})?(?:\^\{[^}]+\})?)\s*([\s\S]+?)\s*(d[a-zA-Zθωπ]+)\b/gi,
    (_full, limits, integrand, dvar) => {
      let body = normalizeIntegralIntegrandDelimiters(String(integrand));
      if (!body) {
        return `\\int${limits} ${dvar}`;
      }
      if (!/[+-]/.test(body)) {
        return `\\int${limits} ${body} ${dvar}`;
      }
      if (
        body.startsWith('(') &&
        body.endsWith(')') &&
        isBalancedParenExpr(body)
      ) {
        return `\\int${limits} ${body} ${dvar}`;
      }
      return `\\int${limits} (${body}) ${dvar}`;
    },
  );
}

/** 将 Desmos LaTeX 转为 KaTeX 可渲染的展示用 LaTeX（仅用于聊天蓝框，不写入画板） */
export function desmosLatexToKatexDisplay(desmosLatex: string): string {
  const s = normalizeDesmosFormulaLatex(
    desmosLatex.replace(/<\s*\/?\s*desmos\s*>/gi, ''),
  );

  // 勿用 /\\le/g — 会误伤 \left、\leq；仅匹配独立 \le / \ge
  return s
    .replace(/\\le(?![a-zA-Z])/g, ' \\le ')
    .replace(/\\ge(?![a-zA-Z])/g, ' \\ge ')
    .replace(/([a-zA-Z])_(\d+)/g, '$1_{$2}')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 聊天展示：规范化标签 → 公式占位符 → 收紧空行 */
export function prepareChatMessageDisplay(text: string): string {
  let s = normalizeDesmosTagsInText(text);
  s = s.replace(desmosTagGlobal(), (_m, inner) => {
    const formula = normalizeDesmosFormulaLatex(String(inner));
    return formula ? `<<FORMULA>>${formula}<</FORMULA>>` : '';
  });
  return s
    .replace(/[ \t]*\n[ \t]*\n+(?=\s*<<FORMULA>>)/g, '\n')
    .replace(/(?<=<<FORMULA>>[\s\S]*?<<\/FORMULA>>)[ \t]*\n[ \t]*\n+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
