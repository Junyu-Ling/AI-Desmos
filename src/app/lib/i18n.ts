/**
 * ============================================================================
 * lib/i18n.ts — 国际化（Internationalization）模块：中英双语支持
 * ============================================================================
 *
 * "i18n" 是 "internationalization" 的缩写（首尾字母 i 和 n 之间有 18 个字母）。
 *
 * 【这个文件做什么？】
 * 让整个应用同时支持中文和英文。
 * 每一段界面文字都有两个版本（中文 + 英文），
 * 用户切换语言时，所有界面文字同步更新，不需要刷新页面。
 *
 * 【核心机制】
 * 1. translations 对象：存储所有文字的两种语言版本
 * 2. useLanguage Hook：React 钩子，组件通过它获取翻译函数 t()
 * 3. t(key, params?) 函数：传入文字的"钥匙"，返回当前语言的对应文字
 * 4. localStorage：把用户的语言偏好永久保存在浏览器本地
 *
 * 【使用示例】
 * const { t } = useLanguage();
 * <button>{t('save_config')}</button>  // 中文时显示"保存配置"，英文时显示"Save Config"
 */

// 从 React 导入两个钩子函数
// useState：在组件中存储会变化的数据（状态）
// useEffect：在特定时机执行副作用操作（如读取 localStorage）
import { useState, useEffect } from 'react';

// ─── 类型定义 ────────────────────────────────────────────────────────────────

/**
 * Language 类型：只允许两个值之一
 * 'zh' = 中文（Chinese）
 * 'en' = 英文（English）
 * TypeScript 会检查代码中所有用到 Language 的地方，防止拼写错误
 */
export type Language = 'zh' | 'en';

// ─── 翻译词典 ────────────────────────────────────────────────────────────────

/**
 * translations 是一个"嵌套对象"（对象里面还有对象）：
 * 外层：语言代码（'zh' 或 'en'）
 * 内层：翻译键值对（key: 文字内容）
 *
 * 例如：translations.zh.title = 'AI Desmos'
 *        translations.en.title = 'AI Desmos'
 */
export const translations = {

  // ═══════════════════════════════════════════════════════════════════════════
  // 中文词典
  // ═══════════════════════════════════════════════════════════════════════════
  zh: {
    // ── 基础 UI ──────────────────────────────────────────────────────────────
    title: 'AI Desmos',                        // 应用标题（品牌名，中英文相同）
    subtitle: 'AI 数学创作平台',                 // 副标题
    beta: 'Beta',                              // Beta 版标志（中英文相同）
    analyze_canvas: '分析当前画板',              // 顶部工具栏：分析按钮文字
    explain_canvas: 'AI 教学解释',
    explain_prompt: '请用初学者能懂的方式，解释当前画板上所有图形的数学原理、建模思路和每个参数的作用。',
    export_to_desmos: '导出到官网',              // 顶部工具栏：导出按钮文字
    clear_canvas: '清空画板',                   // 顶部工具栏：清空画板按钮文字
    clear_history: '清除记录',                  // 顶部工具栏：清除聊天记录按钮文字
    api_settings: 'API 设置',                  // 设置按钮 tooltip
    help: '使用说明',                           // 帮助按钮文字

    // ── 数学创作工作室 ────────────────────────────────────────────────────────
    creativity_title: '数学创作工作室',
    creativity_subtitle: '想象 → 数学模型 → 交互可视化',
    creativity_templates: '数学艺术模板',
    creativity_params: '参数探索',
    creativity_color: '主色',
    creativity_explain: 'Explain 教学',
    creativity_ai_demo: 'AI 拱桥 Demo',

    tpl_bridge: '拱桥',
    tpl_bridge_desc: '抛物线拱形结构，可调跨度与高度',
    tpl_bridge_model: '模型：$y = -\\frac{4H}{W^2}x^2 + H$（抛物线拱）。抛物线将桥面荷载传向桥墩，是经典承重结构。',
    tpl_ferris: '摩天轮',
    tpl_ferris_desc: '圆形结构 + 辐条，展示周期与对称',
    tpl_ferris_model: '模型：$x^2+y^2=R^2$（圆）+ 参数曲线 $(R\\cos t, R\\sin t)$。圆是最均匀的旋转对称结构。',
    tpl_flower: '花朵',
    tpl_flower_desc: '极坐标玫瑰线，花瓣数量可调',
    tpl_flower_model: '模型：$r = a\\cos(n\\theta)$（玫瑰线）。$n$ 控制花瓣数，$a$ 控制大小。',
    tpl_logo: 'Logo',
    tpl_logo_desc: '参数方程心形曲线，适合品牌图形',
    tpl_logo_model: '模型：参数方程 $(16\\sin^3 t,\\; 13\\cos t - 5\\cos 2t - \\cdots)$。参数 $t$ 沿曲线扫过，$s$ 控制整体缩放。',
    tpl_stars: '星空',
    tpl_stars_desc: '背景 + 星点分布，可调密度',
    tpl_stars_model: '模型：背景不等式填色 + 离散点 $(x_i, y_i)$。用数学分布模拟星空密度。',

    tpl_param_span: '跨度 W',
    tpl_param_height: '高度 H',
    tpl_param_radius: '半径 R',
    tpl_param_size: '大小 a',
    tpl_param_petals: '花瓣数 n',
    tpl_param_scale: '缩放 s',
    tpl_param_star_count: '星数 N',
    tpl_param_spread: '范围 S',

    // ── 图片上传 ──────────────────────────────────────────────────────────────
    upload_image: '上传图片',                   // 上传图片按钮文字

    // ── API 配置 ──────────────────────────────────────────────────────────────
    api_config: 'API 配置',                    // 设置面板标题
    custom_key: '自定义 DeepSeek Key',          // 自定义 Key 输入框标题
    custom_key_desc: '如果您遇到余额不足或请求限制，可以输入您自己的 API Key。您的 Key 仅存储在本地浏览器中，不会被发送到任何第三方服务器。',
    save_config: '保存配置',                    // 保存按钮（旧版，已替换）
    restore_default: '恢复默认',                // 恢复默认按钮（旧版，已替换）

    // ── 使用指南 ──────────────────────────────────────────────────────────────
    user_guide: '使用指南',                     // 帮助面板标题
    guide_how: '怎么用',
    guide_example: '示例',
    guide_principle: '原理',

    // ── 工作原理说明 ──────────────────────────────────────────────────────────
    theory_title: '原理解析：这是怎么画出来的？',
    theory_desc: '智能绘图与图片拟合的核心，是把形状转化为 Desmos 能绘制的数学表达式。',
    theory_step1: '1. 提取形状：色块用颜色网格分区 + 洪水填充；轮廓用 Sobel 边缘检测追踪线稿。',
    theory_step2: '2. 数学拟合：可选多段三次贝塞尔，或对轮廓点做 DFT（离散傅里叶变换）求频率系数。',
    theory_step3: '3. 参数方程：组合成 X(t) 与 Y(t)（Desmos 参数方程只接受 t），用旋转向量叠加逐点绘制曲线。',

    // ── 智能绘图功能说明 ──────────────────────────────────────────────────────
    smart_draw: '自然语言绘图',
    smart_draw_desc: '像聊天一样描述想要的图形，AI 自动生成公式并绘制到画板上，支持多轮修改。',
    smart_draw_how: '在输入框用中文或英文描述图形，按 Enter 发送。可说「把上面的改成红色」等继续修改。',
    smart_draw_principle: 'AI 用 <DESMOS> 标签（仅后台注入，聊天里不显示标签）写入画板；蓝框内公式自动排版为 LaTeX。简略请求时优先通项与多参数说明。',
    smart_draw_tip1: '"画一个爱心"',              // 示例提示词 1
    smart_draw_tip2: '"画 y=sin(x) 和 y=cos(x)"', // 示例提示词 2
    smart_draw_tip3: '"把它变大一点" / "改成红色"',
    smart_draw_tip4: '"设计一座跨度30米的现代拱桥"',
    smart_draw_tip5: '"Explain 这个图形用了什么数学"',
    smart_draw_mode_title: '选择绘图方式',
    smart_draw_mode_outline: '仅轮廓',
    smart_draw_mode_outline_desc: 'Sobel 边缘检测勾线，可选黑白或彩色',
    fit_method_title: '轮廓拟合方式',
    fit_method_bezier: '一次函数 / 圆 / 贝塞尔',
    fit_method_bezier_desc: '直边用参数一次式，近圆用圆方程，弯段再用贝塞尔——公式更少、放大仍光滑',
    fit_method_fourier: '傅里叶变换',
    fit_method_fourier_desc: 'DFT 参数曲线 X(t)、Y(t)，适合频率分解与平滑封闭轮廓',
    fit_method_hint: '要可读公式与规则图形选「一次函数/圆/贝塞尔」；要谐波/旋转特效选傅里叶。',
    outline_style_title: '轮廓颜色',
    outline_style_mono: '黑白线稿',
    outline_style_mono_desc: '统一黑色轮廓',
    outline_style_color: '按原图取色',
    outline_style_color_desc: '沿边缘采样图片颜色',
    outline_style_hint: '「仅轮廓」默认按原图取色；「轮廓+涂色」固定黑线，填色负责颜色。',
    smart_draw_mode_fill: '仅涂色',
    smart_draw_mode_fill_desc: '只用色块还原颜色，不勾线',
    smart_draw_mode_both: '轮廓 + 涂色',
    smart_draw_mode_both_desc: '先勾线再填色；GIF / 表情包只取第一帧作静态图',

    // ── 快速示例（帮助面板） ──────────────────────────────────────────────────
    example_sine: '画一个正弦函数',
    example_square: 'y等于x的平方',
    example_heart: '画一个爱心',

    // ── 定积分可视化功能说明 ──────────────────────────────────────────────────
    integral_vis: '定积分可视化',
    integral_desc: '输入求积分的自然语言指令，AI 自动计算数值结果并填充阴影区域，直观展示面积。',
    integral_how: '在输入框直接描述积分区间与被积函数，例如「计算 x² 从 0 到 1 的定积分」。',
    integral_principle: '阴影填曲线与 x 轴之间：区间内 f≥0 用 0≤y≤f(x)；f≤0 用 f(x)≤y≤0；跨零点可用 min(0,f(x))≤y≤max(0,f(x))。',
    integral_tip1: '"计算 x^2 在 0 到 1 的积分"',
    integral_tip2: '"求 sin(x) 从 0 到 π 的定积分"',
    integral_tip3: '"求 -x^2 在 0 到 1 的定积分（负函数区域）"',

    // ── 不等式区域填色 ────────────────────────────────────────────────────────
    region_fill: '不等式区域填色',
    region_fill_desc: '用 Desmos 不等式给圆、椭圆、半平面等区域上色（与定积分阴影同一机制）。',
    region_fill_how: '在对话框描述要填充的区域，例如「半径为 2 的圆内部涂成红色」。',
    region_fill_principle: '填色仅支持 x、y 双重不等式；极坐标曲线用 r=f(θ)，如 r=cos(θ)。要填色须改笛卡尔式 x²+y²≤R²。',
    region_fill_tip3: '"画极坐标玫瑰线 r=cos(3θ)"',
    region_fill_tip1: '"圆心在原点、半径 2 的圆内部涂红色"',
    region_fill_tip2: '"填充椭圆 x²/4+y²≤1 的内部"',

    // ── 图片与 Emoji 拟合功能说明 ────────────────────────────────────────────
    image_fitting: '图片与 Emoji 拟合',
    image_fitting_desc: '上传图片、粘贴截图，或直接发送 Emoji，系统将颜色与轮廓转为 Desmos 公式。',
    image_fitting_how: '点击回形针 →「智能绘图」选模式（仅轮廓 / 仅涂色 / 轮廓+涂色）；也可 Ctrl+V 粘贴图片，或直接发送 Emoji。',
    image_fitting_principle: '色块：颜色网格分区 + 洪水填充；轮廓可选贝塞尔多段三次曲线，或 DFT 拟合为 X(t)、Y(t) 参数方程。',
    image_fitting_tip1: '点击输入框左侧的回形针图标上传图片',
    image_fitting_tip2: '直接粘贴剪贴板中的图片（Ctrl+V）',
    image_fitting_tip3: '发送 Emoji 会先选择仅轮廓 / 仅涂色 / 轮廓+涂色',
    image_fitting_tip4: '建议使用高对比度、轮廓清晰的简笔画效果最佳',

    // ── 拍照解题 ──────────────────────────────────────────────────────────────
    solve_problem: '拍照解题',
    solve_problem_desc: '上传数学题照片，AI 直接阅读图片并按你选择的风格解答（无需 OCR）。',
    solve_problem_how: '点击回形针 →「解决问题」→ 上传题目图片 → 选择仅提示 / 显示答案 / 提示+完整解答。',
    solve_problem_example1: '上传证明题，选「仅提示」获取思路',
    solve_problem_example2: '上传计算题，选「显示答案」查看完整步骤',
    solve_problem_principle: 'Gemini 视觉模型直接读图解题，再按需注入 Desmos 公式；默认使用内置 Gemini Key。',

    // ── 手绘转公式 ────────────────────────────────────────────────────────────
    hand_draw: '手绘转公式',
    hand_draw_desc: '在 Desmos 画板上徒手勾线，一键转为数学曲线。',
    hand_draw_how: '点击顶部工具栏「手绘」→ 在画板上绘制 →「确认转换」。可选保留或清空现有图形。',
    hand_draw_principle: '记录触控轨迹坐标并重采样，经 DFT 生成傅里叶参数方程写入画板。',

    // ── 画板分析功能说明 ──────────────────────────────────────────────────────
    canvas_analysis: '画板分析',
    canvas_analysis_desc: '让 AI 解读当前画板上所有公式的数学含义与几何关系。',
    canvas_analysis_how: '点击顶部工具栏的眼睛图标「分析画板」，无需额外输入。',
    canvas_analysis_example: '自动读取当前可见公式并解释它们的关系',
    canvas_analysis_principle: '系统抓取画板实时快照作为唯一可信来源，避免引用聊天中已删除的旧公式。',

    // ── 导出功能说明 ──────────────────────────────────────────────────────────
    export_title: '导出到 Desmos 官网',
    export_desc: '点击顶部工具栏的导出按钮，将当前画板状态导出为 JavaScript 代码。由于 Desmos 不开放第三方写入权限，需要手动通过浏览器控制台导入。',
    export_step1: '1. 点击导出按钮，复制生成的代码',
    export_step2: '2. 打开 desmos.com/calculator',
    export_step3: '3. 按 F12 打开开发者工具 Console',
    export_step4: '4. 粘贴代码并回车执行',
    why_no_link: '为什么不是直接链接？',
    why_no_link_desc: 'Desmos 官网链接需要将数据存储在 Desmos 的私有服务器上。出于安全原因，Desmos 并未开放第三方写入权限。因此，没有任何非官方工具能直接生成 desmos.com/calculator/... 链接。',
    how_to_transfer: '如何手动转数据？',
    step_copy: '点击下方 复制代码 按钮。',
    step_open: '在浏览器打开 desmos.com/calculator',
    step_console: '按 F12 打开开发者工具 (Console)。',
    step_paste: '在 Console 中粘贴代码并按回车。',
    copy_code: '复制代码',
    copy_code_success: '复制成功',

    // ── 导出弹窗 ──────────────────────────────────────────────────────────────
    export_guide: '请在 desmos.com/calculator 打开控制台（F12），将下方代码粘贴后回车即可恢复画板。',
    copy_success: '✅ 核心代码已复制！\n\n请前往 desmos.com/calculator 按 F12 打开控制台粘贴。',
    copy_fail: '⚠️ 自动复制失败，请手动全选文本框内容并复制。',

    // ── 操作确认 & 系统消息 ──────────────────────────────────────────────────
    confirm_clear: '确定要清除所有对话记录吗？',  // confirm() 弹窗的提示文字
    canvas_cleared: '画板已清空。',              // 清空画板后在聊天中显示的消息
    drawing_complete: '绘画已完成。',            // 图片拟合成功后的消息
    drawing_processing: '正在分析图片…',
    gif_drawing_processing: '正在解码 GIF 并分析时间轴…',
    gif_drawing_frame: '正在处理第 {current}/{total} 关键帧…',
    gif_drawing_ai: 'AI 逐帧高保真识别 {current}/{total} 帧（定格动画 · 8 帧/批）…',
    gif_drawing_worker: 'Worker 并行处理第 {current}/{total} 帧…',
    gif_drawing_archive: '正在写入第 {current}/{total} 帧（已折叠，避免一次刷太多行）…',
    gif_drawing_inject: '正在写入画板第 {current}/{total} 帧…',
    gif_drawing_saving_partial: '正在保存已完成部分到画板…',
    gif_drawing_complete: '完美定格已写入每一帧。拖动滑块 s 换帧。',
    gif_drawing_partial_complete: '定格部分成品已写入（{current}/{total} 帧）。拖动滑块 s 播放。',
    gif_process_fail: 'GIF 处理失败，请重试。若仍失败，可尝试标准质量或关闭 AI 修复。',
    gif_handle_title: 'GIF / 表情包处理方式',
    gif_handle_first_frame: '只取第一帧（静态图）',
    gif_handle_first_frame_desc: '当作普通图片拟合，更快、公式更少',
    gif_handle_animation: '完整动画',
    gif_handle_animation_desc: '逐帧写入画板，可用滑块 s 播放',
    gif_quality_title: 'GIF 定格质量',
    gif_quality_perfect: '完美定格',
    gif_quality_perfect_desc: '高还原 · 同色合并少公式 · 每一帧都写入画板',
    gif_quality_standard: '标准',
    gif_quality_standard_desc: '更少公式 · 低配更流畅',
    gif_quality_cinema: '电影级',
    gif_quality_cinema_desc: '约 12fps · 高细节 · 介于标准与完美之间',
    drawing_local_repair: '正在修复图片对比度与边缘…',
    drawing_ai_repair: 'AI 正在分析图像并精确追踪轮廓…',
    drawing_progress_outline: '正在勾勒轮廓 {current}/{total}…',
    drawing_progress_fill: '正在填色 {current}/{total}…',
    drawing_progress_inject: '正在写入画板 {current}/{total}…',
    drawing_cancelled: '绘画已终止。',
    drawing_partial_complete: '部分成品已写入画板（任务已终止）。',
    drawing_saving_partial: '正在保存已完成部分到画板…',
    task_cancel: '终止',
    task_cancelled: '任务已终止。',
    image_process_fail: '图片处理失败：可能是图片对比度不足或未找到闭合轮廓。', // 图片处理失败消息

    // ── 聊天界面基础文字 ──────────────────────────────────────────────────────
    thinking: '正在思考...',                    // AI 加载时的提示
    input_placeholder: '输入消息...',            // 输入框占位文字
    upload_hint: '上传图片或 GIF（支持 PNG/JPG/GIF，也可 Ctrl+V 粘贴）', // 回形针按钮 tooltip
    image_uploaded: '图片已上传',                // 消息列表中图片缩略图的文字
    welcome: '你好！我是 AI Desmos。',           // 聊天的第一条欢迎消息

    // ── API Key 操作反馈 ──────────────────────────────────────────────────────
    key_saved: '✅ API Key 已保存',
    restored: '已恢复默认配置',

    // ── 错误消息（分类型） ────────────────────────────────────────────────────
    err_balance: '⚠️ API 余额不足：请检查您的 DeepSeek 账户余额。',  // 余额不足错误
    err_key: '⚠️ API Key 无效：请检查您的 Key 配置是否正确。',       // Key 无效错误
    err_system: '系统错误：连接断开或超时。',
    err_network: '⚠️ 无法连接 AI 服务：请确认网络正常，或稍后重试（Gemini 配额用尽也会表现为连接失败）。',

    // ── 画板上下文注入（发给 AI 的系统消息） ────────────────────────────────
    analyze_prompt: '请根据下方「实时画板快照」分析当前画布上的全部可见内容，解释其几何意义与相互关系。不要引用聊天记录里曾出现但快照中已不存在的公式。',
    analyze_empty: '当前画板为空，没有可分析的公式或图形。',
    context_title: '【当前画板状态】',
    context_empty: '(空 - 画板上没有任何可见内容)',
    context_expressions: '【当前画板公式】',
    context_expressions_live: '【当前画板公式（实时快照）】',
    context_viewport: '【当前可视范围】',
    context_snapshot_time: '【快照时间】',
    context_visible_count: '可见条目：{count} 条',
    context_hidden_note: '（已省略 {count} 条内部辅助公式，如傅里叶系数）',
    context_instruction: '以上内容为点击分析按钮瞬间从 Desmos 读取，是唯一可信来源。',
    context_instruction_general: '请在回答中优先参考这些内容。如果画板为空，请直接告诉用户当前没有函数。',

    // ── 语言切换 ──────────────────────────────────────────────────────────────
    lang_select: '语言 / Language',

    // ── 页脚 ──────────────────────────────────────────────────────────────────
    footer_disclaimer: 'AI Desmos 可能会犯错，请注意甄别重要信息。',
    copyright: '\u00a9 2026 灵俊宇 版权所有', // \u00a9 是版权符号 © 的 Unicode 编码

    // ── Emoji 绘图状态消息 ────────────────────────────────────────────────────
    // {emoji} 是模板占位符，会被 t() 函数中的 params 参数替换成实际 emoji
    emoji_drawing: '正在绘制 {emoji} ...',
    emoji_success: '✅ 已为您绘制 {emoji}',
    emoji_fail: '❌ 绘制失败，无法解析该 Emoji 的轮廓。',

    // ── 使用技巧（帮助面板） ──────────────────────────────────────────────────
    tips_title: '使用技巧',
    tip_enter: 'Enter 发送消息，Shift+Enter 换行',
    tip_context: 'AI 记忆上下文，可以说"把上面的改成..."来修改',
    tip_clear_canvas: '清空画板不会影响聊天记录',
    tip_api_key: '使用自己的 DeepSeek API Key 可避免速率限制',
    tip_lang: '在设置中可以切换中英文界面',

    // ── AI 建议按钮 & 输入法提醒 ─────────────────────────────────────────────
    ai_suggestion_btn: '不会写公式？让 AI 帮你写 ✨',
    // ime_reminder 已不再显示为 Toast，保留 key 以兼容旧代码
    ime_reminder: '已尝试为您切换为英文输入环境。如果未生效，请手动切换至英文输入法以防公式输入错误。',

    // ── AI 智能纠错 ────────────────────────────────────────────────────────────
    // 纠错按钮上显示的文字
    ai_fix_btn: 'AI 智能纠错',
    ai_fix_query: '我的公式 `{latex}` 报错了：{error}。请分析错误原因，给出修正后的正确公式（用 <DESMOS> 标签包裹输出），并简要说明改了什么。',
    ai_fix_no_id: '无法定位出错公式，请先点击该公式后再试。',
    ai_auto_fix_toast: '检测到语法错误，正在自动修复…',

    draw_mode_btn: '手绘',
    draw_mode_exit: '退出手绘',
    draw_mode_hint: '在画板上手绘，可画多笔',
    draw_mode_strokes: '已画 {count} 笔，可继续添加',
    draw_mode_confirm: '确认转换',
    draw_mode_processing: '正在转换...',
    draw_mode_restore_title: '恢复上次手绘？',
    draw_mode_restore_desc: '检测到上次手绘了 {count} 笔，要保留继续编辑还是清除重新开始？',
    draw_mode_restore_keep: '保留',
    draw_mode_restore_clear: '清除',
    draw_mode_canvas_title: '选择绘图模式',
    draw_mode_canvas_desc: '保留模式：在现有画布上追加线条；删除模式：清空画布后重新绘制。',
    draw_mode_canvas_keep: '保留模式',
    draw_mode_canvas_clear: '删除模式',
    draw_mode_undo: '撤销',
    draw_mode_color: '画笔颜色',
    draw_mode_color_custom: '自定义颜色',

    // ── 工具栏说明（帮助面板） ──────────────────────────────────────────────
    toolbar_title: '工具栏说明',
    toolbar_analyze: '分析画板 — AI 解读当前公式',
    toolbar_export: '导出 — 生成可迁移到官网的代码',
    toolbar_clear_canvas: '清空画板 — 移除所有图形',
    toolbar_clear_history: '清除记录 — 清空聊天历史',
    toolbar_settings: '设置 — API Key 与语言配置',
    toolbar_guide: '帮助 — 打开本使用指南',

    // ── 引导页（Onboarding） ──────────────────────────────────────────────────
    onboard_title: '欢迎使用 AI Desmos',
    onboard_desc: '您的智能数学绘图助手：自然语言对话、图片拟合、积分可视化与拍照解题。',
    onboard_start: '下一步',
    onboard_welcome_start: '开始体验',
    onboard_step1_title: '使用说明',
    onboard_guide_intro: '首次使用，快速了解全部功能。每项功能附有使用示例与简要原理；之后可在聊天栏「帮助」中随时查看。',
    onboard_feat1: '🎨 自然语言绘图：像聊天一样画函数',
    onboard_feat2: '📸 图像转公式：上传图片或 Emoji 自动拟合',
    onboard_feat3: '∫ 定积分可视化：自动计算并填充阴影',
    onboard_step2_title: 'API 配置',
    onboard_step2_desc: '为了获得最佳体验，请选择您的 DeepSeek API 模式。',
    onboard_mode_default: '使用默认 Key (试用)',
    onboard_mode_default_desc: '适合快速体验，但可能存在速率限制。',
    onboard_mode_custom: '使用自定义 Key (推荐)',
    onboard_mode_custom_desc: '输入您的 DeepSeek API Key，稳定且无限制。',
    onboard_enter: '进入应用',
    onboard_back: '上一步',

    // ── 上传模式选择菜单 ──────────────────────────────────────────────────────
    upload_menu_title: '选择模式',           // 回形针弹出菜单标题
    mode_draw: '智能绘图',                   // 模式1：图片转公式并绘制
    mode_draw_desc: '选择仅轮廓、仅涂色或轮廓+涂色',
    mode_solve: '解决问题',                  // 模式2：OCR 识别题目后 AI 解题
    mode_solve_desc: '上传问题图片，AI 辅助解决',

    // ── 解题模式选项 ──────────────────────────────────────────────────────────
    solve_options_title: '选择解决风格',
    solve_hint: '💡 仅提示',                 // 只给解题思路，不给答案
    solve_hint_desc: '提供方法和步骤，不给出最终答案',
    solve_answer: '✅ 显示答案',              // 给出完整解答
    solve_answer_desc: '完整步骤和最终答案',
    solve_full: '📝 提示 + 完整解答',        // 先提示再给完整解答
    solve_full_desc: '先提示，再给出完整解答',

    // ── 解题过程状态消息 ──────────────────────────────────────────────────────
    solving: '正在解决，请稍等...',
    solve_done: '✅ 解答完成',
    solve_fail_vision: '⚠️ 当前 API 不支持图像识别。请在设置中配置一个支持图像识别的 API Key。',
    solve_fail: '❌ 解答失败，请重试。',
    uploading_problem: '📷 问题图片',        // 解题时用户消息中的图片标签

    // ── 试用模式 ──────────────────────────────────────────────────────────────
    // {used} 和 {limit} 是占位符，会被替换成实际的数字
    trial_badge: '试用 {used}/{limit}',     // 顶部小徽章
    trial_exhausted: '试用已用完',           // 试用次数耗尽时的徽章文字
    trial_limit_title: '试用次数已用完',
    trial_limit_desc: '默认试用模式最多支持 {limit} 次 AI 调用。配置您自己的 DeepSeek API Key 即可解锁无限次使用。',
    trial_limit_note: 'API Key 仅保存在本地浏览器，不会上传至任何服务器。',
    trial_setup_key: '配置我的 API Key',
    trial_get_key: '获取 DeepSeek API Key（免费注册）',
    trial_close: '稍后再说',

    // ── 邀请码 ────────────────────────────────────────────────────────────────
    invite_code: '邀请码',
    invite_code_desc: '输入邀请码可永久解除本设备的试用次数限制。',
    invite_code_placeholder: '输入邀请码...',
    invite_code_redeem: '兑换',
    invite_code_success: '🎉 邀请码有效！本设备试用限制已永久解除。',
    invite_code_error: '❌ 邀请码无效，请重试。',
    invite_code_unlocked: '已解锁',
    invite_code_or: '— 或者 —',             // 邀请码与其他选项之间的分隔文字

    // ── OCR 识别流程 ──────────────────────────────────────────────────────────
    ocr_recognizing: '📷 OCR 识别中，请稍候...', // 正在进行 OCR 识别
    ocr_analyzing: '🧠 正在阅读题目图片并分析…',
    ocr_fail: '❌ OCR 识别失败：请确保图片清晰、包含可读文字。',
    ocr_empty: '❌ OCR 未识别到文字，请换一张更清晰的图片。',

    // ── API 服务商设置 ────────────────────────────────────────────────────────
    settings_provider: 'API 服务商',
    settings_provider_desc: '粘贴 API Key 后将自动识别服务商，支持 DeepSeek、OpenAI、Claude、Gemini、Groq、OpenRouter 等主流厂家。',
    settings_detected: '已识别',
    settings_no_key_hint: '未配置 Key 时可使用试用额度。粘贴 Key 后系统会自动识别厂家并推荐模型。',
    settings_key_placeholder: '粘贴您的 API Key，系统将自动识别厂家…',
    settings_model: '模型',
    settings_key_label: 'API Key',
    settings_key_placeholder_ds: 'sk-... (DeepSeek Key)',
    settings_key_placeholder_oai: 'sk-... (OpenAI Key)',
    settings_key_note: 'Key 仅保存在本地浏览器，不会上传至任何服务器。',
    settings_save: '保存',
    settings_reset: '恢复默认',
    settings_saved_ok: '✅ 配置已保存',
    settings_reset_ok: '已恢复为默认配置',

    // ── DeepSeek 获取教程 ────────────────────────────────────────────────────
    tut_ds_title: '如何获取 DeepSeek API Key',
    tut_ds_1: '访问 platform.deepseek.com 并登录',
    tut_ds_2: '点击左侧菜单「API Keys」',
    tut_ds_3: '点击「创建 API Key」，填写名称',
    tut_ds_4: '复制生成的 Key（以 sk- 开头）',
    tut_ds_5: '粘贴到下方输入框并保存',
    tut_ds_note: '💡 DeepSeek 提供充值制余额，新用户赠送一定额度，性价比极高。',

    // ── OpenAI 获取教程 ──────────────────────────────────────────────────────
    tut_oai_title: '如何获取 OpenAI API Key',
    tut_oai_1: '访问 platform.openai.com 并登录',
    tut_oai_2: '点击左侧「API keys」',
    tut_oai_3: '点击「Create new secret key」',
    tut_oai_4: '复制生成的 Key（仅显示一次！）',
    tut_oai_5: '前往「Billing」添加付款方式',
    tut_oai_6: '粘贴到下方输入框并保存',
    tut_oai_note: '💡 推荐选择 gpt-4o-mini，速度快且费用低。gpt-4o 能力更强但更贵。',
    tut_visit: '访问官网 →',

    // ── Claude (Anthropic) 获取教程 ─────────────────────────────────────────
    tut_claude_title: '如何获取 Claude (Anthropic) API Key',
    tut_claude_1: '访问 console.anthropic.com 并登录',
    tut_claude_2: '点击左侧菜单「API Keys」',
    tut_claude_3: '点击「Create Key」，填写名称',
    tut_claude_4: '复制生成的 Key（以 sk-ant- 开头）',
    tut_claude_5: '粘贴到下方输入框并保存',
    tut_claude_note: '💡 Claude 按 Token 计费，新用户有免费额度。claude-3-5-sonnet 性价比最高，Opus 能力最强。',
    settings_key_placeholder_claude: 'sk-ant-... (Anthropic Key)',

    // ── Claude 长手模式（Computer Use）──────────────────────────────────────
    // "长手"是 Computer Use 功能的形象比喻：让 AI 能"伸手"操控浏览器
    claude_long_hand: '长手功能',
    claude_long_hand_desc: '让 Claude 像人一样浏览、搜索和操控网页。启用后，Claude 可接收网页截图并发送点击、输入等指令。',
    claude_long_hand_cloud_note: '⚡ 仅云端可用 · 需部署后端代理',
    claude_long_hand_sim_mode: '当前为模拟模式，Claude 会描述操作步骤但不实际执行。部署后端后可开启完整功能。',
    claude_long_hand_badge: '🖐️ 长手模式',  // 聊天头部显示的徽章
    claude_long_hand_on: '已开启',
    claude_long_hand_off: '已关闭',

    // ── Desmos 加载屏幕 ───────────────────────────────────────────────────────
    loading_title: '正在加载 Desmos...',
    loading_desc: '数学引擎启动中，请稍候',
    loading_error_title: '加载失败',
    loading_error_desc: '无法加载 Desmos API 组件',
    loading_error_tip1: '请检查网络连接是否正常',
    loading_error_tip2: '确认可以访问 www.desmos.com',
    loading_error_tip3: '尝试关闭 VPN 或代理',
    loading_retry: '刷新重试',

    // ── 训练数据（Few-Shot 学习）─────────────────────────────────────────────
    // Few-Shot：通过给 AI 几个示例，让 AI 理解你想要的回答风格
    training_title: '训练数据',
    training_desc: '添加示范问答对，注入到 AI 系统提示中作为参考。系统不会事后强制改写 AI 的回复，请通过优质示范帮助 AI 学会正确写法。',
    training_add: '添加示例',
    training_question: '用户问题',
    training_answer: '标准回答',
    training_question_placeholder: '例：画一个半径为3的圆',
    training_answer_placeholder: '例：定积分负函数用 f(x)\\le y\\le 0；<DESMOS>f(x)=-x^2</DESMOS><DESMOS>f(x)\\le y\\le 0\\left\\{0\\le x\\le 1\\right\\}</DESMOS><DESMOS>\\int_{0}^{1} (-x^2) dx</DESMOS>',
    training_save: '保存',
    training_cancel: '取消',
    training_delete: '删除',
    training_empty: '暂无训练数据。点击上方按钮添加示例问答对。',
    training_count: '{count} 条训练数据',    // {count} 会被替换成实际数量
    training_delete_confirm: '确认删除此训练数据？',
    training_imported: '已导入 {count} 条训练数据',
    training_export: '导出',
    training_import: '导入',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 英文词典（结构与中文完全相同，每个 key 对应一个英文翻译）
  // ═══════════════════════════════════════════════════════════════════════════
  en: {
    // ── 基础 UI ──────────────────────────────────────────────────────────────
    title: 'AI Desmos',
    subtitle: 'AI Mathematical Creativity Platform',
    beta: 'Beta',
    analyze_canvas: 'Analyze Canvas',
    explain_canvas: 'AI Teach (Explain)',
    explain_prompt: 'Explain everything on the canvas in beginner-friendly language: the math used, why this model fits, and what each parameter does.',
    export_to_desmos: 'Export to Desmos',
    clear_canvas: 'Clear Canvas',
    clear_history: 'Clear History',
    api_settings: 'API Settings',
    help: 'Help',

    creativity_title: 'Creativity Studio',
    creativity_subtitle: 'Imagination → Math Model → Interactive Viz',
    creativity_templates: 'Math Art Templates',
    creativity_params: 'Parameter Explorer',
    creativity_color: 'Accent color',
    creativity_explain: 'Explain',
    creativity_ai_demo: 'AI Bridge Demo',

    tpl_bridge: 'Bridge',
    tpl_bridge_desc: 'Parabolic arch — adjustable span & height',
    tpl_bridge_model: 'Model: $y = -\\frac{4H}{W^2}x^2 + H$. Parabolic arches transfer load to supports — a classic structural form.',
    tpl_ferris: 'Ferris wheel',
    tpl_ferris_desc: 'Circle + spokes — symmetry & rotation',
    tpl_ferris_model: 'Model: $x^2+y^2=R^2$ plus $(R\\cos t, R\\sin t)$. Circles are perfectly rotation-symmetric.',
    tpl_flower: 'Flower',
    tpl_flower_desc: 'Polar rose curve — petal count adjustable',
    tpl_flower_model: 'Model: $r = a\\cos(n\\theta)$ (rose curve). $n$ = petals, $a$ = size.',
    tpl_logo: 'Logo',
    tpl_logo_desc: 'Parametric heart curve for brand shapes',
    tpl_logo_model: 'Model: parametric heart $(16\\sin^3 t, 13\\cos t - 5\\cos 2t - \\cdots)$; $s$ scales the shape.',
    tpl_stars: 'Starry sky',
    tpl_stars_desc: 'Background fill + star points',
    tpl_stars_model: 'Model: inequality shading + discrete points $(x_i,y_i)$ to simulate star density.',

    tpl_param_span: 'Span W',
    tpl_param_height: 'Height H',
    tpl_param_radius: 'Radius R',
    tpl_param_size: 'Size a',
    tpl_param_petals: 'Petals n',
    tpl_param_scale: 'Scale s',
    tpl_param_star_count: 'Stars N',
    tpl_param_spread: 'Spread S',

    // ── 图片上传 ──────────────────────────────────────────────────────────────
    upload_image: 'Upload Image',

    // ── API 配置 ──────────────────────────────────────────────────────────────
    api_config: 'API Configuration',
    custom_key: 'Custom DeepSeek Key',
    custom_key_desc: 'If you encounter balance issues or rate limits, you can enter your own API Key. Your Key is stored locally and never sent to third-party servers.',
    save_config: 'Save Config',
    restore_default: 'Restore Default',

    // ── 使用指南 ──────────────────────────────────────────────────────────────
    user_guide: 'User Guide',
    guide_how: 'How to use',
    guide_example: 'Examples',
    guide_principle: 'How it works',

    // ── 工作原理说明 ──────────────────────────────────────────────────────────
    theory_title: 'How Does Drawing Work?',
    theory_desc: 'Smart drawing and image fitting convert shapes into math expressions Desmos can plot.',
    theory_step1: '1. Extract shapes: flood fill for color blocks; Sobel edge detection for line-art contours.',
    theory_step2: '2. Math fitting: multi-segment cubic Béziers, or DFT (Discrete Fourier Transform) for frequency coefficients.',
    theory_step3: '3. Parametric equations: combine into X(t) and Y(t) (Desmos only accepts t as the parameter); Desmos draws via rotating vectors.',

    // ── 智能绘图功能说明 ──────────────────────────────────────────────────────
    smart_draw: 'Natural Language Plotting',
    smart_draw_desc: 'Describe shapes in chat — AI generates formulas and draws them on the canvas. Supports multi-turn edits.',
    smart_draw_how: 'Type a description in Chinese or English and press Enter. Say things like "change it to red" to refine.',
    smart_draw_principle: 'AI injects via <DESMOS> (hidden from chat); formulas show as LaTeX in blue cards. Vague requests get general forms with parameter explanations.',
    smart_draw_tip1: '"Draw a heart"',
    smart_draw_tip2: '"Draw y=sin(x) and y=cos(x)"',
    smart_draw_tip3: '"Make it bigger" / "Change to red"',
    smart_draw_tip4: '"Design a modern arch bridge, 30m span"',
    smart_draw_tip5: '"Explain the math on this graph"',
    smart_draw_mode_title: 'Choose drawing mode',
    smart_draw_mode_outline: 'Outline only',
    smart_draw_mode_outline_desc: 'Sobel edge outlines — mono or color',
    fit_method_title: 'Outline fitting',
    fit_method_bezier: 'Lines / circles / Bézier',
    fit_method_bezier_desc: 'Straights as parametric lines, near-circles as circle equations, bends as Béziers — fewer formulas, smooth when zoomed',
    fit_method_fourier: 'Fourier transform',
    fit_method_fourier_desc: 'DFT parametric X(t), Y(t) — good for epicycles and smooth closed shapes',
    fit_method_hint: 'Pick Lines/circles/Bézier for readable math; Fourier for harmonics / rotation.',
    outline_style_title: 'Outline color',
    outline_style_mono: 'Black & white',
    outline_style_mono_desc: 'Uniform black strokes',
    outline_style_color: 'From image',
    outline_style_color_desc: 'Sample colors along edges',
    outline_style_hint: 'Outline-only defaults to image colors. Outline+fill always uses black strokes; fill carries the color.',
    smart_draw_mode_fill: 'Fill only',
    smart_draw_mode_fill_desc: 'Color blocks only, no outlines',
    smart_draw_mode_both: 'Outline + fill',
    smart_draw_mode_both_desc: 'Outlines + fill; GIF / stickers use the first frame as a still image',

    // ── 快速示例 ──────────────────────────────────────────────────────────────
    example_sine: 'Draw a sine wave',
    example_square: 'y equals x squared',
    example_heart: 'Draw a heart',

    // ── 定积分可视化 ──────────────────────────────────────────────────────────
    integral_vis: 'Integral Visualization',
    integral_desc: 'Ask for a definite integral in natural language — AI computes the value and shades the area.',
    integral_how: 'Type an integral request, e.g. "Calculate integral of x² from 0 to 1".',
    integral_principle: 'Shade between the curve and the x-axis: if f≥0 use 0≤y≤f(x); if f≤0 use f(x)≤y≤0; if it crosses zero use min(0,f(x))≤y≤max(0,f(x)).',
    integral_tip1: '"Calculate integral of x^2 from 0 to 1"',
    integral_tip2: '"Calculate definite integral of sin(x) from 0 to π"',
    integral_tip3: '"Calculate integral of -x^2 from 0 to 1 (negative region)"',

    region_fill: 'Inequality Region Fill',
    region_fill_desc: 'Color circles, ellipses, and other regions using Desmos inequalities (same mechanism as integral shading).',
    region_fill_how: 'Describe the region in chat, e.g. "Fill the interior of a circle of radius 2 with red".',
    region_fill_principle: 'Fill uses x–y double inequalities only; polar curves use r=f(θ), e.g. r=cos(θ). For filled disks use x²+y²≤R² in Cartesian form.',
    region_fill_tip3: '"Plot polar rose r=cos(3θ)"',
    region_fill_tip1: '"Fill the interior of x²+y²<4 with red"',
    region_fill_tip2: '"Shade the interior of ellipse x²/4+y²<1"',

    // ── 图片与 Emoji 拟合 ───���────────────────────────────────────────────────
    image_fitting: 'Image & Emoji Fitting',
    image_fitting_desc: 'Upload an image, paste a screenshot, or send an Emoji — colors and contours become Desmos formulas.',
    image_fitting_how: 'Paperclip → Smart Drawing → pick outline / fill / both; or Ctrl+V to paste; or send an Emoji directly.',
    image_fitting_principle: 'Fill: color grid + flood fill. Contours: choose multi-segment cubic Béziers, or DFT into X(t), Y(t) parametric equations.',
    image_fitting_tip1: 'Click the paperclip icon on the left of the input box to upload an image',
    image_fitting_tip2: 'Directly paste an image from the clipboard (Ctrl+V)',
    image_fitting_tip3: 'Sending an Emoji opens outline / fill / both mode picker',
    image_fitting_tip4: 'High contrast and clear outline sketches work best',

    solve_problem: 'Photo Problem Solving',
    solve_problem_desc: 'Upload a math problem photo — AI reads the image directly and solves in your chosen style (no OCR).',
    solve_problem_how: 'Paperclip → Solve Problem → upload photo → choose hints only / full answer / hints + solution.',
    solve_problem_example1: 'Upload a proof — pick "Hints Only" for approach',
    solve_problem_example2: 'Upload a calculation — pick "Show Answer" for full steps',
    solve_problem_principle: 'Gemini vision reads the image directly, then injects Desmos formulas as needed; built-in Gemini key by default.',

    hand_draw: 'Hand Draw to Formula',
    hand_draw_desc: 'Sketch freehand on the Desmos canvas and convert strokes to math curves.',
    hand_draw_how: 'Toolbar "Hand Draw" → sketch on canvas → Confirm. Choose keep or clear existing graphics.',
    hand_draw_principle: 'Touch/stroke coordinates are resampled, then DFT produces Fourier parametric equations on the canvas.',

    canvas_analysis: 'Canvas Analysis',
    canvas_analysis_desc: 'Let AI explain all formulas on the canvas and their geometric relationships.',
    canvas_analysis_how: 'Click the eye icon "Analyze Canvas" on the top toolbar — no extra input needed.',
    canvas_analysis_example: 'Reads visible formulas and explains how they relate',
    canvas_analysis_principle: 'A live canvas snapshot is the single source of truth — avoids stale formulas from chat history.',

    // ── 导出功能 ──────────────────────────────────────────────────────────────
    export_title: 'Export to Desmos.com',
    export_desc: 'Click the export button on the top toolbar to export the current canvas state as JavaScript code. Since Desmos does not allow third-party write access, you need to manually import it via the browser console.',
    export_step1: '1. Click the export button and copy the generated code',
    export_step2: '2. Open desmos.com/calculator',
    export_step3: '3. Press F12 to open Console',
    export_step4: '4. Paste the code and hit Enter',
    why_no_link: 'Why no direct link?',
    why_no_link_desc: 'Desmos requires data to be stored on private servers. For security, Desmos does not allow third-party write access. Thus, no unofficial tool can generate desmos.com links directly.',
    how_to_transfer: 'How to transfer manually?',
    step_copy: 'Click "Copy Code" below.',
    step_open: 'Open desmos.com/calculator',
    step_console: 'Press F12 to open Console.',
    step_paste: 'Paste code in Console and hit Enter.',
    copy_code: 'Copy Code',
    copy_code_success: 'Copied',
    export_guide: 'Open desmos.com/calculator, press F12 to open Console, paste the code below and press Enter to restore.',
    copy_success: '✅ Core code copied!\n\nGo to desmos.com/calculator, press F12, and paste in Console.',
    copy_fail: '⚠️ Auto-copy failed. Please manually select and copy.',

    // ── 操作确认 & 系统消息 ──────────────────────────────────────────────────
    confirm_clear: 'Are you sure you want to clear chat history?',
    canvas_cleared: 'Canvas cleared.',
    drawing_complete: 'Drawing complete.',
    drawing_processing: 'Analyzing image…',
    gif_drawing_processing: 'Decoding GIF and building timeline…',
    gif_drawing_frame: 'Processing keyframe {current}/{total}…',
    gif_drawing_ai: 'AI per-frame high-fidelity analysis {current}/{total} (stop-motion · 8/batch)…',
    gif_drawing_worker: 'Worker parallel processing {current}/{total}…',
    gif_drawing_archive: 'Writing frame {current}/{total} (collapsed, paced)…',
    gif_drawing_inject: 'Writing frame {current}/{total} to canvas…',
    gif_drawing_saving_partial: 'Saving completed part to canvas…',
    gif_drawing_complete: 'Stop-motion ready. Drag slider s to switch frames.',
    gif_drawing_partial_complete: 'Partial stop-motion saved ({current}/{total} frames). Drag slider s to play.',
    gif_process_fail: 'GIF processing failed. Please retry, or try standard quality without AI repair.',
    gif_handle_title: 'GIF / sticker handling',
    gif_handle_first_frame: 'First frame only (still image)',
    gif_handle_first_frame_desc: 'Fit as a normal image — faster, fewer formulas',
    gif_handle_animation: 'Full animation',
    gif_handle_animation_desc: 'Write every frame; scrub with slider s',
    gif_quality_title: 'GIF stop-motion quality',
    gif_quality_perfect: 'Perfect',
    gif_quality_perfect_desc: 'High fidelity · merged fills · every frame kept on canvas',
    gif_quality_standard: 'Standard',
    gif_quality_standard_desc: 'Fewer formulas · smoother on low-end PCs',
    gif_quality_cinema: 'Cinema',
    gif_quality_cinema_desc: '~12fps · high detail · between standard and perfect',
    drawing_local_repair: 'Enhancing contrast and edges…',
    drawing_ai_repair: 'AI is analyzing the image and tracing precise contours…',
    drawing_progress_outline: 'Drawing outlines {current}/{total}…',
    drawing_progress_fill: 'Filling blocks {current}/{total}…',
    drawing_progress_inject: 'Writing to canvas {current}/{total}…',
    drawing_cancelled: 'Drawing stopped.',
    drawing_partial_complete: 'Partial result saved to canvas (task stopped).',
    drawing_saving_partial: 'Saving completed part to canvas…',
    task_cancel: 'Stop',
    task_cancelled: 'Task cancelled.',
    image_process_fail: 'Image processing failed: Low contrast or no closed contours found.',

    // ── 聊天界面基础文字 ──────────────────────────────────────────────────────
    thinking: 'Thinking...',
    input_placeholder: 'Type a message...',
    upload_hint: 'Upload image or GIF (PNG/JPG/GIF) or paste with Ctrl+V',
    image_uploaded: 'Image uploaded',
    welcome: 'Hello! I am AI Desmos.',

    // ── API Key 操作反馈 ──────────────────────────────────────────────────────
    key_saved: '✅ API Key Saved',
    restored: 'Restored default configuration',

    // ── 错误消息 ──────────────────────────────────────────────────────────────
    err_balance: '⚠️ Insufficient Balance: Check your DeepSeek account.',
    err_key: '⚠️ Invalid API Key: Check your configuration.',
    err_system: 'System Error: Connection lost or timeout.',
    err_network: '⚠️ Cannot reach AI service: check your network or retry later (Gemini quota limits may also cause this).',

    // ── 画板上下文注入 ────────────────────────────────────────────────────────
    analyze_prompt: 'Analyze ONLY the live canvas snapshot below. Explain the geometric meaning and relationships of what is currently visible. Do NOT refer to formulas from chat history that are not in the snapshot.',
    analyze_empty: 'The canvas is empty — there are no formulas or graphs to analyze.',
    context_title: '[Current Canvas State]',
    context_empty: '(Empty — no visible content on canvas)',
    context_expressions: '[Current Formulas]',
    context_expressions_live: '[Live Canvas Snapshot]',
    context_viewport: '[Current Viewport]',
    context_snapshot_time: '[Snapshot Time]',
    context_visible_count: 'Visible items: {count}',
    context_hidden_note: '({count} internal helper formulas omitted, e.g. Fourier coefficients)',
    context_instruction: 'The above was read from Desmos at the moment the analyze button was clicked — it is the only source of truth.',
    context_instruction_general: 'Please prioritize this context. If the canvas is empty, tell the user.',

    // ── 语言切换 ──────────────────────────────────────────────────────────────
    lang_select: 'Language',

    // ── 页脚 ──────────────────────────────────────────────────────────────────
    footer_disclaimer: 'AI Desmos can make mistakes. Consider checking important information.',
    copyright: '\u00a9 2026 Junyu Ling. All rights reserved.',

    // ── Emoji 绘图状态消息 ────────────────────────────────────────────────────
    emoji_drawing: 'Drawing {emoji} ...',
    emoji_success: '✅ Drawn {emoji} for you',
    emoji_fail: '❌ Failed to draw. Could not parse contour for this Emoji.',

    // ── 使用技巧 ──────────────────────────────────────────────────────────────
    tips_title: 'Tips',
    tip_enter: 'Enter to send, Shift+Enter to newline',
    tip_context: 'AI remembers context, say "change the above to..." to modify',
    tip_clear_canvas: 'Clearing canvas does not affect chat history',
    tip_api_key: 'Use your own DeepSeek API Key to avoid rate limits',
    tip_lang: 'Switch language in settings',

    // ── AI 建议按钮 & 输入法提醒 ─────────────────────────────────────────────
    ai_suggestion_btn: 'Need formula help? Ask AI ✨',
    ime_reminder: 'We tried switching to an English keyboard for you. If it didn\'t work, please switch manually to avoid formula syntax errors.',

    // ── AI 智能纠错 ────────────────────────────────────────────────────────────
    ai_fix_btn: 'AI Smart Fix',
    ai_fix_query: 'My formula `{latex}` has an error: {error}. Please analyze the issue, provide the corrected formula in <DESMOS> tags, and briefly explain what was changed.',
    ai_fix_no_id: 'Could not locate the errored expression. Click it first, then try again.',
    ai_auto_fix_toast: 'Syntax error detected — auto-fixing…',

    draw_mode_btn: 'Draw',
    draw_mode_exit: 'Exit Draw',
    draw_mode_hint: 'Draw on the canvas — multiple strokes supported',
    draw_mode_strokes: '{count} stroke(s) drawn — add more or confirm',
    draw_mode_confirm: 'Confirm',
    draw_mode_processing: 'Converting...',
    draw_mode_restore_title: 'Restore previous drawing?',
    draw_mode_restore_desc: 'You have {count} stroke(s) from your last session. Keep them to continue editing, or clear to start fresh.',
    draw_mode_restore_keep: 'Keep',
    draw_mode_restore_clear: 'Clear',
    draw_mode_canvas_title: 'Choose drawing mode',
    draw_mode_canvas_desc: 'Keep mode adds strokes on top of the canvas. Clear mode wipes the canvas first.',
    draw_mode_canvas_keep: 'Keep mode',
    draw_mode_canvas_clear: 'Clear mode',
    draw_mode_undo: 'Undo',
    draw_mode_color: 'Stroke color',
    draw_mode_color_custom: 'Custom color',

    // ── 工具栏说明 ────────────────────────────────────────────────────────────
    toolbar_title: 'Toolbar Guide',
    toolbar_analyze: 'Analyze Canvas — AI interprets current formulas',
    toolbar_export: 'Export — Generates code for Desmos',
    toolbar_clear_canvas: 'Clear Canvas — Removes all graphics',
    toolbar_clear_history: 'Clear History — Clears chat history',
    toolbar_settings: 'Settings — API Key and language configuration',
    toolbar_guide: 'Help — Opens this user guide',

    // ── 引导页 ────────────────────────────────────────────────────────────────
    onboard_title: 'Welcome to AI Desmos',
    onboard_desc: 'Your intelligent math assistant: natural language plotting, image fitting, integrals, and photo problem solving.',
    onboard_start: 'Next',
    onboard_welcome_start: 'Get Started',
    onboard_step1_title: 'User Guide',
    onboard_guide_intro: 'A quick tour of every feature — with examples and simple explanations. Reopen anytime via Help in the chat panel.',
    onboard_feat1: '🎨 Natural Language Plotting',
    onboard_feat2: '📸 Image to Formula Fitting',
    onboard_feat3: '∫ Integral Visualization',
    onboard_step2_title: 'API Configuration',
    onboard_step2_desc: 'Choose your DeepSeek API mode for the best experience.',
    onboard_mode_default: 'Use Default Key (Trial)',
    onboard_mode_default_desc: 'Good for testing, but may have rate limits.',
    onboard_mode_custom: 'Use Custom Key (Recommended)',
    onboard_mode_custom_desc: 'Enter your DeepSeek API Key for stability.',
    onboard_enter: 'Enter App',
    onboard_back: 'Back',

    // ── 上传模式选择菜单 ──────────────────────────────────────────────────────
    upload_menu_title: 'Choose Mode',
    mode_draw: 'Smart Drawing',
    mode_draw_desc: 'Outline only, fill only, or both',
    mode_solve: 'Solve Problem',
    mode_solve_desc: 'Upload a problem image, AI assists solving',

    // ── 解题模式选项 ──────────────────────────────────────────────────────────
    solve_options_title: 'Choose Solve Style',
    solve_hint: '💡 Hints Only',
    solve_hint_desc: 'Give approach and methods, no final answer',
    solve_answer: '✅ Show Answer',
    solve_answer_desc: 'Full step-by-step solution + final answer',
    solve_full: '📝 Hints + Full Solution',
    solve_full_desc: 'Approach first, then complete solution',
    solving: 'Solving, please wait...',
    solve_done: '✅ Solution complete',
    solve_fail_vision: '⚠️ Current API does not support image recognition. Please configure a vision-capable API Key in settings.',
    solve_fail: '❌ Solving failed, please try again.',
    uploading_problem: '📷 Problem image',

    // ── 试用模式 ──────────────────────────────────────────────────────────────
    trial_badge: 'Trial {used}/{limit}',
    trial_exhausted: 'Trial Exhausted',
    trial_limit_title: 'Trial Limit Reached',
    trial_limit_desc: 'The default trial mode supports up to {limit} AI calls. Configure your own DeepSeek API Key to unlock unlimited usage.',
    trial_limit_note: 'Your API Key is stored locally and never sent to any server.',
    trial_setup_key: 'Configure My API Key',
    trial_get_key: 'Get DeepSeek API Key (Free)',
    trial_close: 'Maybe Later',

    // ── 邀请码 ────────────────────────────────────────────────────────────────
    invite_code: 'Invite Code',
    invite_code_desc: 'Enter an invite code to permanently remove the trial limit on this device.',
    invite_code_placeholder: 'Enter invite code...',
    invite_code_redeem: 'Redeem',
    invite_code_success: '🎉 Valid code! Trial limit permanently removed on this device.',
    invite_code_error: '❌ Invalid invite code. Please try again.',
    invite_code_unlocked: 'Unlocked',
    invite_code_or: '— or —',

    // ── OCR 识别流程 ──────────────────────────────────────────────────────────
    ocr_recognizing: '📷 OCR recognizing, please wait...',
    ocr_analyzing: '🧠 Reading the problem image and analyzing…',
    ocr_fail: '❌ OCR failed: Make sure the image is clear and contains readable text.',
    ocr_empty: '❌ OCR found no text. Please try a clearer image.',

    // ── API 服务商设置 ────────────────────────────────────────────────────────
    settings_provider: 'API Provider',
    settings_provider_desc: 'Paste your API Key to auto-detect the provider. Supports DeepSeek, OpenAI, Claude, Gemini, Groq, OpenRouter, and more.',
    settings_detected: 'Detected',
    settings_no_key_hint: 'Without a key you can use trial quota. Paste a key to auto-detect the provider and suggested models.',
    settings_key_placeholder: 'Paste your API Key — provider will be auto-detected…',
    settings_model: 'Model',
    settings_key_label: 'API Key',
    settings_key_placeholder_ds: 'sk-... (DeepSeek Key)',
    settings_key_placeholder_oai: 'sk-... (OpenAI Key)',
    settings_key_note: 'Key is stored locally and never uploaded to any server.',
    settings_save: 'Save',
    settings_reset: 'Restore Default',
    settings_saved_ok: '✅ Configuration saved',
    settings_reset_ok: 'Default configuration restored',

    // ── DeepSeek 获取教程 ────────────────────────────────────────────────────
    tut_ds_title: 'How to Get DeepSeek API Key',
    tut_ds_1: 'Visit platform.deepseek.com and log in',
    tut_ds_2: 'Click "API Keys" in the left menu',
    tut_ds_3: 'Click "Create API Key" and enter a name',
    tut_ds_4: 'Copy the generated Key (starts with sk-)',
    tut_ds_5: 'Paste into the input box below and save',
    tut_ds_note: '💡 DeepSeek offers pay-as-you-go balance, with free credits for new users, offering great value.',

    // ── OpenAI 获取教程 ──────────────────────────────────────────────────────
    tut_oai_title: 'How to Get OpenAI API Key',
    tut_oai_1: 'Visit platform.openai.com and log in',
    tut_oai_2: 'Click "API keys" on the left',
    tut_oai_3: 'Click "Create new secret key"',
    tut_oai_4: 'Copy the generated Key (only shown once!)',
    tut_oai_5: 'Go to "Billing" to add payment method',
    tut_oai_6: 'Paste into the input box below and save',
    tut_oai_note: '💡 Recommend choosing gpt-4o-mini for speed and low cost. gpt-4o is more powerful but more expensive.',
    tut_visit: 'Visit Website →',

    // ── Claude (Anthropic) 获取教程 ─────────────────────────────────────────
    tut_claude_title: 'How to Get Claude (Anthropic) API Key',
    tut_claude_1: 'Visit console.anthropic.com and log in',
    tut_claude_2: 'Click "API Keys" in the left menu',
    tut_claude_3: 'Click "Create Key" and enter a name',
    tut_claude_4: 'Copy the generated Key (starts with sk-ant-)',
    tut_claude_5: 'Paste into the input box below and save',
    tut_claude_note: '💡 Claude is billed by token with free credits for new users. claude-3-5-sonnet offers the best value; Opus is the most powerful.',
    settings_key_placeholder_claude: 'sk-ant-... (Anthropic Key)',

    // ── Claude 长手模式 ───────────────────────────────────────────────────────
    claude_long_hand: 'Long Hand (Computer Use)',
    claude_long_hand_desc: 'Let Claude browse, search, and control web pages like a human. When enabled, Claude can receive page screenshots and issue click/type commands.',
    claude_long_hand_cloud_note: '⚡ Cloud only · Requires backend proxy deployment',
    claude_long_hand_sim_mode: 'Currently in simulation mode — Claude describes action steps but does not execute them. Deploy a backend to unlock full functionality.',
    claude_long_hand_badge: '🖐️ Long Hand',
    claude_long_hand_on: 'Enabled',
    claude_long_hand_off: 'Disabled',

    // ── Desmos 加载屏幕 ───────────────────────────────────────────────────────
    loading_title: 'Loading Desmos...',
    loading_desc: 'Starting math engine, please wait',
    loading_error_title: 'Loading Failed',
    loading_error_desc: 'Could not load Desmos API component',
    loading_error_tip1: 'Check your network connection',
    loading_error_tip2: 'Confirm access to www.desmos.com',
    loading_error_tip3: 'Try disabling VPN or proxy',
    loading_retry: 'Retry',

    // ── 训练数据（Few-Shot 学习）─────────────────────────────────────────────
    training_title: 'Training Data',
    training_desc: 'Add example Q&A pairs into the AI system prompt as references. The app does NOT forcibly rewrite AI replies afterward — teach better answers with good examples.',
    training_add: 'Add Example',
    training_question: 'User Question',
    training_answer: 'Standard Answer',
    training_question_placeholder: 'e.g. Draw a circle with radius 3',
    training_answer_placeholder: 'e.g. negative integral: f(x)\\le y\\le 0; <DESMOS>f(x)=-x^2</DESMOS><DESMOS>f(x)\\le y\\le 0\\left\\{0\\le x\\le 1\\right\\}</DESMOS><DESMOS>\\int_{0}^{1} (-x^2) dx</DESMOS>',
    training_save: 'Save',
    training_cancel: 'Cancel',
    training_delete: 'Delete',
    training_empty: 'No training data yet. Click the button above to add example Q&A pairs.',
    training_count: '{count} training examples',
    training_delete_confirm: 'Delete this training example?',
    training_imported: 'Imported {count} training examples',
    training_export: 'Export',
    training_import: 'Import',
  }
};

// ─── useLanguage Hook ────────────────────────────────────────────────────────

/**
 * useLanguage
 *
 * 【什么是 Hook？】
 * Hook 是 React 提供的特殊函数，以 "use" 开头。
 * 它让函数式组件能够使用 React 的特性（如状态管理、副作用）。
 *
 * 【这个 Hook 做什么？】
 * 在组件中调用 useLanguage()，就能得到：
 *   - language：当前语言（'zh' 或 'en'）
 *   - setLanguage：切换语言的函数
 *   - t：翻译函数，传入 key 返回当前语言的文字
 *
 * 【使用方法示例】
 * const { language, setLanguage, t } = useLanguage();
 * console.log(t('title')); // 中文时输出 "AI Desmos"，英文时也是 "AI Desmos"
 * console.log(t('save_config')); // 中文时输出 "保存配置"
 */
/** Reply language: any Chinese character → zh, otherwise en */
export const detectReplyLanguage = (text: string): Language => {
  return /[\u4e00-\u9fa5]/.test(text) ? 'zh' : 'en';
};

export const useLanguage = () => {

  // useState 声明一个状态变量 language，初始值为 'en'（英文）
  // 等用户的 localStorage 数据加载后，会根据保存的偏好更新
  const [language, setLanguage] = useState<Language>('en');

  // useEffect 在组件首次渲染后执行一次
  // 作用：从 localStorage 读取上次保存的语言偏好，并恢复它
  useEffect(() => {
    // 尝试从浏览器本地存储中读取语言设置
    const saved = localStorage.getItem('desmos_language');

    // 如果读取到了有效的语言代码，就应用它
    if (saved && (saved === 'zh' || saved === 'en')) {
      setLanguage(saved as Language); // 类型断言：告诉 TypeScript 这是有效的 Language 类型
    }
  }, []); // 第二个参数 [] 表示"只在组件挂载时执行一次"

  /**
   * changeLanguage — 切换语言并持久化保存
   *
   * 不直接使用 setLanguage，而是包装了一层，
   * 确保每次切换语言时都自动保存到 localStorage。
   *
   * @param lang - 要切换到的语言代码
   */
  const changeLanguage = (lang: Language) => {
    setLanguage(lang);                                  // 更新 React 状态（触发界面重新渲染）
    localStorage.setItem('desmos_language', lang);       // 保存到浏览器本地存储（持久化）
  };

  /**
   * t（translate 的缩写）— 翻译函数
   *
   * 核心用法：t('key') 返回当前语言下 key 对应的文字。
   * 支持参数替换：t('trial_badge', { used: '1', limit: '3' })
   *   会把文字中的 {used} 替换成 '1'，{limit} 替换成 '3'。
   *
   * @param key    - 翻译词典中的键名（必须是 translations['zh'] 中存在的键）
   * @param params - 可选，用于替换文字中的 {placeholder}
   * @returns 当前语言下的翻译文字
   */
  const t = (key: keyof typeof translations['zh'], params?: Record<string, string>) => {
    let text = translations[language][key] || translations['zh'][key] || String(key);

    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      });
    }

    return text;
  };

  // 返回三个东西给调用者使用
  return { language, setLanguage: changeLanguage, t };
};
