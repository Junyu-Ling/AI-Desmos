import React from 'react';
import katex from 'katex';
import { FunctionSquare } from 'lucide-react';
import {
  normalizeChatLatexText,
  splitChatLatexSegments,
} from '../lib/chat-latex';
import {
  desmosLatexToKatexDisplay,
  prepareChatMessageDisplay,
} from '../lib/desmos-display';

type ChatMessageContentProps = {
  text: string;
};

const renderBoldText = (text: string, keyPrefix: string) =>
  text.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) => {
    const bold = part.match(/^\*\*([^*\n]+)\*\*$/);
    if (bold) {
      return (
        <strong key={`${keyPrefix}-b-${i}`} className="font-semibold text-gray-900">
          {bold[1]}
        </strong>
      );
    }
    if (!part) return null;
    return <React.Fragment key={`${keyPrefix}-t-${i}`}>{part}</React.Fragment>;
  });

const renderKatexHtml = (latex: string, display: boolean) => {
  try {
    return katex.renderToString(latex, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      trust: true,
    });
  } catch {
    return latex.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
};

const ChatLatexBlock: React.FC<{ text: string }> = ({ text }) => {
  const normalized = normalizeChatLatexText(text);
  const segments = splitChatLatexSegments(normalized);

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          if (!seg.data.trim()) return null;
          return (
            <span key={i} className="whitespace-pre-wrap">
              {renderBoldText(seg.data, String(i))}
            </span>
          );
        }

        if (seg.display) {
          return (
            <div
              key={i}
              className="chat-katex-display my-2 overflow-x-auto"
              dangerouslySetInnerHTML={{
                __html: renderKatexHtml(seg.data, true),
              }}
            />
          );
        }

        return (
          <span
            key={i}
            className="chat-katex-inline"
            dangerouslySetInnerHTML={{
              __html: renderKatexHtml(seg.data, false),
            }}
          />
        );
      })}
    </>
  );
};

// ── Markdown 块级元素解析 ────────────────────────────────────────────────────

type ContentBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'list'; items: string[]; ordered: boolean };

const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP_RE = /^\s*\|[\s|:-]+\|\s*$/;

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim());
}

function isTableSeparator(line: string): boolean {
  return TABLE_SEP_RE.test(line) && /[-]/.test(line);
}

/**
 * 将文本拆分为多种块级元素（表格、标题、列表、普通段落）
 */
function splitIntoBlocks(text: string): ContentBlock[] {
  const lines = text.split('\n');
  const blocks: ContentBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 标题 (# ## ###)
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: Math.min(headingMatch[1].length, 3) as 1 | 2 | 3,
        text: headingMatch[2].trim(),
      });
      i++;
      continue;
    }

    // 表格：当前行是表格行，下一行是分隔行
    if (
      TABLE_ROW_RE.test(line) &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const headers = parseTableRow(line);
      i += 2; // 跳过表头和分隔行
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // 无序列表（连续 - / * 开头的行）
    if (/^(\s*[-*])\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^(\s*[-*])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, '').trim());
        i++;
      }
      blocks.push({ type: 'list', items, ordered: false });
      continue;
    }

    // 有序列表（连续 1. 2. 开头的行）
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, '').trim());
        i++;
      }
      blocks.push({ type: 'list', items, ordered: true });
      continue;
    }

    // 普通文本：累积到下一个块级元素
    const textLines: string[] = [];
    while (
      i < lines.length &&
      !headingMatch &&
      !(/^(#{1,3})\s+/.test(lines[i])) &&
      !(TABLE_ROW_RE.test(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) &&
      !/^(\s*[-*])\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      textLines.push(lines[i]);
      i++;
    }
    if (textLines.length > 0) {
      const joined = textLines.join('\n').trim();
      if (joined) blocks.push({ type: 'paragraph', text: joined });
    }
  }

  return blocks;
}

// ── Markdown 块级元素渲染组件 ─────────────────────────────────────────────

const MarkdownTable: React.FC<{ headers: string[]; rows: string[][] }> = ({
  headers,
  rows,
}) => (
  <div className="overflow-x-auto my-2 rounded-lg border border-gray-200 shadow-sm">
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="bg-gray-50">
          {headers.map((h, hi) => (
            <th
              key={hi}
              className="px-3 py-2 text-left font-semibold text-gray-700 border-b border-gray-200 whitespace-nowrap"
            >
              <ChatLatexBlock text={h} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr
            key={ri}
            className={ri % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}
          >
            {row.map((cell, ci) => (
              <td
                key={ci}
                className="px-3 py-1.5 text-gray-600 border-b border-gray-100"
              >
                <ChatLatexBlock text={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const MarkdownHeading: React.FC<{ level: 1 | 2 | 3; text: string }> = ({
  level,
  text,
}) => {
  const cls: Record<1 | 2 | 3, string> = {
    1: 'text-base font-bold text-gray-900 mt-2 mb-1',
    2: 'text-sm font-bold text-gray-900 mt-1.5 mb-0.5',
    3: 'text-sm font-semibold text-gray-800 mt-1 mb-0.5',
  };
  return (
    <div className={cls[level]}>
      <ChatLatexBlock text={text} />
    </div>
  );
};

const MarkdownList: React.FC<{ items: string[]; ordered: boolean }> = ({
  items,
  ordered,
}) => (
  <div className="my-1 pl-1">
    {items.map((item, idx) => (
      <div key={idx} className="flex items-start gap-1.5 py-0.5">
        <span className="shrink-0 text-gray-400 select-none mt-px">
          {ordered ? `${idx + 1}.` : '•'}
        </span>
        <span className="flex-1 min-w-0">
          <ChatLatexBlock text={item} />
        </span>
      </div>
    ))}
  </div>
);

// ── 主文本块渲染（含表格、标题、列表） ───────────────────────────────────

const RichTextBlock: React.FC<{ text: string }> = ({ text }) => {
  const blocks = splitIntoBlocks(text);
  return (
    <>
      {blocks.map((block, bi) => {
        if (block.type === 'table') {
          return (
            <MarkdownTable key={bi} headers={block.headers} rows={block.rows} />
          );
        }
        if (block.type === 'heading') {
          return (
            <MarkdownHeading key={bi} level={block.level} text={block.text} />
          );
        }
        if (block.type === 'list') {
          return (
            <MarkdownList key={bi} items={block.items} ordered={block.ordered} />
          );
        }
        return (
          <div key={bi} className="chat-latex-body">
            <ChatLatexBlock text={block.text} />
          </div>
        );
      })}
    </>
  );
};

/**
 * 渲染聊天正文：Desmos 公式块 + LaTeX + Markdown（表格、标题、列表、粗体）
 */
const trimTextBesideFormula = (part: string, index: number, parts: string[]): string => {
  const prevIsFormula = index > 0 && /^<<FORMULA>>/.test(parts[index - 1]);
  const nextIsFormula = index < parts.length - 1 && /^<<FORMULA>>/.test(parts[index + 1]);
  let s = part;
  if (nextIsFormula) s = s.replace(/\n+\s*$/g, '');
  if (prevIsFormula) s = s.replace(/^\s*\n+/g, '');
  return s;
};

export const ChatMessageContent: React.FC<ChatMessageContentProps> = ({ text }) => {
  const parts = prepareChatMessageDisplay(text).split(/(<<FORMULA>>[\s\S]*?<<\/FORMULA>>)/g);

  return (
    <div className="chat-message-content text-sm text-gray-700 leading-relaxed space-y-1">
      {parts.map((part, pi) => {
        const formulaMatch = part.match(/^<<FORMULA>>([\s\S]*?)<<\/FORMULA>>$/);
        if (formulaMatch) {
          const latex = desmosLatexToKatexDisplay(formulaMatch[1]);
          return (
            <div
              key={pi}
              className="my-1 px-3 py-2 bg-blue-50/80 border border-blue-100 rounded-xl flex items-start gap-2.5 overflow-x-auto"
            >
              <FunctionSquare size={15} className="text-blue-500 shrink-0 mt-0.5" />
              <div
                className="min-w-0 text-sm text-blue-900 chat-katex-inline whitespace-nowrap"
                dangerouslySetInnerHTML={{
                  __html: renderKatexHtml(latex, false),
                }}
              />
            </div>
          );
        }

        if (!part) return null;

        const trimmed = trimTextBesideFormula(part, pi, parts).trim();
        if (!trimmed) return null;

        return <RichTextBlock key={pi} text={trimmed} />;
      })}
    </div>
  );
};
