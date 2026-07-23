/**
 * ============================================================================
 * ChatInterface.tsx — AI 聊天界面（右侧面板）
 * ============================================================================
 *
 * 【这个组件做什么？】
 * 这是整个应用中最复杂、代码量最大的组件。
 * 它是右侧的 AI 对话栏，承担了几乎所有的"智能"功能。
 *
 * ── 聊天核心 ──
 *   - 渲染消息列表（用户消息、AI 回复、系统通知，支持 LaTeX 数学公式）
 *   - 流式 AI 回复（DeepSeek / OpenAI / Claude 三家路由，逐字显示）
 *   - 实时解析 AI 回复中的 <DESMOS> 标签，自动注入 Desmos 画板
 *   - t 滑块保护：自动过滤 `t = 数字` 格式（防止与参数方程冲突）
 *   - 画板上下文注入：把当前画板上的所有公式作为"系统消息"发给 AI
 *
 * ── 图片处理 ──
 *   - 上传图片 → 傅里叶变换绘图 / OCR 文字识别 → AI 解题
 *   - Ctrl+V 粘贴图片 → 弹出"画图还是解题"选择面板
 *   - 输入 Emoji（如 🦋）→ 直接绘制对应形状
 *
 * ── 设置面板 ──
 *   - 三家 API 服务商切换 + 独立 API Key 配置 + 模型选择
 *   - Claude 长手模式（Computer Use）开关
 *   - 邀请码兑换 / 语言切换（中/英）
 *
 * ── 试用模式 ──
 *   - 未配置自定义 Key 时，限制 AI 调用次数（免费额度）
 *   - 邀请码可以解锁无限次使用
 */

// ─── 导入区 ───────────────────────────────────────────────────────────────────

// React 核心及钩子
import React, { useState, useRef, useEffect } from 'react';

// lucide-react 图标库：导入所有用到的图标组件
// 每个图标名字就是图标的功能描述，例如：
// X=关闭  Send=发送  Paperclip=回形针（上传）  Bot=机器人（AI）
// User=用户  Loader2=加载圈  Trash2=垃圾桶  Layers=图层  BookOpen=书本
// MessageSquareX=删除消息  ScanEye=扫描眼（分析）  Share=分享（导出）
// Settings=设置齿轮  Key=钥匙（API Key）  Globe=地球（语言）  Pen=画笔
// ImageIcon=图片  Sigma=Σ积分符号  Eye=眼睛  Upload=上传
// Lightbulb=灯泡（提示）  Wrench=扳手（纠错）  FunctionSquare=函数框（公式）
// Pencil=铅笔  GraduationCap=学士帽（解题）  ChevronRight=右箭头  Lock=锁
// Zap=闪电（试用）  ExternalLink=外部链接  ShieldCheck=盾牌+对勾（安全）
// MousePointer2=鼠标指针（长手模式）  CloudOff=断网图标  RefreshCcw=刷新
import { X, Send, Paperclip, Bot, User, Loader2, Trash2, Layers, HelpCircle, BookOpen, MessageSquareX, ScanEye, Share, Settings, Key, Globe, Pen, ImageIcon, Sigma, Eye, Upload, Lightbulb, Wrench, Pencil, GraduationCap, ChevronRight, Lock, Zap, ExternalLink, ShieldCheck, MousePointer2, CloudOff, RefreshCcw, Square, Check, Film } from 'lucide-react';

// 工具函数：Desmos 流式注入
import { processDesmosStreamChunk, createDesmosInjectState } from '../lib/utils';

// AI API 调用函数和相关类型
import {
  callDeepSeekStream,
  callDeepSeekSolveStream,
  ChatMessage,
  ApiProvider,
  getApiConfig,
  detectProviderFromKey,
  getProviderById,
} from '../lib/deepseek';

// 图像处理：图片/Emoji → 傅里叶变换 → Desmos 表达式
import { processImageToFourier, processEmojiToFourier, applyFourierExpressionsProgressively, type ProgressiveDrawPhase, type SmartDrawMode } from '../lib/image-processing';
import { processGifToDesmosAnimation, applyGifExpressionsToCalculator, detachGifPlayback, type GifQualityTier } from '../lib/gif-animation';
import {
  clearWorkspace,
  createDebouncedWorkspaceSaver,
  loadWorkspace,
} from '../lib/desmos-persistence';
import {
  getActivePlaybackSnapshot,
  restoreGifPlaybackFromSnapshot,
} from '../lib/gif-playback';

// LaTeX 数学公式渲染库
// 把 $f(x)=x^2$ 这样的字符串渲染成美观的数学公式
import { ChatMessageContent } from './ChatMessageContent';

import { UserGuideContent } from './UserGuideContent';

// 国际化（中英双语）
import { useLanguage, Language, translations, detectReplyLanguage } from '../lib/i18n';

// ─── 类型定义 ────────────────────────────────────────────────────────────────

/**
 * ChatInterfaceProps — 组件接收的参数类型
 */
interface ChatInterfaceProps {
  /** Desmos 计算器实例（由 App.tsx 传入，用于操控画板） */
  calculator: any;

  /** 关闭聊天栏的回调函数（点击 × 按钮时调用） */
  onClose?: () => void;

  /** 外部触发的查询内容（如点击"AI 智能纠错"按钮时，App.tsx 把纠错请求写入这里） */
  externalQuery?: string;

  /** 外部查询处理完毕后的回调（用于让 App.tsx 清空 externalQuery） */
  onExternalQueryHandled?: () => void;

  /**
   * 纠错模式的目标表达式 ID
   * 当此 ID 不为空时，AI 的第一条 <DESMOS> 输出将替换该 ID 对应的公式，
   * 而不是清空整个画板重新绘制。
   */
  externalCorrectionExprId?: string;
}

/**
 * Message — 聊天消息的数据结构
 *
 * 【字段说明】
 * id              — 消息的唯一标识符（用作 React 列表的 key）
 * role            — 发送者角色：'user'=用户, 'assistant'=AI, 'system'=系统通知
 * content         — 消息的显示内容（已处理，去掉了 <DESMOS> 标签）
 * rawContent      — AI 原始回复（含 <DESMOS> 标签，用于保存到历史记录）
 * hasImage        — 该消息是否包含图片
 * imageUrl        — 图片的 Object URL（临时本地 URL，用于预览）
 * translationKey  — 国际化键名（优先于 content，自动随语言切换而更新）
 * translationParams — 国际化模板参数（如 {emoji: '🦋'}）
 */
interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  rawContent?: string;
  hasImage?: boolean;
  imageUrl?: string;
  translationKey?: keyof typeof translations['zh'];
  translationParams?: Record<string, string>;
  /** 绘画进度阶段：任务进行中时显示 spinner 与进度条 */
  drawingProgressPhase?: 'outline' | 'fill' | 'processing';
  drawingProgressCurrent?: number;
  drawingProgressTotal?: number;
  /** 消息创建时间（毫秒时间戳） */
  createdAt?: number;
}

const parseMessageTimestamp = (id: string): number | undefined => {
  if (id === 'init') return undefined;
  const n = Number(id);
  if (!Number.isFinite(n)) return undefined;
  const ts = Math.floor(n);
  if (ts >= 1_000_000_000_000 && ts <= 9_999_999_999_999) return ts;
  return undefined;
};

const getMessageTimestamp = (msg: Message): number | undefined =>
  msg.createdAt ?? parseMessageTimestamp(msg.id);

const formatMessageTime = (ts: number, language: Language): string => {
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';
  const date = new Date(ts);
  const now = new Date();
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);

  if (date.toDateString() === now.toDateString()) {
    return language === 'zh' ? `今天 ${time}` : `Today ${time}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return language === 'zh' ? `昨天 ${time}` : `Yesterday ${time}`;
  }

  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ calculator, onClose, externalQuery, onExternalQueryHandled, externalCorrectionExprId }) => {

  // ═══════════════════════════════════════════════════════════════════════════
  // 基础状态
  // ═══════════════════════════════════════════════════════════════════════════

  /** input — 聊天输入框中当前输入的文本内容 */
  const [input, setInput] = useState('');

  /**
   * 国际化 Hook，解构出三个工具：
   * language    — 当前语言（'zh' 或 'en'）
   * setLanguage — 切换语言的函数
   * t           — 翻译函数，t('key') 返回当前语言的文字
   */
  const { language, setLanguage, t } = useLanguage();

  /**
   * calculatorRef — 缓存最新的 Desmos 计算器实例
   *
   * 【为什么不直接用 calculator prop？】
   * 在异步回调（如 AI 流式输出的 onChunk 回调）中，
   * 闭包会"捕获"旧的 calculator 值（因为 JS 闭包的特性），
   * 而 useRef 的 .current 属性总是指向最新值，绕开了闭包问题。
   * 这是 React 中处理"异步中使用最新 prop"的标准技巧。
   */
  const calculatorRef = useRef(calculator);
  const workspaceRestoredRef = useRef(false);
  const workspaceSaverRef = useRef(createDebouncedWorkspaceSaver());

  const flushWorkspace = () => {
    const calc = calculatorRef.current;
    if (!calc) return;
    workspaceSaverRef.current.flush(calc, getActivePlaybackSnapshot());
  };

  /**
   * isComposingRef — 追踪中文输入法的组合状态
   *
   * 【为什么需要这个？】
   * 用中文输入法打字时，过程是：
   *   1. 按键 → 候选词出现（"组合"状态，isComposingRef = true）
   *   2. 选词/回车确认 → 文字上屏（组合结束，isComposingRef = false）
   *
   * 问题：用户按回车"确认中文词"时，也会触发"发送消息"的 Enter 事件。
   * 用这个 ref 判断是否在组合状态，组合状态下禁止发送。
   *
   * useRef 而不是 useState：因为这个状态变化不需要触发重渲染，只需要值。
   */
  const isComposingRef = useRef(false);

  /**
   * 每次 calculator prop 更新时，同步到 ref。
   * 依赖数组 [calculator]：只有 calculator 变化时才执行。
   */
  useEffect(() => {
    calculatorRef.current = calculator;
  }, [calculator]);

  /** 画板 + GIF 播放状态持久化：刷新恢复，变更自动保存，仅「清空画板」时清除 */
  useEffect(() => {
    if (!calculator) return;

    const saver = workspaceSaverRef.current;

    if (!workspaceRestoredRef.current) {
      workspaceRestoredRef.current = true;
      const workspace = loadWorkspace();
      if (workspace?.calculatorState) {
        try {
          calculator.setState(workspace.calculatorState);
          requestAnimationFrame(() => {
            if (workspace.gifPlayback?.length) {
              restoreGifPlaybackFromSnapshot(calculator, workspace.gifPlayback);
            }
          });
        } catch (error) {
          console.warn('[workspace] restore failed', error);
        }
      }
    }

    const scheduleSave = () => {
      saver.schedule(calculator, getActivePlaybackSnapshot());
    };

    if (typeof calculator.observeEvent === 'function') {
      calculator.observeEvent('change', scheduleSave);
    }

    const onPageHide = () => flushWorkspace();
    window.addEventListener('beforeunload', onPageHide);
    window.addEventListener('pagehide', onPageHide);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushWorkspace();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      saver.cancel();
      calculator.unobserveEvent?.('change', scheduleSave);
      window.removeEventListener('beforeunload', onPageHide);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      flushWorkspace();
    };
  }, [calculator]);

  // ═══════════════════════════════════════════════════════════════════════════
  // 消息历史（持久化到 localStorage）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * messages — 聊天消息列表
   *
   * 【惰性初始化】
   * useState 接受一个函数时，React 只在组件首次挂载时调用它（懒加载）。
   * 这里从 localStorage 读取历史聊天记录，避免每次重渲染都读一次。
   *
   * 【图片 URL 处理】
   * Object URL（URL.createObjectURL 生成的 blob: 开头的临时 URL）
   * 在页面刷新后会失效，所以恢复历史记录时要去掉 imageUrl。
   */
  const [messages, setMessages] = useState<Message[]>(() => {
    try {
      const saved = localStorage.getItem('desmos_chat_history'); // 读取保存的历史

      if (saved) {
        const parsedMessages = JSON.parse(saved) as Message[];
        const validKeys = new Set(Object.keys(translations.zh));

        // 恢复历史记录时，去掉 imageUrl；清除已失效的 translationKey（如已删除的联网功能）
        return parsedMessages.map((msg) => {
          const { imageUrl, ...rest } = msg;
          const normalized = rest.translationKey && !validKeys.has(rest.translationKey)
            ? {
                ...rest,
                translationKey: undefined,
                content: rest.content || '…',
              }
            : rest;
          const createdAt = normalized.createdAt ?? parseMessageTimestamp(normalized.id);
          const withoutStaleProgress = normalized.drawingProgressPhase
            ? {
                ...normalized,
                drawingProgressPhase: undefined,
                drawingProgressCurrent: undefined,
                drawingProgressTotal: undefined,
              }
            : normalized;
          return createdAt != null ? { ...withoutStaleProgress, createdAt } : withoutStaleProgress;
        });
      }
    } catch (e) {
      console.error('Failed to load chat history:', e);
    }

    // 没有历史记录（或读取失败）→ 返回初始欢迎消息
    // 使用 translationKey 而不是固定文字，这样欢迎语会随语言切换而变化
    return [{
      id: 'init',
      role: 'assistant',
      content: '你好！我是 AI Desmos 助手。', // 回退用的固定文字（translationKey 优先）
      translationKey: 'welcome'               // 优先用这个 key 翻译
    }];
  });

  /**
   * 每当 messages 更新，就把最新消息列表保存到 localStorage。
   * 这样用户刷新页面后聊天记录不会丢失。
   * 依赖数组 [messages]：messages 变化时触发。
   */
  useEffect(() => {
    try {
      // JSON.stringify 把数组转成 JSON 字符串（localStorage 只能存字符串）
      localStorage.setItem('desmos_chat_history', JSON.stringify(messages));
    } catch (e) {
      // 私隐/无痕模式下 localStorage 可能被禁用，错误静默处理
      console.error('Failed to save chat history:', e);
    }
  }, [messages]); // 依赖 messages

  /** isLoading — AI 是否正在生成回复（控制加载动画和禁用发送按钮） */
  const [isLoading, setIsLoading] = useState(false);

  /** 用于终止进行中的绘画/分析任务 */
  const taskAbortRef = useRef<AbortController | null>(null);

  const beginTask = () => {
    taskAbortRef.current?.abort();
    detachGifPlayback();
    const controller = new AbortController();
    taskAbortRef.current = controller;
    return controller;
  };

  const endTask = () => {
    taskAbortRef.current = null;
  };

  const handleCancelTask = () => {
    const drawingActive = messages.some(m => m.drawingProgressPhase);
    taskAbortRef.current?.abort();
    setIsLoading(false);
    if (drawingActive) {
      setMessages(prev => prev.map(m => {
        if (!m.drawingProgressPhase) return m;
        const isGif = Boolean(m.translationKey?.startsWith('gif_drawing'));
        return {
          ...m,
          content: t(isGif ? 'gif_drawing_saving_partial' : 'drawing_saving_partial'),
          translationKey: isGif ? 'gif_drawing_saving_partial' : 'drawing_saving_partial',
        };
      }));
      return;
    }
    taskAbortRef.current = null;
    setMessages(prev => [
      ...prev,
      {
        id: Date.now().toString(),
        role: 'system',
        content: 'Task cancelled',
        translationKey: 'task_cancelled',
      },
    ]);
  };

  const isAbortError = (error: unknown) =>
    error instanceof DOMException && error.name === 'AbortError';

  /** messagesEndRef — 指向消息列表末尾的空 div（用于滚动到底部） */
  const messagesEndRef = useRef<HTMLDivElement>(null);

  /** messagesContainerRef — 指向消息滚动容器（用于控制滚动位置） */
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  /**
   * scrollToBottom — 滚动消息列表到底部
   *
   * 使用 requestAnimationFrame 延迟到下一帧执行，
   * 确保 DOM 已经更新（新消息已渲染）后再滚动。
   * 直接用 scrollHeight 比 scrollIntoView 更可靠。
   */
  const scrollToBottom = () => {
    const container = messagesContainerRef.current;
    if (container) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight; // 滚动到最底部
      });
    }
  };

  /**
   * 每当消息列表更新，自动滚动到底部（显示最新消息）
   */
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  /**
   * 组件卸载时，清理所有图片的 Object URL（释放内存）
   *
   * Object URL 是用 URL.createObjectURL() 为上传图片创建的临时本地 URL。
   * 组件销毁时如果不手动释放，浏览器会一直持有这块内存（内存泄漏）。
   * [] 空依赖数组表示只在挂载时注册清理函数（返回的函数在卸载时调用）。
   */
  useEffect(() => {
    return () => {
      messages.forEach(msg => {
        if (msg.imageUrl) {
          URL.revokeObjectURL(msg.imageUrl); // 释放 Object URL
        }
      });
    };
  }, []);

  /**
   * 动态加载 KaTeX CSS（LaTeX 公式渲染所需的样式文件）
   *
   * KaTeX 是一个快速的数学公式渲染库，Latex 组件依赖它的 CSS 来正确显示公式。
   * 我们在 <head> 中动态插入 <link> 标签，而不是在 HTML 文件中硬编码，
   * 是因为这个样式只有聊天界面打开时才需要。
   *
   * 组件卸载时移除 link 标签（清理）。
   */
  useEffect(() => {
    // 创建 <link> 元素（CSS 样式表引用）
    const link = document.createElement('link');
    link.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css'; // CDN 地址
    link.rel = 'stylesheet';                                                        // 类型：样式表
    link.integrity = 'sha384-GvrOXuhMATgEsSwCs4smul74iXGOixntILdUW9XmUC6+HX0sLNAK3q71HotJqlAn'; // 完整性校验
    link.crossOrigin = 'anonymous';                                                // 跨域设置

    document.head.appendChild(link); // 把 link 标签插入到 <head> 中

    // 清理函数：组件卸载时移除 link 标签
    return () => {
      document.head.removeChild(link);
    };
  }, []); // 只执行一次

  // ═══════════════════════════════════════════════════════════════════════════
  // 面板开关状态
  // ═══════════════════════════════════════════════════════════════════════════

  /** showHelp — 是否显示使用帮助面板（覆盖在聊天界面上方） */
  const [showHelp, setShowHelp] = useState(false);

  /** showExport — 是否显示导出面板（显示导出脚本和复制按钮） */
  const [showExport, setShowExport] = useState(false);

  /** showSettings — 是否显示设置面板（API Key、模型、语言等） */
  const [showSettings, setShowSettings] = useState(false);

  /** exportScript — 导出按钮生成的 JavaScript 代码（用于粘贴到 Desmos 官网控制台） */
  const [exportScript, setExportScript] = useState('');

  /** copyCodeSuccess — 复制代码成功后按钮显示勾选状态 */
  const [copyCodeSuccess, setCopyCodeSuccess] = useState(false);
  const copyCodeResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ═══════════════════════════════════════════════════════════════════════════
  // API 配置状态（从 localStorage 惰性初始化）
  // ═════════════════════════════════════════════════���═════════════════════════

  /**
   * customApiKey — 用户输入的自定义 DeepSeek/OpenAI API Key
   * 惰性初始化：从 localStorage 读取，之前保存过的 Key 会自动填入
   */
  const [customApiKey, setCustomApiKey] = useState<string>(() => {
    try {
      return localStorage.getItem('desmos_api_key')
        || localStorage.getItem('claude_api_key')
        || localStorage.getItem('deepseek_api_key')
        || '';
    } catch { return ''; }
  });

  const [apiProvider, setApiProvider] = useState<ApiProvider>(() => {
    try {
      const key = localStorage.getItem('desmos_api_key')
        || localStorage.getItem('claude_api_key')
        || localStorage.getItem('deepseek_api_key')
        || '';
      const detected = key ? detectProviderFromKey(key) : null;
      return (detected?.id || localStorage.getItem('desmos_api_provider') || 'deepseek') as ApiProvider;
    } catch { return 'deepseek'; }
  });

  const [apiModel, setApiModel] = useState<string>(() => {
    try {
      const cfg = getApiConfig();
      return localStorage.getItem('desmos_api_model') || cfg.model;
    } catch { return 'deepseek-chat'; }
  });

  const [claudeLongHand, setClaudeLongHand] = useState<boolean>(() => {
    try { return localStorage.getItem('claude_long_hand') === '1'; } catch { return false; }
  });

  const hasCustomKey = customApiKey.trim().length > 0;
  const currentProviderConfig = getProviderById(apiProvider);

  // ═══════════════════════════════════════════════════════════════════════════
  // 试用模式：限制未配置 Key 的用户的 AI 调用次数
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * TRIAL_LIMIT — 试用模式的最大 AI 调用次数（常量，不会变）
   * 2 次用完后，需要配置自定义 Key 或使用邀请码才能继续。
   */
  const TRIAL_LIMIT = 2;

  /**
   * trialCallCount — 已使用的试用次数（从 localStorage 恢复）
   * parseInt(s, 10) 把字符串转成十进制整数
   */
  const [trialCallCount, setTrialCallCount] = useState<number>(() => {
    try {
      const s = localStorage.getItem('desmos_trial_calls');
      return s ? parseInt(s, 10) : 0;
    } catch { return 0; }
  });

  /** showTrialLimit — 是否显示"试用次数已用完"弹窗 */
  const [showTrialLimit, setShowTrialLimit] = useState(false);

  // ═══════════════════════════════════════════════════════════════════════════
  // 邀请码解锁
  // ═══════════════════════════════════════════════════════════════════════════

  /** INVITE_CODE — 正确的邀请码（常量）兑换成功后解除试用限制 */
  const INVITE_CODE = '20081201';

  /**
   * isInviteUnlocked — 是否已通过邀请码解锁（永久解除试用限制）
   * localStorage 中存储 '1' 表示已解锁
   */
  const [isInviteUnlocked, setIsInviteUnlocked] = useState<boolean>(() => {
    try { return localStorage.getItem('desmos_invite_unlocked') === '1'; } catch { return false; }
  });

  /** inviteCodeInput — 邀请码输入框的当前值 */
  const [inviteCodeInput, setInviteCodeInput] = useState('');

  /**
   * inviteCodeStatus — 邀请码兑换状态
   * 'idle'    — 初始/未操作
   * 'success' — 兑换成功
   * 'error'   — 邀请码错误（会在 2.2 秒后自动恢复到 'idle'）
   */
  const [inviteCodeStatus, setInviteCodeStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const handleApiKeyChange = (value: string) => {
    setCustomApiKey(value);
    const detected = detectProviderFromKey(value);
    if (detected) {
      setApiProvider(detected.id);
      setApiModel(prev => detected.models.includes(prev) ? prev : detected.defaultModel);
    }
  };

  /**
   * handleRedeemInviteCode — 兑换邀请码
   *
   * 比较用户输入的邀请码与正确答案：
   * - 正确：写入 localStorage 标记、更新状态、关闭弹窗
   * - 错误：显示错误状态 2.2 秒后恢复（给用户视觉反馈）
   */
  const handleRedeemInviteCode = () => {
    if (inviteCodeInput.trim() === INVITE_CODE) {
      // 邀请码正确：
      localStorage.setItem('desmos_invite_unlocked', '1'); // 永久记录已解锁
      setIsInviteUnlocked(true);                           // 更新状态
      setInviteCodeStatus('success');                      // 显示成功状态
      setInviteCodeInput('');                              // 清空输入框
      setShowTrialLimit(false);                            // 关闭弹窗
    } else {
      // 邀请码错误：
      setInviteCodeStatus('error'); // 显示错误状态（输入框变红）
      // 2.2 秒后自动恢复到 idle（让用户重新输入）
      setTimeout(() => setInviteCodeStatus('idle'), 2200);
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 图片上传相关状态
  // ═══════════════════════════════════════════════════════════════════════════

  /** showUploadMenu — 是否显示回形针按钮的弹出菜单（绘图 vs 解题模式选择） */
  const [showUploadMenu, setShowUploadMenu] = useState(false);

  /**
   * pendingFile — 等待用户选择解题风格的图片文件
   * 用户选择了"解题"模式后，会先弹出"仅提示/显示答案/提示+解答"的选择界面，
   * 图片文件暂存在这里，等用户确认后再处理。
   */
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  /** showSolveOptions — 是否显示解题模式选项底部弹窗 */
  const [showSolveOptions, setShowSolveOptions] = useState(false);

  /**
   * uploadModeRef — 当前上传模式（'draw'=绘图 或 'solve'=解题）
   * 用 useRef 而不是 useState，因为这个值只影响文件选择后的处理逻辑，
   * 不需要触发重渲染。
   */
  const uploadModeRef = useRef<'draw' | 'solve'>('draw');

  /** drawFileRef — 绘图模式的隐藏文件选择器 <input type="file"> 的引用 */
  const drawFileRef = useRef<HTMLInputElement>(null);

  /** showDrawModeSheet — 智能绘图：选择仅轮廓 / 仅涂色 / 轮廓+涂色 */
  const [showDrawModeSheet, setShowDrawModeSheet] = useState(false);

  /** pendingDrawFileRef — 粘贴图片后待选模式再处理的文件；null 表示走文件选择器 */
  const pendingDrawFileRef = useRef<File | null>(null);

  /** pendingEmojiDrawRef — 发送 Emoji 后待选绘图模式 */
  const pendingEmojiDrawRef = useRef<{ emoji: string } | null>(null);

  /** drawModeSheetSubtitle — 模式选择面板副标题（文件名 / Emoji） */
  const [drawModeSheetSubtitle, setDrawModeSheetSubtitle] = useState<string | null>(null);

  /** drawModeRef — 用户选定的绘图模式，供文件选择器回调使用 */
  const drawModeRef = useRef<SmartDrawMode>('both');

  /** GIF 质量档位（标准 / 电影级） */
  const gifQualityRef = useRef<GifQualityTier>('standard');
  const [gifQualityTier, setGifQualityTier] = useState<GifQualityTier>('standard');
  const [drawModeSheetIsGif, setDrawModeSheetIsGif] = useState(false);
  const [showGifQualitySheet, setShowGifQualitySheet] = useState(false);
  const pendingGifFileRef = useRef<{ file: File; mode: SmartDrawMode } | null>(null);

  /** solveFileRef — 解题模式的隐藏文件选择器的引用 */
  const solveFileRef = useRef<HTMLInputElement>(null);

  /**
   * pastedFile — 用户通过 Ctrl+V 粘贴的图片文件
   * 粘贴后显示为输入框旁边的缩略图预览，等待用户决定操作
   */
  const [pastedFile, setPastedFile] = useState<File | null>(null);

  /**
   * pastedPreview — 粘贴图片的预览 URL（Object URL）
   * 用于在输入框旁边显示图片缩略图
   */
  const [pastedPreview, setPastedPreview] = useState<string | null>(null);

  /**
   * showPasteSheet — 是否显示"粘贴图片操作选择"底部弹窗
   * 用户按 Enter 发送（有粘贴图片时）会弹出此面板，让用户选择操作
   */
  const [showPasteSheet, setShowPasteSheet] = useState(false);

  // ═══════════════════════════════════════════════════════════════════════════
  // 工具栏操作函数
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * handleSaveSettings — 保存设置面板中的所有配置到 localStorage
   * 关闭设置面板并弹出成功提示。
   */
  const handleSaveSettings = () => {
    localStorage.setItem('desmos_api_key', customApiKey.trim());
    localStorage.setItem('desmos_api_provider', apiProvider);
    localStorage.setItem('desmos_api_model', apiModel);
    localStorage.setItem('claude_long_hand', claudeLongHand ? '1' : '0');
    localStorage.removeItem('deepseek_api_key');
    localStorage.removeItem('claude_api_key');
    setShowSettings(false);
    alert(t('settings_saved_ok'));
  };

  const handleResetSettings = () => {
    localStorage.removeItem('desmos_api_key');
    localStorage.removeItem('desmos_api_provider');
    localStorage.removeItem('desmos_api_model');
    localStorage.removeItem('deepseek_api_key');
    localStorage.removeItem('claude_api_key');
    localStorage.removeItem('claude_long_hand');
    setCustomApiKey('');
    setApiProvider('deepseek');
    setApiModel('deepseek-chat');
    setClaudeLongHand(false);
    alert(t('settings_reset_ok'));
  };

  /**
   * handleExport — 生成画板导出脚本
   *
   * 获取当前 Desmos 画板的完整状态（所有公式、颜色、视口范围），
   * 序列化成 JSON，包装在 JavaScript 函数调用中。
   * 用户把这段代码粘贴到 desmos.com 的浏览器控制台，就能恢复画板。
   */
  const handleExport = () => {
    if (!calculatorRef.current) return;

    // getState() 返回画板的完整状态对象（包含所有表达式、设置等）
    const state = calculatorRef.current.getState();

    // 生成 JavaScript 代码：Calc.setState({...})
    // JSON.stringify 把状态对象序列化成 JSON 字符串
    const script = `Calc.setState(${JSON.stringify(state)})`;

    setExportScript(script);  // 保存到状态
    setCopyCodeSuccess(false);
    setShowExport(true);      // 打开导出面板
  };

  const markCopyCodeSuccess = () => {
    setCopyCodeSuccess(true);
    if (copyCodeResetTimerRef.current) clearTimeout(copyCodeResetTimerRef.current);
    copyCodeResetTimerRef.current = setTimeout(() => setCopyCodeSuccess(false), 2500);
  };

  const closeExportPanel = () => {
    setShowExport(false);
    setCopyCodeSuccess(false);
    if (copyCodeResetTimerRef.current) {
      clearTimeout(copyCodeResetTimerRef.current);
      copyCodeResetTimerRef.current = null;
    }
  };

  /**
   * handleCopyScript — 把导出脚本复制到剪贴板
   *
   * 使用两种方法确保兼容性：
   * 1. 现代 Clipboard API（navigator.clipboard.writeText）
   * 2. 旧版方法（execCommand('copy')，兼容旧浏览器）
   *
   * 先尝试旧版方法（通过创建临时 textarea 选中文字），
   * 失败则回退到 Clipboard API，都失败则提示用户手动复制。
   */
  const handleCopyScript = () => {
    const textArea = document.createElement('textarea');
    textArea.value = exportScript;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    const finish = () => document.body.removeChild(textArea);

    try {
      const successful = document.execCommand('copy');
      if (successful) {
        markCopyCodeSuccess();
        finish();
        return;
      }
      throw new Error('execCommand returned false');
    } catch (err) {
      console.warn('Legacy copy failed, trying Clipboard API:', err);
      finish();
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(exportScript)
          .then(() => markCopyCodeSuccess())
          .catch(e => {
            console.error('All copy methods failed', e);
            alert(t('copy_fail'));
          });
      } else {
        alert(t('copy_fail'));
      }
    }
  };

  /**
   * handleClearHistory — 清空所有聊天记录
   * 先弹窗确认，用户同意后清空消息列表和 localStorage 中的历史。
   */
  const handleClearHistory = () => {
    // confirm() 弹出浏览器原生确认对话框，用户点"取消"时返回 false
    if (confirm(t('confirm_clear'))) {
      // 清理所有图片的 Object URL（防止内存泄漏）
      messages.forEach(msg => {
        if (msg.imageUrl) {
          URL.revokeObjectURL(msg.imageUrl);
        }
      });

      // 重置为只有一条欢迎消息的初始状态
      const initMsg: Message = {
        id: 'init',
        role: 'assistant',
        content: 'Welcome',
        translationKey: 'welcome' // 使用翻译键，会随语言自动更新
      };
      setMessages([initMsg]);
      localStorage.removeItem('desmos_chat_history'); // 从本地存储中删除
    }
  };

  /**
   * revealDrawingProgress — 逐行/逐笔把公式写入 Desmos，展示绘画过程
   */
  const revealDrawingProgress = async (expressions: any[], progressMsgId: string, signal?: AbortSignal) => {
    const calc = calculatorRef.current;
    if (!calc || expressions.length === 0) return;

    const outlinePlotCount = expressions.filter(e =>
      /^(dft_plot_|hd_plot_)/.test(String(e.id || '')),
    ).length;
    const fillCount = expressions.filter(e =>
      String(e.id || '').startsWith('fill_poly_'),
    ).length;

    let progressRaf = 0;
    let pendingProgress: { done: number; total: number; phase: ProgressiveDrawPhase } | null = null;

    const flushProgress = () => {
      if (!pendingProgress) return;
      const { done, total, phase } = pendingProgress;
      pendingProgress = null;
      setMessages(prev => prev.map(m => {
        if (m.id !== progressMsgId) return m;
        if (phase === 'fill') {
          const fillDone = Math.min(fillCount, done);
          const fillTotal = Math.max(1, fillCount);
          return {
            ...m,
            drawingProgressPhase: 'fill',
            drawingProgressCurrent: fillDone,
            drawingProgressTotal: fillTotal,
            content: t('drawing_progress_fill', {
              current: String(fillDone),
              total: String(fillTotal),
            }),
            translationKey: 'drawing_progress_fill',
            translationParams: {
              current: String(fillDone),
              total: String(fillTotal),
            },
          };
        }
        const outlineDone = Math.min(outlinePlotCount, Math.max(0, done - fillCount));
        const outlineTotal = Math.max(1, outlinePlotCount);
        return {
          ...m,
          drawingProgressPhase: 'outline',
          drawingProgressCurrent: outlineDone,
          drawingProgressTotal: outlineTotal,
          content: t('drawing_progress_outline', {
            current: String(outlineDone),
            total: String(outlineTotal),
          }),
          translationKey: 'drawing_progress_outline',
          translationParams: {
            current: String(outlineDone),
            total: String(outlineTotal),
          },
        };
      }));
    };

    await applyFourierExpressionsProgressively(calc, expressions, {
      signal,
      onProgress: (done, total, phase: ProgressiveDrawPhase) => {
        if (signal?.aborted) return;
        pendingProgress = { done, total, phase };
        if (progressRaf) return;
        progressRaf = requestAnimationFrame(() => {
          progressRaf = 0;
          flushProgress();
        });
      },
    });
    if (pendingProgress) flushProgress();
  };

  /**
   * handleClearCanvas — 清空 Desmos 画板上的所有公式
   * 调用 Desmos API 的 setBlank() 清空画板，并在聊天中添加系统通知消息。
   */
  const handleClearCanvas = () => {
    detachGifPlayback();
    clearWorkspace();
    if (calculatorRef.current) {
      calculatorRef.current.setBlank(); // 清空画板（删除所有表达式）

      // 在聊天中添加一条系统通知（浅色小字，告知用户已清空）
      setMessages(prev => [...prev, {
        id: Date.now().toString(),    // 时间戳作为唯一 ID
        role: 'system',               // 系统消息（特殊样式）
        content: 'Canvas Cleared',    // 回退文字
        translationKey: 'canvas_cleared' // 国际化键（优先）
      }]);
    }
  };

  /**
   * 从 Desmos 实例实时读取表达式列表（优先 getExpressions，回退 getState）
   */
  const readLiveCanvasExpressions = (calcInstance: any): any[] => {
    let raw: any[] = [];
    try {
      raw = calcInstance.getExpressions?.() || [];
    } catch (e) {
      console.warn('[readLiveCanvasExpressions] getExpressions() failed', e);
    }
    if (raw.length === 0) {
      try {
        raw = calcInstance.getState()?.expressions?.list || [];
      } catch (e) {
        console.warn('[readLiveCanvasExpressions] getState() failed', e);
      }
    }
    return raw;
  };

  const isInternalHelperExpression = (expr: any): boolean => {
    const id = String(expr?.id || '');
    if (/^(dft_|hd_)(freq|real|imag|x|y)_/.test(id)) return true;
    if (expr?.type === 'folder' || expr?.type === 'text' || expr?.type === 'table') return true;
    return false;
  };

  const formatExpressionLine = (expr: any, index: number, forAnalyze: boolean): string => {
    const latex = (expr.latex || '').trim();
    const parts: string[] = [`${index + 1}.`];
    if (forAnalyze && expr.color) parts.push(`[color=${expr.color}]`);
    if (expr.hidden) parts.push('[hidden]');
    const maxLen = forAnalyze ? 280 : 150;
    const body = latex.length > maxLen ? `${latex.substring(0, maxLen)}...` : latex;
    parts.push(body);
    return parts.join(' ');
  };

  /**
   * getCalculatorContext — 获取当前 Desmos 画板的状态文字描述
   *
   * forAnalyze=true 时：每次点击小眼睛重新读取画布，只列出可见公式，省略内部辅助项。
   */
  const getCalculatorContext = (options?: { forAnalyze?: boolean }) => {
    const forAnalyze = options?.forAnalyze === true;
    const calcInstance = calculatorRef.current;

    if (!calcInstance) return `${t('context_title')}\n(N/A)`;

    const rawExpressions = readLiveCanvasExpressions(calcInstance);
    const withLatex = rawExpressions.filter((e: any) => e.latex && e.latex.trim() !== '');

    const visibleExpressions = withLatex.filter(
      (e: any) => !e.hidden && !isInternalHelperExpression(e),
    );
    const omittedHelpers = withLatex.filter(
      (e: any) => e.hidden || isInternalHelperExpression(e),
    );

    console.log(
      `[Analyze] Live snapshot: ${visibleExpressions.length} visible, `
      + `${omittedHelpers.length} helpers, ${rawExpressions.length} total`,
    );

    const bounds = calcInstance.graphpaperBounds?.mathCoordinates;
    let contextStr = '';

    if (forAnalyze) {
      contextStr += `${t('context_snapshot_time')} ${new Date().toLocaleString()}\n`;
      contextStr += `${t('context_visible_count', { count: String(visibleExpressions.length) })}\n\n`;
    }

    if (visibleExpressions.length > 0) {
      const maxItems = forAnalyze ? 50 : 20;
      const listed = visibleExpressions.slice(0, maxItems);
      contextStr += `${forAnalyze ? t('context_expressions_live') : t('context_expressions')}\n`;
      contextStr += listed.map((e, i) => formatExpressionLine(e, i, forAnalyze)).join('\n');
      if (visibleExpressions.length > maxItems) {
        contextStr += `\n... and ${visibleExpressions.length - maxItems} more visible expressions`;
      }
      contextStr += '\n';
      if (forAnalyze && omittedHelpers.length > 0) {
        contextStr += `\n${t('context_hidden_note', { count: String(omittedHelpers.length) })}\n`;
      }
    } else {
      contextStr += `${t('context_expressions')}\n${t('context_empty')}\n`;
    }

    if (bounds) {
      contextStr += `\n${t('context_viewport')}\nx=[${bounds.left.toFixed(2)}, ${bounds.right.toFixed(2)}], y=[${bounds.bottom.toFixed(2)}, ${bounds.top.toFixed(2)}]`;
    }

    return `${t('context_title')}\n${contextStr}\n\n${forAnalyze ? t('context_instruction') : t('context_instruction_general')}`;
  };

  const getVisibleCanvasCount = () => {
    const calcInstance = calculatorRef.current;
    if (!calcInstance) return 0;
    return readLiveCanvasExpressions(calcInstance).filter(
      (e: any) => e.latex?.trim() && !e.hidden && !isInternalHelperExpression(e),
    ).length;
  };

  /**
   * 核心消息发送函数。
   * 处理流程：检测 Emoji → 选择绘图模式 → 绘制；否则流式 AI
   */
  const closeDrawModeSheet = () => {
    setShowDrawModeSheet(false);
    setDrawModeSheetSubtitle(null);
    pendingDrawFileRef.current = null;
    pendingEmojiDrawRef.current = null;
  };

  const executeEmojiDraw = async (emoji: string, mode: SmartDrawMode, signal?: AbortSignal) => {
    const aiMsgId = (Date.now() + Math.random()).toString();
    setMessages(prev => [...prev, {
      id: aiMsgId,
      role: 'assistant',
      content: `Drawing ${emoji}...`,
      translationKey: 'emoji_drawing',
      translationParams: { emoji },
      drawingProgressPhase: 'processing',
    }]);

    const result = await processEmojiToFourier(emoji, {
      mode,
      apiKey: customApiKey,
      enableAiRepair: true,
      onRepairProgress: (phase) => {
        const key = phase === 'ai_analyze' ? 'drawing_ai_repair' : 'drawing_local_repair';
        setMessages(prev => prev.map(m =>
          m.id === aiMsgId ? { ...m, content: t(key), translationKey: key } : m
        ));
      },
    });
    if (signal?.aborted) return;
    await revealDrawingProgress(result.expressions, aiMsgId, signal);

    setMessages(prev => prev.map(m =>
      m.id === aiMsgId ? {
        ...m,
        content: `Success ${emoji}`,
        translationKey: 'emoji_success',
        translationParams: { emoji },
        drawingProgressPhase: undefined,
        drawingProgressCurrent: undefined,
        drawingProgressTotal: undefined,
      } : m
    ));
  };

  const openDrawModeSheet = (subtitle: string | null, isGif = false) => {
    setDrawModeSheetSubtitle(subtitle);
    setDrawModeSheetIsGif(isGif);
    if (isGif) {
      setGifQualityTier('standard');
      gifQualityRef.current = 'standard';
    }
    setShowDrawModeSheet(true);
  };

  const handleSendMessage = async (manualContent?: string, options?: { analyzeOnly?: boolean; correctionExprId?: string }) => {
    const textToSend = manualContent || input;
    if (!textToSend.trim()) return;
    const isAnalyzeOnly = options?.analyzeOnly === true;
    /** 纠错模式：仅替换指定 ID 的表达式，不清空画板 */
    const correctionExprId = options?.correctionExprId || null;

    const userMsg: Message = { id: Date.now().toString(), role: 'user', content: textToSend };
    
    setMessages(prev => [...prev, userMsg]);
    if (!manualContent) setInput('');
    setIsLoading(true);
    const task = beginTask();

    const aiMsgId = (Date.now() + Math.random()).toString();

    const emojiMatch = textToSend.match(/([\p{Emoji_Presentation}\p{Extended_Pictographic}])/u);
    const isShortRequest = textToSend.length < 30;
    
    if (emojiMatch && isShortRequest) {
        const emoji = emojiMatch[0];
        pendingEmojiDrawRef.current = { emoji };
        openDrawModeSheet(emoji);
        endTask();
        setIsLoading(false);
        return;
    }

    setMessages(prev => [...prev, { id: aiMsgId, role: 'assistant', content: '' }]);

    try {
      const MAX_HISTORY_MSG = 10;
      let history: ChatMessage[];

      if (isAnalyzeOnly) {
        // 分析模式：不携带聊天历史，仅使用点击瞬间读取的画布快照
        const contextContent = getCalculatorContext({ forAnalyze: true });
        const analysisPrompt = language === 'zh'
          ? "【分析模式】你只能依据上方「实时画板快照」作答。禁止引用聊天记录中的旧公式。禁止输出 <DESMOS> 标签，禁止修改画板。若快照为空，直接告知用户画板为空。用 $...$ 表示数学公式，分段清晰解释每条可见内容的含义及其关系。"
          : "[Analysis Mode] Answer ONLY from the live canvas snapshot above. Do NOT cite formulas from chat history. Do NOT output <DESMOS> tags or modify the canvas. If the snapshot is empty, say so. Use $...$ for math. Explain each visible item and how they relate.";

        history = [
          { role: 'system', content: contextContent },
          { role: 'system', content: analysisPrompt },
          { role: 'user', content: textToSend },
        ];
      } else {
        history = messages
          .filter(m => m.id !== 'init' && m.role !== 'system')
          .slice(-MAX_HISTORY_MSG)
          .map(m => {
              let content: string;
              if (m.role === 'assistant' && m.rawContent) {
                content = m.rawContent;
              } else {
                content = m.content || '';
                content = content.replace(/<<FORMULA>>([\s\S]*?)<<\/FORMULA>>/g, '<DESMOS>$1</DESMOS>');
              }
              if (content.length > 800) {
                content = content.substring(0, 800) + "\n... (truncated)";
              }
              return {
                role: m.role as 'user' | 'assistant',
                content: content
              };
          });

        const contextContent = getCalculatorContext();
        history.push({
            role: 'system',
            content: contextContent
        });

        if (correctionExprId) {
            history.push({
                role: 'system',
                content: "SYSTEM ALERT: You are in 'Correction Mode'. The user has a formula with a syntax error. You MUST: 1) Output EXACTLY ONE corrected formula wrapped in <DESMOS> tags. 2) Keep the formula semantically close to what the user intended. 3) Briefly explain what was wrong and what you changed. 4) Do NOT output multiple <DESMOS> blocks. 5) Do NOT add or remove other canvas expressions."
            });
        } else {
            history.push({
                role: 'system',
                content: "SYSTEM ALERT: You are in 'Desmos Mode'. You MUST output math in <DESMOS>...</DESMOS> tags. Example: <DESMOS>x^2+y^2=1</DESMOS>. Unformatted math will NOT be visible to the user. Do NOT chat about math without drawing it. Structure your response with clear paragraphs separated by blank lines for readability. Use line breaks between different points or explanations."
            });
        }

        history.push({ role: 'user', content: textToSend });
      }

      let fullRawContent = '';
      const desmosState = createDesmosInjectState();

      const requestLang = detectReplyLanguage(textToSend);

      // ── Trial mode gate ──────────────────────────────────────────────────
      // Claude provider: always requires its own API key (no built-in key).
      // DeepSeek/OpenAI: use built-in default key within trial quota.
      const isClaude = apiProvider === 'claude';
      if (isClaude && !hasCustomKey) {
        setMessages(prev => prev.filter(m => m.id !== aiMsgId));
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          role: 'system',
          content: language === 'zh'
            ? '⚠️ 使用 Claude 需要配置 Anthropic API Key。请点击右上角设置按钮添加您的 Key。'
            : '⚠️ Claude requires an Anthropic API Key. Click the Settings button to add your key.',
        }]);
        setTimeout(() => setShowSettings(true), 600);
        return;
      } else if (!hasCustomKey) {
        // No custom key → use the built-in default key, but only if the user
        // still has trial quota OR has unlocked with an invite code.
        if (!isInviteUnlocked && trialCallCount >= TRIAL_LIMIT) {
          setMessages(prev => prev.filter(m => m.id !== aiMsgId));
          setShowTrialLimit(true);
          return; // finally block will still call setIsLoading(false)
        }
        // Consume one trial slot (not needed for invite-unlocked users)
        if (!isInviteUnlocked) {
          const next = trialCallCount + 1;
          setTrialCallCount(next);
          localStorage.setItem('desmos_trial_calls', String(next));
        }
        // Fall through → callDeepSeekStream will use DEEPSEEK_API_KEY as fallback
      }
      // ────────────────────────────────────────────────────────────────────

      await callDeepSeekStream(history, (chunk) => {
          fullRawContent += chunk;
          const displayContent = processDesmosStreamChunk(
            fullRawContent,
            calculatorRef.current,
            desmosState,
            { skip: isAnalyzeOnly, correctionExprId },
          );
          setMessages(prev => prev.map(m =>
              m.id === aiMsgId ? { ...m, content: displayContent, rawContent: fullRawContent } : m
          ));
      }, customApiKey, requestLang, customApiKey, claudeLongHand); 
      
    } catch (error: any) {
      if (isAbortError(error)) return;
      let errorKey: keyof typeof translations['zh'] = 'err_system';
      if (error.message && (error.message.includes('Insufficient Balance') || error.message.includes('API Quota Exceeded'))) {
         errorKey = 'err_balance';
      } else if (error.message && (
         error.message.includes('Unauthorized') ||
         error.message.includes('API Unauthorized') ||
         error.message.includes('401')
      )) {
         errorKey = 'err_key';
      } else if (error.message && (
         error.message.includes('NetworkError') ||
         error.message.includes('Failed to fetch')
      )) {
         errorKey = 'err_network';
      }

      setMessages(prev => [...prev, { 
          id: Date.now().toString(), 
          role: 'system', 
          content: 'Error',
          translationKey: errorKey
      }]);

      // Auto-open settings on auth/key errors so user can fix immediately
      if (errorKey === 'err_key') {
        setTimeout(() => setShowSettings(true), 800);
      }
    } finally {
      endTask();
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (externalQuery) {
        // 将 externalCorrectionExprId 传入 handleSendMessage，触发纠错模式
        handleSendMessage(externalQuery, { correctionExprId: externalCorrectionExprId || undefined });
        if (onExternalQueryHandled) onExternalQueryHandled();
    }
  }, [externalQuery]);

  /**
   * handleAnalyzeGraph — 分析当前画板
   *
   * 点击顶部工具栏的"分析"按钮（眼睛图标）时调用。
   * 发送一条预定义的分析提示词，并传入 analyzeOnly: true，
   * 告诉 handleSendMessage 进入"分析模式"：
   *   - AI 只解读公式的数学含义
   *   - 不输出 <DESMOS> 标签（不修改画板）
   */
  const handleAnalyzeGraph = () => {
    if (!calculatorRef.current) return;

    const visibleCount = getVisibleCanvasCount();
    if (visibleCount === 0) {
      setMessages(prev => [
        ...prev,
        { id: Date.now().toString(), role: 'user', content: t('analyze_prompt') },
        {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: t('analyze_empty'),
          translationKey: 'analyze_empty',
        },
      ]);
      return;
    }

    handleSendMessage(t('analyze_prompt'), { analyzeOnly: true });
  };

  /**
   * processFile — 处理上传的图片/GIF 文件（绘图模式）
   */
  const isGifFile = (file: File) =>
    file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');

  const processGifFile = async (
    file: File,
    mode: SmartDrawMode = 'both',
    quality: GifQualityTier = 'standard',
  ) => {
    const imageUrl = URL.createObjectURL(file);

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: `[${t('upload_image')}: ${file.name}]`,
      hasImage: true,
      imageUrl,
    };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);
    const task = beginTask();
    const progressMsgId = (Date.now() + 1).toString();

    try {
      setMessages(prev => [...prev, {
        id: progressMsgId,
        role: 'assistant',
        content: t('gif_drawing_processing'),
        translationKey: 'gif_drawing_processing',
        drawingProgressPhase: 'processing',
      }]);

      let gifProgressRaf = 0;
      let pendingGifProgress: {
        current: number;
        total: number;
        phase: 'decode' | 'frame' | 'ai' | 'worker' | 'inject';
      } | null = null;

      const flushGifProgress = () => {
        if (!pendingGifProgress) return;
        const { current, total, phase } = pendingGifProgress;
        pendingGifProgress = null;
        const key = phase === 'decode'
          ? 'gif_drawing_processing'
          : phase === 'inject'
            ? 'gif_drawing_inject'
            : phase === 'ai'
              ? 'gif_drawing_ai'
              : phase === 'worker'
                ? 'gif_drawing_worker'
                : 'gif_drawing_frame';
        setMessages(prev => prev.map(m =>
          m.id === progressMsgId
            ? {
                ...m,
                content: t(key, {
                  current: String(current),
                  total: String(total),
                }),
                translationKey: key,
                translationParams: {
                  current: String(current),
                  total: String(total),
                },
                drawingProgressPhase: 'processing',
                drawingProgressCurrent: current,
                drawingProgressTotal: total,
              }
            : m,
        ));
      };

      const result = await processGifToDesmosAnimation(file, {
        mode,
        quality,
        apiKey: customApiKey,
        enableAiRepair: true,
        signal: task.signal,
        calculator: calculatorRef.current ?? undefined,
        streamToCalculator: true,
        onProgress: (current, total, phase) => {
          pendingGifProgress = { current, total, phase };
          if (gifProgressRaf) return;
          gifProgressRaf = requestAnimationFrame(() => {
            gifProgressRaf = 0;
            flushGifProgress();
          });
        },
      });
      flushGifProgress();

      const streamed = Boolean(result.streamed);
      let injectPartial = false;

      if (!streamed && calculatorRef.current && result.expressions.length > 0) {
        let injectProgressRaf = 0;
        let pendingInject: { done: number; total: number } | null = null;

        const injectResult = await applyGifExpressionsToCalculator(
          calculatorRef.current,
          result.expressions,
          {
            commitPartialOnAbort: true,
            onProgress: (done, total) => {
              pendingInject = { done, total };
              if (injectProgressRaf) return;
              injectProgressRaf = requestAnimationFrame(() => {
                injectProgressRaf = 0;
                if (!pendingInject) return;
                const { done: d, total: tot } = pendingInject;
                pendingInject = null;
                setMessages(prev => prev.map(m =>
                  m.id === progressMsgId
                    ? {
                        ...m,
                        content: t('gif_drawing_inject', {
                          current: String(d),
                          total: String(tot),
                        }),
                        translationKey: 'gif_drawing_inject',
                        translationParams: {
                          current: String(d),
                          total: String(tot),
                        },
                        drawingProgressCurrent: d,
                        drawingProgressTotal: tot,
                      }
                    : m,
                ));
              });
            },
          },
        );
        injectPartial = injectResult.partial;
      }

      if (streamed || result.expressions.length > 0) {
        const partialDeliver = result.partial || injectPartial;
        setMessages(prev => prev.map(m =>
          m.id === progressMsgId ? {
            ...m,
            content: partialDeliver ? 'GIF partial' : 'GIF complete',
            translationKey: partialDeliver ? 'gif_drawing_partial_complete' : 'gif_drawing_complete',
            translationParams: partialDeliver ? {
              current: String(result.completedFrames),
              total: String(result.totalFrames),
            } : undefined,
            drawingProgressPhase: undefined,
            drawingProgressCurrent: undefined,
            drawingProgressTotal: undefined,
          } : m,
        ));
      }
    } catch (error) {
      if (isAbortError(error)) {
        setMessages(prev => prev.map(m =>
          m.id === progressMsgId ? {
            ...m,
            content: 'Task cancelled',
            translationKey: 'task_cancelled',
            drawingProgressPhase: undefined,
            drawingProgressCurrent: undefined,
            drawingProgressTotal: undefined,
          } : m,
        ));
        return;
      }
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        role: 'system',
        content: 'GIF processing failed',
        translationKey: 'gif_process_fail',
      }]);
      console.error('[GIF] processing failed:', error);
    } finally {
      endTask();
      setIsLoading(false);
      flushWorkspace();
    }
  };

  const processFile = async (
    file: File,
    mode: SmartDrawMode = 'both',
    quality: GifQualityTier = gifQualityRef.current,
  ) => {
    if (isGifFile(file)) {
      await processGifFile(file, mode, quality);
      return;
    }
    // URL.createObjectURL 为文件创建一个临时本地 URL（blob:// 开头）
    // 可以直接用在 <img src={...}> 中显示图片，无需上传服务器
    const imageUrl = URL.createObjectURL(file);
    
    const userMsg: Message = { 
        id: Date.now().toString(), 
        role: 'user', 
        content: `[${t('upload_image')}: ${file.name}]`,
        hasImage: true,
        imageUrl: imageUrl
    };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);
    const task = beginTask();

    const progressMsgId = (Date.now() + 1).toString();

    try {
        setMessages(prev => [...prev, {
            id: progressMsgId,
            role: 'assistant',
            content: t('drawing_processing'),
            translationKey: 'drawing_processing',
            drawingProgressPhase: 'processing',
        }]);

        const result = await processImageToFourier(file, {
            mode,
            apiKey: customApiKey,
            enableAiRepair: true,
            onRepairProgress: (phase) => {
                const key = phase === 'ai_analyze' ? 'drawing_ai_repair' : 'drawing_local_repair';
                setMessages(prev => prev.map(m =>
                    m.id === progressMsgId
                        ? { ...m, content: t(key), translationKey: key }
                        : m
                ));
            },
        });
        const { expressions } = result;

        if (calculatorRef.current && expressions.length > 0) {
            await revealDrawingProgress(
              expressions,
              progressMsgId,
              task.signal.aborted ? undefined : task.signal,
            );
        }

        if (task.signal.aborted) {
          if (expressions.length > 0) {
            setMessages(prev => prev.map(m =>
              m.id === progressMsgId ? {
                ...m,
                content: 'Drawing partial',
                translationKey: 'drawing_partial_complete',
                drawingProgressPhase: undefined,
                drawingProgressCurrent: undefined,
                drawingProgressTotal: undefined,
              } : m,
            ));
          }
          return;
        }

        setMessages(prev => prev.map(m =>
            m.id === progressMsgId ? {
                ...m,
                content: 'Drawing complete',
                translationKey: 'drawing_complete',
                drawingProgressPhase: undefined,
                drawingProgressCurrent: undefined,
                drawingProgressTotal: undefined,
            } : m
        ));

    } catch (error) {
        if (isAbortError(error)) return;
        setMessages(prev => [...prev, {
            id: Date.now().toString(), 
            role: 'system', 
            content: 'Image processing failed',
            translationKey: 'image_process_fail'
        }]);
    } finally {
        endTask();
        setIsLoading(false);
        flushWorkspace();
    }
  };

  /**
   * handleFileUpload — 处理文件选择器的 onChange 事件
   *
   * 当用户通过文件选择器选择了图片后触发。
   * 根据当前的 uploadModeRef 决定处理方式：
   * - 'draw'  → 直接调用 processFile 进行傅里叶绘图
   * - 'solve' → 先把文件暂存，显示解题风格选择弹窗
   *
   * e.target.value = '' 清空 input 的值，确保下次选同一文件也能触发 onChange
   */
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; // 取用户选择的第一个文件（可能没有）
    if (!file) return;                 // 没有文件（用户取消了选择），直接返回

    if (uploadModeRef.current === 'solve') {
      // 解题模式：先保存文件，显示解题风格选择面板
      setPendingFile(file);
      setShowSolveOptions(true);
    } else {
      if (isGifFile(file)) {
        pendingGifFileRef.current = { file, mode: drawModeRef.current };
        setShowGifQualitySheet(true);
      } else {
        await processFile(file, drawModeRef.current);
      }
    }

    e.target.value = ''; // 清空文件输入，允许再次选择同一文件
  };

  /** 解题核心函数：图片 → OCR 识别 → AI 流式解答 */
  const solveWithFile = async (
    file: File,
    solveMode: 'hint' | 'answer' | 'full',
    extraContext?: string,
  ) => {
    const userContent = extraContext
      ? `[${t('uploading_problem')}: ${file.name}]\n${extraContext}`
      : `[${t('uploading_problem')}: ${file.name}]`;

    const requestLang = detectReplyLanguage(userContent);

    // Create preview URL for the uploaded image
    const imageUrl = URL.createObjectURL(file);

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: userContent,
      hasImage: true,
      imageUrl: imageUrl,
    };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);

    const aiMsgId = (Date.now() + Math.random()).toString();
    setMessages(prev => [...prev, { id: aiMsgId, role: 'assistant', content: '' }]);

    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (evt) => resolve(evt.target?.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      // ── Trial mode gate ──────────────────────────────────────────────────
      if (!hasCustomKey && !isInviteUnlocked) {
        if (trialCallCount >= TRIAL_LIMIT) {
          setMessages(prev => prev.filter(m => m.id !== aiMsgId));
          setShowTrialLimit(true);
          return;
        }
        const next = trialCallCount + 1;
        setTrialCallCount(next);
        localStorage.setItem('desmos_trial_calls', String(next));
      }
      // ────────────────────────────────────────────────────────────────────

      let fullContent = '';
      const desmosState = createDesmosInjectState();
      await callDeepSeekSolveStream(
        dataUrl,
        solveMode,
        (chunk) => {
          fullContent += chunk;
          const displayContent = processDesmosStreamChunk(
            fullContent,
            calculatorRef.current,
            desmosState,
          );
          setMessages(prev => prev.map(m =>
            m.id === aiMsgId ? { ...m, content: displayContent, rawContent: fullContent } : m
          ));
        },
        customApiKey,
        requestLang,
        // onProgress: show OCR / analyzing stage in placeholder bubble
        (stage) => {
          const stageMsg = stage === 'ocr' ? t('ocr_recognizing') : t('ocr_analyzing');
          setMessages(prev => prev.map(m =>
            m.id === aiMsgId ? { ...m, content: stageMsg } : m
          ));
        }
      );

    } catch (error: any) {
      let errorContent = t('solve_fail');
      const msg = error.message || '';
      if (msg.includes('OCREmpty')) {
        errorContent = t('ocr_empty');
      } else if (msg.includes('OCR')) {
        errorContent = t('ocr_fail');
      } else if (msg.includes('Insufficient Balance') || msg.includes('API Quota Exceeded')) {
        errorContent = t('err_balance');
      } else if (msg.includes('Unauthorized')) {
        errorContent = t('err_key');
      } else if (msg.includes('NetworkError') || msg.includes('Failed to fetch')) {
        errorContent = t('err_network');
      }
      setMessages(prev => prev.map(m =>
        m.id === aiMsgId ? { ...m, content: errorContent } : m
      ));
    } finally {
      setIsLoading(false);
    }
  };

  /** 文件选择器触发的解题流程 */
  const handleSolveProblem = async (solveMode: 'hint' | 'answer' | 'full') => {
    if (!pendingFile) return;
    setShowSolveOptions(false);
    const file = pendingFile;
    setPendingFile(null);
    await solveWithFile(file, solveMode);
  };

  /** 打开智能绘图模式选择（粘贴图片路径） */
  const openDrawModeSheetForPaste = (file: File) => {
    pendingDrawFileRef.current = file;
    openDrawModeSheet(file.name, isGifFile(file));
  };

  const startGifWithQuality = async (quality: GifQualityTier) => {
    gifQualityRef.current = quality;
    setGifQualityTier(quality);
    setShowGifQualitySheet(false);

    const pending = pendingGifFileRef.current;
    if (pending) {
      pendingGifFileRef.current = null;
      await processGifFile(pending.file, pending.mode, quality);
    }
  };

  const handleGifQualitySelect = (quality: GifQualityTier) => {
    void startGifWithQuality(quality);
  };

  /** 用户选定绘图模式后：Emoji / 文件 / 打开文件选择器 */
  const handleDrawModeSelect = async (mode: SmartDrawMode) => {
    drawModeRef.current = mode;
    setShowDrawModeSheet(false);
    setDrawModeSheetSubtitle(null);

    const pendingEmoji = pendingEmojiDrawRef.current;
    if (pendingEmoji) {
      pendingEmojiDrawRef.current = null;
      setIsLoading(true);
      const task = beginTask();
      try {
        await executeEmojiDraw(pendingEmoji.emoji, mode, task.signal);
      } catch (error) {
        if (isAbortError(error)) return;
        console.error('Emoji processing error', error);
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          role: 'assistant',
          content: 'Failed',
          translationKey: 'emoji_fail',
        }]);
      } finally {
        endTask();
        setIsLoading(false);
      }
      return;
    }

    const pendingFile = pendingDrawFileRef.current;
    if (pendingFile) {
      pendingDrawFileRef.current = null;
      await processFile(pendingFile, mode, gifQualityRef.current);
      return;
    }

    drawFileRef.current?.click();
  };

  /** 粘贴图片操作面板的回调（支持绘图或解题） */
  const handlePasteAction = async (action: 'draw' | 'hint' | 'answer' | 'full') => {
    if (!pastedFile) return;
    setShowPasteSheet(false);
    const file = pastedFile;
    const ctx = input.trim();
    // clear pasted state + input
    if (pastedPreview) URL.revokeObjectURL(pastedPreview);
    setPastedFile(null);
    setPastedPreview(null);
    if (ctx) setInput('');

    if (action === 'draw') {
      openDrawModeSheetForPaste(file);
    } else {
      await solveWithFile(file, action, ctx || undefined);
    }
  };

  /** 拦截 Ctrl+V 粘贴的图片，显示为输入框内的预览缩略图 */
  const interceptImagePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          // revoke previous preview
          if (pastedPreview) URL.revokeObjectURL(pastedPreview);
          const url = URL.createObjectURL(file);
          setPastedFile(file);
          setPastedPreview(url);
          return;
        }
      }
    }
  };

  /**
   * renderMessageContent — 渲染消息的文字内容
   *
   * 【为什么要有这个函数？】
   * 有两类消息：
   *   1. 有 translationKey 的消息：内容随语言切换而变化
   *      例如："画板已清空" / "Canvas cleared"
   *   2. 没有 translationKey 的消息：直接用 content 字段
   *      例如：用户输入的消息、AI 的 Markdown 回复
   *
   * 优先检查 translationKey，存在就用 t() 翻译，不存在就直接返回 content。
   *
   * @param msg - 要渲染的消息对象
   * @returns 当前语言下的消息文字内容
   */
  const renderMessageContent = (msg: Message) => {
    if (msg.translationKey) {
      // 有翻译键：用 t() 函数翻译（支持 {param} 占位符替换）
      return t(msg.translationKey, msg.translationParams);
    }
    // 没有翻译键：直接返回原始内容（用户消息、AI 回复等）
    return msg.content;
  };

  return (
    <div className="flex flex-col h-full w-full min-w-0 bg-white font-sans relative">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between px-3 py-2 border-b border-gray-100 bg-white/80 backdrop-blur-md sticky top-0 z-10 shrink-0 gap-x-2 gap-y-1">
            <div className="flex items-center gap-2 text-gray-800 shrink-0 flex-wrap">
            <span className="font-bold text-lg tracking-tight whitespace-nowrap">{t('title')}</span>
            <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 text-[10px] font-bold tracking-wider uppercase">{t('beta')}</span>
            {/* Long-hand mode badge */}
            {apiProvider === 'claude' && claudeLongHand && (
                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 text-violet-600 border border-violet-200 text-[10px] font-bold animate-pulse">
                    <MousePointer2 size={9} />
                    {t('claude_long_hand_badge')}
                </span>
            )}
            {/* Trial mode badge — only when no custom key and not using Claude */}
            {apiProvider !== 'claude' && !hasCustomKey && (
                isInviteUnlocked ? (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border bg-green-50 text-green-600 border-green-200">
                        <ShieldCheck size={9} />&nbsp;{t('invite_code_unlocked')}
                    </span>
                ) : (
                    <button
                        onClick={() => trialCallCount >= TRIAL_LIMIT ? setShowTrialLimit(true) : setShowSettings(true)}
                        title={trialCallCount >= TRIAL_LIMIT ? t('trial_limit_title') : undefined}
                        className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border transition-colors ${
                            trialCallCount >= TRIAL_LIMIT
                            ? 'bg-red-50 text-red-500 border-red-200 animate-pulse'
                            : 'bg-amber-50 text-amber-600 border-amber-200 hover:bg-amber-100'
                        }`}
                    >
                        {trialCallCount >= TRIAL_LIMIT
                            ? <><Lock size={9} />&nbsp;{t('trial_exhausted')}</>
                            : <><Zap size={9} fill="currentColor" />&nbsp;{t('trial_badge', { used: String(trialCallCount), limit: String(TRIAL_LIMIT) })}</>
                        }
                    </button>
                )
            )}
            </div>
            
            <div className="flex items-center flex-wrap gap-0.5">
                <button onClick={handleAnalyzeGraph} className="p-1.5 text-blue-500 hover:bg-blue-50 rounded-lg transition-colors" title={t('analyze_canvas')}>
                    <ScanEye size={17} />
                </button>
                <button onClick={handleExport} className="p-1.5 text-green-500 hover:bg-green-50 rounded-lg transition-colors" title={t('export_to_desmos')}>
                    <Share size={17} />
                </button>
                <button onClick={handleClearCanvas} className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg transition-colors" title={t('clear_canvas')}>
                    <Trash2 size={17} />
                </button>
                <button onClick={handleClearHistory} className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors" title={t('clear_history')}>
                    <MessageSquareX size={17} />
                </button>
                <button onClick={() => setShowSettings(true)} className="p-1.5 text-orange-500 hover:bg-orange-50 rounded-lg transition-colors" title={t('api_settings')}>
                    <Settings size={17} />
                </button>
                <button onClick={() => setShowHelp(true)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title={t('help')}>
                    <BookOpen size={17} />
                </button>
                {onClose && (
                    <button onClick={onClose} className="p-1.5 hover:bg-gray-100 hover:text-gray-900 rounded-lg transition-colors ml-0.5">
                        <X size={18} />
                    </button>
                )}
            </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-4" onPaste={interceptImagePaste} ref={messagesContainerRef}>
            {messages.map((msg, idx) => {
            const messageTime = getMessageTimestamp(msg);
            return (
            <div key={msg.id}>
                {idx > 0 && <div className="border-t border-gray-100 my-1" />}
                <div 
                    className={`flex gap-3 py-4 ${idx === 0 ? '' : 'animate-in fade-in slide-in-from-bottom-2 duration-300'}`}
                >
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                        msg.role === 'user' 
                        ? 'bg-gray-100 text-gray-500 border border-gray-200' 
                        : 'bg-blue-50 text-blue-600 border border-blue-100'
                    }`}>
                        {msg.role === 'user' ? <User size={18} /> : <Bot size={18} />}
                    </div>

                    <div className="flex-1 min-w-0 space-y-1.5">
                        {/* Name Label + Timestamp */}
                        <div className="flex items-baseline justify-between gap-2">
                            <div className="text-sm text-gray-900" style={{ fontWeight: 600 }}>
                                {msg.role === 'user' ? 'You' : 'AI Desmos'}
                            </div>
                            {messageTime != null && (
                                <time
                                    dateTime={new Date(messageTime).toISOString()}
                                    className="text-[10px] text-gray-400 shrink-0 tabular-nums"
                                >
                                    {formatMessageTime(messageTime, language)}
                                </time>
                            )}
                        </div>

                        <div className="text-sm text-gray-700 leading-relaxed">
                            {/* Render Image if exists */}
                            {msg.hasImage && msg.imageUrl && (
                                <div className="mb-3 rounded-lg overflow-hidden border border-gray-200 shadow-sm">
                                    <img 
                                        src={msg.imageUrl} 
                                        alt="Uploaded image" 
                                        className="w-full h-auto max-h-[300px] object-contain bg-gray-50"
                                    />
                                </div>
                            )}
                            {msg.hasImage && !msg.imageUrl && (
                                <div className="mb-2 p-2 bg-gray-50 rounded-lg border border-gray-100 flex items-center gap-2 text-xs text-gray-500">
                                    <Layers size={14} /> {t('image_uploaded')}
                                </div>
                            )}

                            {/* Render Text Content with LaTeX support */}
                            <div className="prose prose-sm max-w-none">
                                {msg.drawingProgressPhase ? (
                                  <div className="flex items-center gap-2.5 not-prose">
                                    <Loader2 size={15} className="animate-spin text-blue-500 shrink-0" />
                                    <div className="min-w-0 flex-1">
                                      <p className="text-sm text-gray-700 m-0">
                                        {renderMessageContent(msg)}
                                      </p>
                                      {msg.drawingProgressTotal && msg.drawingProgressTotal > 0 ? (
                                        <div className="mt-2 h-1.5 w-full max-w-[220px] rounded-full bg-gray-200 overflow-hidden">
                                          <div
                                            className="h-full rounded-full bg-blue-500 transition-[width] duration-200 ease-out"
                                            style={{
                                              width: `${Math.min(100, Math.round(((msg.drawingProgressCurrent ?? 0) / msg.drawingProgressTotal) * 100))}%`,
                                            }}
                                          />
                                        </div>
                                      ) : (
                                        <div className="mt-2 h-1.5 w-full max-w-[220px] rounded-full bg-gray-200 overflow-hidden relative">
                                          <div
                                            className="absolute inset-y-0 w-2/5 rounded-full bg-blue-500"
                                            style={{ animation: 'drawProgressSlide 1.15s ease-in-out infinite' }}
                                          />
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                ) : (
                                  <ChatMessageContent text={renderMessageContent(msg)} />
                                )}
                            </div>
                        </div>

                        {/* Status/Timestamp (Optional) */}
                        {msg.role === 'assistant' && idx === messages.length - 1 && isLoading && (
                            <div className="flex items-center gap-2 text-xs text-gray-400 mt-1">
                                <Loader2 size={12} className="animate-spin" />
                                Thinking...
                            </div>
                        )}
                    </div>
                </div>
            </div>
            );
            })}
            <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="px-4 pb-3 pt-2 bg-white shrink-0" onPaste={interceptImagePaste}>

            {/* Pasted image preview strip */}
            {pastedPreview && (
                <div className="mb-2 flex items-center gap-2 pl-1">
                    <div className="relative inline-block group">
                        <img
                            src={pastedPreview}
                            alt="pasted"
                            className="h-16 w-auto max-w-[120px] rounded-xl border border-gray-200 object-cover shadow-sm"
                        />
                        <button
                            onClick={() => {
                                URL.revokeObjectURL(pastedPreview);
                                setPastedPreview(null);
                                setPastedFile(null);
                            }}
                            className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-700 text-white rounded-full flex items-center justify-center hover:bg-red-500 transition-colors shadow"
                            title="移除图片"
                        >
                            <X size={11} />
                        </button>
                    </div>
                    <p className="text-[11px] text-gray-400 leading-tight">
                        {pastedFile?.name || 'image'}<br />
                        <span className="text-blue-500">{t('upload_menu_title')} →</span>
                    </p>
                </div>
            )}

            <div className="relative border border-gray-200 rounded-full bg-gray-50 flex items-center">
                {/* Paperclip — opens mode-selection popover */}
                <div className="relative shrink-0">
                    <button 
                        onClick={() => setShowUploadMenu(prev => !prev)}
                        className={`p-2.5 ml-1 rounded-full transition-colors ${showUploadMenu ? 'text-blue-600 bg-blue-50' : 'text-gray-400 hover:text-gray-600'}`}
                        title={t('upload_hint')}
                    >
                        <Paperclip size={18} />
                    </button>

                    {/* Upload mode popover */}
                    {showUploadMenu && (
                        <div className="absolute bottom-full left-0 mb-2 w-58 bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden z-50 animate-in fade-in slide-in-from-bottom-2 duration-150" style={{minWidth:'220px'}}>
                            <div className="px-3 pt-3 pb-1.5">
                                <p className="text-[10px] text-gray-400 uppercase tracking-wider">{t('upload_menu_title')}</p>
                            </div>
                            {/* Drawing mode */}
                            <button
                                onClick={() => {
                                    uploadModeRef.current = 'draw';
                                    setShowUploadMenu(false);
                                    pendingDrawFileRef.current = null;
                                    openDrawModeSheet(null);
                                }}
                                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-blue-50 transition-colors text-left"
                            >
                                <span className="w-8 h-8 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center shrink-0">
                                    <Pencil size={15} />
                                </span>
                                <div className="min-w-0">
                                    <p className="text-sm text-gray-800" style={{fontWeight:600}}>{t('mode_draw')}</p>
                                    <p className="text-[11px] text-gray-400 truncate">{t('mode_draw_desc')}</p>
                                </div>
                            </button>
                            {/* Solve mode */}
                            <button
                                onClick={() => {
                                    uploadModeRef.current = 'solve';
                                    setShowUploadMenu(false);
                                    solveFileRef.current?.click();
                                }}
                                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-purple-50 transition-colors text-left"
                            >
                                <span className="w-8 h-8 rounded-xl bg-purple-100 text-purple-600 flex items-center justify-center shrink-0">
                                    <GraduationCap size={15} />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm text-gray-800" style={{fontWeight:600}}>{t('mode_solve')}</p>
                                    <p className="text-[11px] text-gray-400 truncate">{t('mode_solve_desc')}</p>
                                </div>
                            </button>
                            <div className="h-2" />
                        </div>
                    )}
                </div>
                
                {/* Textarea — IME-safe: onChange is always the single source of truth.
                    isComposingRef guards only the Enter key; it must NOT block onChange,
                    because skipping setInput on a controlled input causes React to revert
                    the DOM value immediately, swallowing every keystroke in composition. */}
                <textarea
                    data-app-input
                    value={input}
                    onCompositionStart={() => { isComposingRef.current = true; }}
                    onCompositionEnd={() => { isComposingRef.current = false; }}
                    onChange={(e) => { setInput(e.target.value); }}
                    onPaste={interceptImagePaste}
                    onKeyDown={(e) => {
                        // Block Enter during IME composition (e.g. confirming Chinese characters)
                        if (e.key === 'Enter' && !e.shiftKey && !isComposingRef.current) {
                            e.preventDefault();
                            if (pastedFile) { setShowPasteSheet(true); }
                            else { handleSendMessage(); }
                        }
                    }}
                    onClick={() => setShowUploadMenu(false)}
                    placeholder={t('input_placeholder')}
                    className="flex-1 bg-transparent border-0 py-3 px-1 focus:ring-0 focus:outline-none resize-none text-sm text-gray-700 placeholder-gray-400 overflow-hidden"
                    rows={1}
                    style={{ height: '44px' }}
                />

                {/* Hidden file inputs — broad format support */}
                <input type="file" ref={drawFileRef}  className="hidden"
                    accept="image/png,image/jpeg,image/jpg,image/gif,image/webp,image/bmp,image/tiff,image/avif,image/heic,image/heif"
                    onChange={handleFileUpload} />
                <input type="file" ref={solveFileRef} className="hidden"
                    accept="image/png,image/jpeg,image/jpg,image/gif,image/webp,image/bmp,image/tiff,image/avif,image/heic,image/heif"
                    onChange={handleFileUpload} />

                {/* Stop / Send */}
                {isLoading ? (
                <button
                    type="button"
                    onClick={handleCancelTask}
                    className="p-2.5 mr-1 rounded-full transition-all shrink-0 text-red-600 hover:bg-red-50 active:scale-95"
                    title={t('task_cancel')}
                >
                    <Square size={18} fill="currentColor" />
                </button>
                ) : (
                <button
                    onClick={() => {
                        setShowUploadMenu(false);
                        if (pastedFile) { setShowPasteSheet(true); }
                        else { handleSendMessage(); }
                    }}
                    disabled={!input.trim() && !pastedFile}
                    className={`p-2.5 mr-1 rounded-full transition-all shrink-0 ${
                        (input.trim() || pastedFile)
                        ? 'text-blue-600 hover:bg-blue-50 active:scale-95'
                        : 'text-gray-300 cursor-not-allowed'
                    }`}
                >
                    <Send size={18} />
                </button>
                )}
            </div>
            <p className="text-[10px] text-gray-400 text-center mt-1">{t('copyright')}</p>
        </div>

        {/* Click-away backdrop for upload menu */}
        {showUploadMenu && (
            <div className="fixed inset-0 z-40" onClick={() => setShowUploadMenu(false)} />
        )}

        {/* Draw Mode Bottom Sheet */}
        {showDrawModeSheet && (
            <div className="absolute inset-0 z-50 bg-black/30 flex items-end justify-center animate-in fade-in duration-150">
                <div className="w-full bg-white rounded-t-3xl p-5 pb-8 shadow-2xl animate-in slide-in-from-bottom-4 duration-200">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h3 className="text-gray-900" style={{fontWeight:700, fontSize:'1rem'}}>{t('smart_draw_mode_title')}</h3>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {drawModeSheetSubtitle || t('mode_draw')}
                            </p>
                        </div>
                        <button
                            onClick={closeDrawModeSheet}
                            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                        >
                            <X size={20} />
                        </button>
                    </div>
                    <div className="space-y-2">
                        {([
                            {
                                mode: 'outline' as const,
                                label: t('smart_draw_mode_outline'),
                                desc: t('smart_draw_mode_outline_desc'),
                                cls: 'bg-slate-50 hover:bg-slate-100 border border-slate-100',
                                icon: <Pencil size={16} className="text-slate-600" />,
                            },
                            {
                                mode: 'fill' as const,
                                label: t('smart_draw_mode_fill'),
                                desc: t('smart_draw_mode_fill_desc'),
                                cls: 'bg-emerald-50 hover:bg-emerald-100 border border-emerald-100',
                                icon: <Layers size={16} className="text-emerald-600" />,
                            },
                            {
                                mode: 'both' as const,
                                label: t('smart_draw_mode_both'),
                                desc: t('smart_draw_mode_both_desc'),
                                cls: 'bg-blue-50 hover:bg-blue-100 border border-blue-100',
                                icon: <Pen size={16} className="text-blue-600" />,
                            },
                        ]).map(opt => (
                            <button
                                key={opt.mode}
                                onClick={() => handleDrawModeSelect(opt.mode)}
                                className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl transition-colors text-left ${opt.cls}`}
                            >
                                <span className="shrink-0">{opt.icon}</span>
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm text-gray-800" style={{fontWeight:600}}>{opt.label}</p>
                                    <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                                </div>
                                <ChevronRight size={15} className="text-gray-300 shrink-0" />
                            </button>
                        ))}
                    </div>
                    {drawModeSheetIsGif && (
                      <div className="mt-4 pt-4 border-t border-gray-100">
                        <p className="text-xs text-gray-500 mb-2" style={{ fontWeight: 600 }}>
                          {t('gif_quality_title')}
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          {([
                            {
                              tier: 'standard' as const,
                              label: t('gif_quality_standard'),
                              desc: t('gif_quality_standard_desc'),
                              icon: <Zap size={15} className="text-amber-600" />,
                              cls: gifQualityTier === 'standard'
                                ? 'ring-2 ring-amber-400 bg-amber-50'
                                : 'bg-gray-50 hover:bg-gray-100',
                            },
                            {
                              tier: 'cinema' as const,
                              label: t('gif_quality_cinema'),
                              desc: t('gif_quality_cinema_desc'),
                              icon: <Film size={15} className="text-violet-600" />,
                              cls: gifQualityTier === 'cinema'
                                ? 'ring-2 ring-violet-400 bg-violet-50'
                                : 'bg-gray-50 hover:bg-gray-100',
                            },
                          ]).map(opt => (
                            <button
                              key={opt.tier}
                              type="button"
                              onClick={() => {
                                setGifQualityTier(opt.tier);
                                gifQualityRef.current = opt.tier;
                              }}
                              className={`rounded-2xl p-3 text-left transition-all border border-transparent ${opt.cls}`}
                            >
                              <div className="flex items-center gap-1.5 mb-1">
                                {opt.icon}
                                <span className="text-sm text-gray-800" style={{ fontWeight: 600 }}>
                                  {opt.label}
                                </span>
                              </div>
                              <p className="text-[10px] text-gray-500 leading-snug">{opt.desc}</p>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                </div>
            </div>
        )}

        {/* GIF Quality Sheet (file picker path) */}
        {showGifQualitySheet && (
            <div className="absolute inset-0 z-50 bg-black/30 flex items-end justify-center animate-in fade-in duration-150">
                <div className="w-full bg-white rounded-t-3xl p-5 pb-8 shadow-2xl animate-in slide-in-from-bottom-4 duration-200">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h3 className="text-gray-900" style={{fontWeight:700, fontSize:'1rem'}}>{t('gif_quality_title')}</h3>
                            {pendingGifFileRef.current && (
                              <p className="text-xs text-gray-400 mt-0.5 truncate max-w-[240px]">
                                {pendingGifFileRef.current.file.name}
                              </p>
                            )}
                        </div>
                        <button
                            onClick={() => { setShowGifQualitySheet(false); pendingGifFileRef.current = null; }}
                            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                        >
                            <X size={20} />
                        </button>
                    </div>
                    <div className="space-y-2">
                        {([
                            {
                              tier: 'standard' as const,
                              label: t('gif_quality_standard'),
                              desc: t('gif_quality_standard_desc'),
                              cls: 'bg-amber-50 hover:bg-amber-100 border border-amber-100',
                              icon: <Zap size={16} className="text-amber-600" />,
                            },
                            {
                              tier: 'cinema' as const,
                              label: t('gif_quality_cinema'),
                              desc: t('gif_quality_cinema_desc'),
                              cls: 'bg-violet-50 hover:bg-violet-100 border border-violet-100',
                              icon: <Film size={16} className="text-violet-600" />,
                            },
                        ]).map(opt => (
                            <button
                                key={opt.tier}
                                onClick={() => handleGifQualitySelect(opt.tier)}
                                className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl transition-colors text-left ${opt.cls}`}
                            >
                                <span className="shrink-0">{opt.icon}</span>
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm text-gray-800" style={{fontWeight:600}}>{opt.label}</p>
                                    <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                                </div>
                                <ChevronRight size={15} className="text-gray-300 shrink-0" />
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        )}

        {/* Solve Options Bottom Sheet */}
        {showSolveOptions && (
            <div className="absolute inset-0 z-50 bg-black/30 flex items-end justify-center animate-in fade-in duration-150">
                <div className="w-full bg-white rounded-t-3xl p-5 pb-8 shadow-2xl animate-in slide-in-from-bottom-4 duration-200">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h3 className="text-gray-900" style={{fontWeight:700, fontSize:'1rem'}}>{t('solve_options_title')}</h3>
                            {pendingFile && <p className="text-xs text-gray-400 mt-0.5 truncate max-w-[200px]">{pendingFile.name}</p>}
                        </div>
                        <button onClick={() => { setShowSolveOptions(false); setPendingFile(null); }} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                            <X size={20} />
                        </button>
                    </div>
                    <div className="space-y-2">
                        {([
                            { mode: 'hint'   as const, label: t('solve_hint'),   desc: t('solve_hint_desc'),   cls: 'bg-blue-50   hover:bg-blue-100   border border-blue-100'   },
                            { mode: 'answer' as const, label: t('solve_answer'), desc: t('solve_answer_desc'), cls: 'bg-green-50  hover:bg-green-100  border border-green-100'  },
                            { mode: 'full'   as const, label: t('solve_full'),   desc: t('solve_full_desc'),   cls: 'bg-purple-50 hover:bg-purple-100 border border-purple-100' },
                        ]).map(opt => (
                            <button
                                key={opt.mode}
                                onClick={() => handleSolveProblem(opt.mode)}
                                className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl transition-colors text-left ${opt.cls}`}
                            >
                                <div className="min-w-0">
                                    <p className="text-sm text-gray-800" style={{fontWeight:600}}>{opt.label}</p>
                                    <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                                </div>
                                <ChevronRight size={16} className="text-gray-400 shrink-0" />
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        )}

        {/* Paste Action Sheet – shown when Ctrl+V image is present and user hits Send */}
        {showPasteSheet && (
            <div className="absolute inset-0 z-50 bg-black/30 flex items-end justify-center animate-in fade-in duration-150">
                <div className="w-full bg-white rounded-t-3xl p-5 pb-8 shadow-2xl animate-in slide-in-from-bottom-4 duration-200">
                    <div className="flex items-center justify-between mb-1">
                        <h3 className="text-gray-900" style={{fontWeight:700, fontSize:'1rem'}}>{t('upload_menu_title')}</h3>
                        <button
                            onClick={() => setShowPasteSheet(false)}
                            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                        >
                            <X size={20} />
                        </button>
                    </div>
                    {/* Thumbnail + filename */}
                    {pastedPreview && (
                        <div className="flex items-center gap-3 mb-4 p-2.5 bg-gray-50 rounded-xl border border-gray-100">
                            <img src={pastedPreview} className="h-12 w-auto max-w-[80px] rounded-lg object-cover" alt="" />
                            <p className="text-xs text-gray-500 truncate flex-1">{pastedFile?.name || 'image'}</p>
                        </div>
                    )}
                    <div className="space-y-2">
                        {([
                            {
                                action: 'draw' as const,
                                label: t('mode_draw'),
                                desc: t('mode_draw_desc'),
                                cls: 'bg-blue-50 hover:bg-blue-100 border border-blue-100',
                                icon: <Pencil size={16} className="text-blue-600" />,
                            },
                            {
                                action: 'hint' as const,
                                label: t('solve_hint'),
                                desc: t('solve_hint_desc'),
                                cls: 'bg-sky-50 hover:bg-sky-100 border border-sky-100',
                                icon: <span className="text-base">💡</span>,
                            },
                            {
                                action: 'answer' as const,
                                label: t('solve_answer'),
                                desc: t('solve_answer_desc'),
                                cls: 'bg-green-50 hover:bg-green-100 border border-green-100',
                                icon: <span className="text-base">✅</span>,
                            },
                            {
                                action: 'full' as const,
                                label: t('solve_full'),
                                desc: t('solve_full_desc'),
                                cls: 'bg-purple-50 hover:bg-purple-100 border border-purple-100',
                                icon: <span className="text-base">📝</span>,
                            },
                        ]).map(opt => (
                            <button
                                key={opt.action}
                                onClick={() => handlePasteAction(opt.action)}
                                className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl transition-colors text-left ${opt.cls}`}
                            >
                                <span className="shrink-0">{opt.icon}</span>
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm text-gray-800" style={{fontWeight:600}}>{opt.label}</p>
                                    <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                                </div>
                                <ChevronRight size={15} className="text-gray-300 shrink-0" />
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        )}

        {/* ── Trial Limit Modal ──────────────────────────────────────────── */}
        {showTrialLimit && (
            <div className="absolute inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-200">
                <div className="w-full max-w-xs bg-white rounded-3xl shadow-2xl p-7 flex flex-col items-center gap-1 animate-in zoom-in-95 duration-200">
                    {/* Icon */}
                    <div className="w-16 h-16 bg-amber-50 rounded-2xl flex items-center justify-center mb-3">
                        <Lock size={30} className="text-amber-500" />
                    </div>
                    {/* Title */}
                    <h3 className="text-gray-900 text-center mb-1" style={{ fontWeight: 700, fontSize: '1.05rem' }}>
                        {t('trial_limit_title')}
                    </h3>
                    {/* Used indicator */}
                    <div className="flex gap-2 my-2">
                        {Array.from({ length: TRIAL_LIMIT }).map((_, i) => (
                            <div key={i} className={`w-7 h-1.5 rounded-full ${i < trialCallCount ? 'bg-amber-400' : 'bg-gray-200'}`} />
                        ))}
                    </div>
                    {/* Description */}
                    <p className="text-sm text-gray-500 text-center leading-relaxed mt-1 mb-2">
                        {t('trial_limit_desc', { limit: String(TRIAL_LIMIT) })}
                    </p>
                    {/* Security note */}
                    <p className="text-xs text-gray-400 text-center flex items-center gap-1 mb-4">
                        <ShieldCheck size={11} className="text-green-500 shrink-0" />
                        {t('trial_limit_note')}
                    </p>
                    {/* CTA: open settings */}
                    <button
                        onClick={() => { setShowTrialLimit(false); setShowSettings(true); }}
                        className="w-full py-3 bg-gray-900 text-white rounded-xl font-bold hover:bg-black active:scale-95 transition-all text-sm mb-2"
                    >
                        {t('trial_setup_key')}
                    </button>
                    {/* CTA: get API key */}
                    <a
                        href="https://platform.deepseek.com/api_keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-blue-200 bg-blue-50 text-blue-600 text-sm font-medium hover:bg-blue-100 transition-colors mb-1"
                    >
                        <ExternalLink size={13} />
                        {t('trial_get_key')}
                    </a>

                    {/* ── Divider ── */}
                    <p className="text-[10px] text-gray-300 text-center py-1 tracking-widest">{t('invite_code_or')}</p>

                    {/* Invite code input */}
                    {inviteCodeStatus === 'success' ? (
                        <div className="w-full py-3 rounded-xl bg-green-50 border border-green-200 text-green-600 text-sm text-center font-medium">
                            {t('invite_code_success')}
                        </div>
                    ) : (
                        <div className="w-full min-w-0 space-y-2 @container">
                            <div className="flex flex-col @[220px]:flex-row gap-2 w-full min-w-0">
                                <input
                                    type="text"
                                    value={inviteCodeInput}
                                    onChange={e => { setInviteCodeInput(e.target.value); setInviteCodeStatus('idle'); }}
                                    onKeyDown={e => e.key === 'Enter' && handleRedeemInviteCode()}
                                    placeholder={t('invite_code_placeholder')}
                                    className={`w-full min-w-0 @[220px]:flex-1 px-3 py-2.5 rounded-xl border text-sm focus:outline-none focus:ring-2 transition-colors ${
                                        inviteCodeStatus === 'error'
                                        ? 'border-red-300 bg-red-50 focus:ring-red-200'
                                        : 'border-gray-200 bg-gray-50 focus:ring-blue-200'
                                    }`}
                                />
                                <button
                                    onClick={handleRedeemInviteCode}
                                    disabled={!inviteCodeInput.trim()}
                                    className="w-full @[220px]:w-auto px-4 py-2.5 bg-gray-800 text-white rounded-xl text-sm font-bold hover:bg-gray-900 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0 whitespace-nowrap"
                                >
                                    {t('invite_code_redeem')}
                                </button>
                            </div>
                            {inviteCodeStatus === 'error' && (
                                <p className="text-xs text-red-500 text-center animate-in fade-in duration-200">{t('invite_code_error')}</p>
                            )}
                        </div>
                    )}

                    {/* Dismiss */}
                    <button
                        onClick={() => setShowTrialLimit(false)}
                        className="w-full py-2 text-xs text-gray-400 hover:text-gray-600 transition-colors mt-1"
                    >
                        {t('trial_close')}
                    </button>
                </div>
            </div>
        )}

        {/* Modals - Absolute positioned within sidebar */}
        {showSettings && (
            <div className="absolute inset-0 z-40 bg-white/95 backdrop-blur-md overflow-y-auto overflow-x-hidden flex flex-col min-w-0 animate-in fade-in slide-in-from-bottom-4 duration-300">
                {/* Sticky Header */}
                <div className="sticky top-0 z-10 bg-white/90 backdrop-blur-md px-6 py-4 border-b border-gray-100 flex justify-between items-center">
                    <h3 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                        <Settings size={20} className="text-gray-500" /> {t('api_config')}
                    </h3>
                    <button onClick={() => setShowSettings(false)} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                        <X size={22} />
                    </button>
                </div>

                <div className="px-5 py-5 space-y-5 min-w-0">
                    {/* ── Language ── */}
                    <section className="space-y-2">
                        <p className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                            <Globe size={13} /> {t('lang_select')}
                        </p>
                        <div className="flex gap-2">
                            <button onClick={() => setLanguage('zh')} className={`flex-1 py-2 px-4 rounded-xl font-medium border transition-colors text-sm ${language === 'zh' ? 'bg-gray-900 border-gray-900 text-white' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                                中文
                            </button>
                            <button onClick={() => setLanguage('en')} className={`flex-1 py-2 px-4 rounded-xl font-medium border transition-colors text-sm ${language === 'en' ? 'bg-gray-900 border-gray-900 text-white' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                                English
                            </button>
                        </div>
                    </section>

                    <div className="border-t border-gray-100" />

                    {/* ── API Key + Auto-detect ── */}
                    <section className="space-y-4">
                        <div>
                            <p className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5 mb-1">
                                <Key size={13} /> {t('settings_key_label')}
                            </p>
                            <p className="text-xs text-gray-500 mb-3">{t('settings_provider_desc')}</p>
                            <input
                                type="password"
                                value={customApiKey}
                                onChange={(e) => handleApiKeyChange(e.target.value)}
                                placeholder={t('settings_key_placeholder')}
                                className="w-full px-4 py-3 bg-white border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-400 font-mono text-sm shadow-sm"
                            />
                            <p className="text-[11px] text-gray-400 flex items-center gap-1 mt-2">
                                <ShieldCheck size={11} className="text-green-500 shrink-0" /> {t('settings_key_note')}
                            </p>
                        </div>

                        {hasCustomKey && currentProviderConfig && (
                            <div className="rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 to-indigo-50 p-4 space-y-3">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <p className="text-[10px] uppercase tracking-wider text-blue-500 font-bold">{t('settings_detected')}</p>
                                        <p className="text-base font-bold text-gray-900 mt-0.5">
                                            {language === 'zh' ? currentProviderConfig.name : currentProviderConfig.nameEn}
                                        </p>
                                    </div>
                                    <a
                                        href={currentProviderConfig.docsUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[11px] font-semibold text-blue-600 hover:text-blue-800 flex items-center gap-0.5 shrink-0"
                                    >
                                        {t('tut_visit')} <ExternalLink size={10} />
                                    </a>
                                </div>
                                <div className="space-y-1.5">
                                    <p className="text-xs font-bold text-gray-600">{t('settings_model')}</p>
                                    <div className="flex gap-2 flex-wrap">
                                        {currentProviderConfig.models.map(m => (
                                            <button
                                                key={m}
                                                onClick={() => setApiModel(m)}
                                                className={`px-3 py-1.5 rounded-lg border text-xs font-mono font-medium transition-all ${
                                                    apiModel === m
                                                        ? 'bg-gray-900 border-gray-900 text-white'
                                                        : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                                                }`}
                                            >
                                                {m}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {!hasCustomKey && (
                            <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-500 leading-relaxed">
                                {t('settings_no_key_hint')}
                            </div>
                        )}
                    </section>

                    {apiProvider === 'claude' && hasCustomKey && (
                        <section className="rounded-2xl border overflow-hidden">
                            {/* Header row */}
                            <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-violet-50 to-purple-50 border-b border-violet-100">
                                <div className="flex items-center gap-2">
                                    <MousePointer2 size={16} className="text-violet-600" />
                                    <span className="text-sm font-bold text-violet-800">{t('claude_long_hand')}</span>
                                    <span className="px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-600 text-[9px] font-bold tracking-wide border border-amber-200">
                                        {t('claude_long_hand_cloud_note').split('·')[0].trim()}
                                    </span>
                                </div>
                                {/* Toggle */}
                                <button
                                    onClick={() => setClaudeLongHand(prev => !prev)}
                                    className={`relative w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${claudeLongHand ? 'bg-violet-600' : 'bg-gray-200'}`}
                                    aria-label="Toggle Long Hand"
                                >
                                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${claudeLongHand ? 'translate-x-5' : 'translate-x-0'}`} />
                                </button>
                            </div>
                            {/* Body */}
                            <div className="px-4 py-3 bg-white space-y-2">
                                <p className="text-xs text-gray-600 leading-relaxed">{t('claude_long_hand_desc')}</p>
                                {/* Sim-mode notice */}
                                <div className="flex items-start gap-2 p-2.5 bg-amber-50 border border-amber-100 rounded-xl">
                                    <CloudOff size={13} className="text-amber-500 shrink-0 mt-0.5" />
                                    <p className="text-[11px] text-amber-700 leading-snug">{t('claude_long_hand_sim_mode')}</p>
                                </div>
                                {/* Status pill */}
                                <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border transition-colors ${claudeLongHand ? 'bg-violet-50 text-violet-700 border-violet-200' : 'bg-gray-50 text-gray-400 border-gray-200'}`}>
                                    <span className={`w-1.5 h-1.5 rounded-full ${claudeLongHand ? 'bg-violet-500 animate-pulse' : 'bg-gray-300'}`} />
                                    {claudeLongHand ? t('claude_long_hand_on') : t('claude_long_hand_off')}
                                </div>
                            </div>
                        </section>
                    )}

                    {/* ── Save / Reset ── */}
                    <div className="flex gap-2 pt-1">
                        <button
                            onClick={handleSaveSettings}
                            className="flex-1 bg-gray-900 text-white py-3 rounded-xl font-bold shadow-lg hover:bg-black active:scale-95 transition-all text-sm"
                        >
                            {t('settings_save')}
                        </button>
                        <button
                            onClick={handleResetSettings}
                            className="px-4 py-3 text-gray-500 text-sm border border-gray-200 rounded-xl hover:bg-gray-50 hover:text-gray-700 transition-colors"
                        >
                            {t('settings_reset')}
                        </button>
                    </div>

                    <div className="border-t border-gray-100" />

                    {/* ── Invite Code ── */}
                    <section className={`@container p-4 rounded-xl border text-sm space-y-3 min-w-0 overflow-hidden ${isInviteUnlocked ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'}`}>
                        <p className={`font-bold flex items-center gap-2 ${isInviteUnlocked ? 'text-green-700' : 'text-gray-700'}`}>
                            <ShieldCheck size={15} className={isInviteUnlocked ? 'text-green-500' : 'text-gray-400'} />
                            {t('invite_code')}
                            {isInviteUnlocked && (
                                <span className="ml-auto px-2 py-0.5 bg-green-100 text-green-600 rounded-full text-[10px] font-bold">
                                    ✓ {t('invite_code_unlocked')}
                                </span>
                            )}
                        </p>
                        {isInviteUnlocked ? (
                            <p className="text-xs text-green-600">{t('invite_code_success')}</p>
                        ) : (
                            <>
                                <p className="text-xs text-gray-500">{t('invite_code_desc')}</p>
                                {inviteCodeStatus === 'success' ? (
                                    <p className="text-xs text-green-600 font-medium">{t('invite_code_success')}</p>
                                ) : (
                                    <div className="space-y-1.5 min-w-0">
                                        <div className="flex flex-col @[220px]:flex-row gap-2 w-full min-w-0">
                                            <input
                                                type="text"
                                                value={inviteCodeInput}
                                                onChange={e => { setInviteCodeInput(e.target.value); setInviteCodeStatus('idle'); }}
                                                onKeyDown={e => e.key === 'Enter' && handleRedeemInviteCode()}
                                                placeholder={t('invite_code_placeholder')}
                                                className={`w-full min-w-0 @[220px]:flex-1 px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 transition-colors bg-white ${
                                                    inviteCodeStatus === 'error'
                                                    ? 'border-red-300 focus:ring-red-200'
                                                    : 'border-gray-300 focus:ring-blue-200'
                                                }`}
                                            />
                                            <button
                                                onClick={handleRedeemInviteCode}
                                                disabled={!inviteCodeInput.trim()}
                                                className="w-full @[220px]:w-auto px-3 py-2 bg-gray-800 text-white rounded-lg text-sm font-bold hover:bg-black active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0 whitespace-nowrap"
                                            >
                                                {t('invite_code_redeem')}
                                            </button>
                                        </div>
                                        {inviteCodeStatus === 'error' && (
                                            <p className="text-xs text-red-500 animate-in fade-in duration-200">{t('invite_code_error')}</p>
                                        )}
                                    </div>
                                )}
                            </>
                        )}
                    </section>
                </div>
            </div>
        )}

        {showHelp && (
            <div 
                className="absolute inset-0 z-20 bg-white/95 backdrop-blur-md overflow-y-auto flex flex-col animate-in fade-in slide-in-from-bottom-4 duration-300"
            >
                    {/* Sticky Header */}
                    <div className="sticky top-0 z-10 bg-white/90 backdrop-blur-md px-6 py-4 border-b border-gray-100">
                        <div className="flex justify-between items-center">
                            <h3 className="text-xl font-bold text-gray-900">{t('user_guide')}</h3>
                            <button onClick={() => setShowHelp(false)} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                                <X size={22} />
                            </button>
                        </div>
                    </div>

                    <div className="px-6 py-6">
                        <UserGuideContent showFooter />
                    </div>
            </div>
        )}

        {showExport && (
            <div 
                className="absolute inset-0 z-30 bg-white/95 backdrop-blur-md p-6 flex flex-col animate-in fade-in zoom-in duration-300 overflow-y-auto"
            >
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="text-xl font-bold text-gray-900">{t('export_title')}</h3>
                        <button onClick={closeExportPanel} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                            <X size={24} />
                        </button>
                    </div>

                    {/* Why console section */}
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-3 text-sm text-amber-900">
                        <p className="font-bold flex items-center gap-2 mb-1">
                            <HelpCircle size={15} className="shrink-0" />
                            {t('why_no_link')}
                        </p>
                        <p className="text-xs text-amber-800 leading-relaxed">{t('why_no_link_desc')}</p>
                    </div>

                    {/* Step-by-step guide */}
                    <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-3 text-sm text-blue-900">
                        <p className="font-bold mb-2">{t('how_to_transfer')}</p>
                        <ol className="space-y-1.5 list-none p-0 m-0">
                            {([
                                { num: '1', key: 'step_copy' as const },
                                { num: '2', key: 'step_open' as const },
                                { num: '3', key: 'step_console' as const },
                                { num: '4', key: 'step_paste' as const },
                            ]).map(item => (
                                <li key={item.key} className="flex items-start gap-2 text-xs text-blue-800">
                                    <span className="w-5 h-5 rounded-full bg-blue-500 text-white flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-bold">{item.num}</span>
                                    {t(item.key)}
                                </li>
                            ))}
                        </ol>
                    </div>

                    {/* Script area */}
                    <p className="text-xs text-gray-500 mb-1.5">{t('export_guide')}</p>
                    <textarea 
                        className="flex-1 w-full p-4 bg-gray-50 border border-gray-200 rounded-xl font-mono text-xs text-gray-600 focus:ring-2 focus:ring-blue-500 focus:outline-none resize-none mb-4 min-h-[80px]"
                        readOnly
                        value={exportScript}
                    />
                    <button
                        onClick={handleCopyScript}
                        className={`w-full py-3 rounded-xl font-bold shadow-lg transition-all active:scale-95 flex items-center justify-center gap-2 shrink-0 ${
                            copyCodeSuccess
                                ? 'bg-green-700 text-white'
                                : 'bg-green-600 text-white hover:bg-green-700'
                        }`}
                    >
                        {copyCodeSuccess ? (
                            <>
                                <Check size={18} strokeWidth={2.5} />
                                {t('copy_code_success')}
                            </>
                        ) : (
                            t('copy_code')
                        )}
                    </button>
            </div>
        )}
    </div>
  );
};