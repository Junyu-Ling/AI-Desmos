/**
 * ============================================================================
 * Onboarding.tsx — 首次使用引导页（三步式引导流程）
 * ============================================================================
 *
 * 【这个组件做什么？】
 * 用户第一次打开应用时，会看到这个全屏引导页。
 * 引导结束后，在 localStorage 中写入标记，下次打开就不再显示。
 *
 * 【三个步骤】
 *   步骤 0（欢迎页）  — 展示 Logo + 应用标题 + "开始体验"按钮
 *   步骤 1（功能亮点）— 三张功能卡片，介绍核心功能
 *   步骤 2（API 配置）— 让用户选择使用试用 Key 还是自定义 Key
 *
 * 【特性】
 * - 支持中英双语切换（右上角语言切换按钮）
 * - 顶部进度条 + 底部圆点指示器（告诉用户当前在第几步）
 * - 毛玻璃 UI 风格 + 动态背景光晕效果
 * - 完成后调用父组件传来的 onComplete 回调，并写入 localStorage 标记
 */

// 导入 React 和 useState 钩子
// React    — JSX 语法必须
// useState — 管理当前步骤、API Key 输入等状态
import React, { useState } from 'react';

// 导入国际化 Hook（中英双语支持）
import { useLanguage } from '../lib/i18n';
import { detectProviderFromKey, getProviderById } from '../lib/api-providers';

// 从 lucide-react 图标库导入所需图标
// ChevronRight — 向右的箭头（"下一步"按钮）
// Zap          — 闪电图标（"快速/试用模式"）
// Check        — 对勾图标（选项已选中）
// ArrowRight   — 向右大箭头（"开始"按钮）
// ShieldCheck  — 盾牌+对勾（"安全/自定义 Key"）
// ArrowLeft    — 向左箭头（"上一步"按钮）
// MessageSquare — 消息气泡图标（智能绘图功能）
// Image        — 图片图标（图像拟合功能）
// Sigma        — Σ 数学符号图标（积分功能）
// Globe        — 地球图标（语言切换）
import { ChevronRight, Zap, Check, ArrowRight, ShieldCheck, ArrowLeft, Globe } from 'lucide-react';

import logoImg from 'figma:asset/aa5c219b747d73e46a1c35f49925cf818604e2fb.png';
import { UserGuideContent } from './UserGuideContent';

// ─── 组件 Props 接口 ──────────────────────────────────────────────────────────

/**
 * OnboardingProps — 引导组件接收的参数类型定义
 */
interface OnboardingProps {
  /**
   * onComplete — 引导流程完成后的回调函数
   * 由父组件（App.tsx）传入，引导结束后调用，用来关闭引导页并打开聊天栏
   */
  onComplete: () => void;
}

// ─── 主组件 ──────────────────────────────────────────────────────────────────

/**
 * Onboarding 组件
 * React.FC<OnboardingProps> = "React 函数组件，接收 OnboardingProps 类型的参数"
 */
export const Onboarding: React.FC<OnboardingProps> = ({ onComplete }) => {

  // 从国际化 Hook 中解构出需要的值：
  // language    — 当前语言代码（'zh' 或 'en'）
  // setLanguage — 切换语言的函数
  // t           — 翻译函数：t('key') 返回当前语言的文字
  const { language, setLanguage, t } = useLanguage();

  /**
   * step — 当前步骤状态（0、1 或 2）
   * useState(0) 表示初始值为 0（欢迎页）
   */
  const [step, setStep] = useState(0);

  /**
   * apiKeyMode — 用户在步骤 2 中选择的 API Key 模式
   * null     = 还没选
   * 'default' = 使用内置试用 Key
   * 'custom'  = 使用自定义 Key
   */
  const [apiKeyMode, setApiKeyMode] = useState<'default' | 'custom' | null>(null);

  /**
   * customKey — 用户输入的自定义 API Key
   * 只有 apiKeyMode === 'custom' 时才有意义
   */
  const [customKey, setCustomKey] = useState('');

  // ── 步骤导航函数 ───────────────────────────────────────────────────────────

  /**
   * handleNext — 前进到下一步
   * prev => prev + 1 是函数式更新：基于前一个值计算新值（更安全）
   */
  const handleNext = () => setStep(prev => prev + 1);

  /**
   * handleBack — 返回上一步
   */
  const handleBack = () => setStep(prev => prev - 1);

  /**
   * handleFinish — 完成引导
   * 1. 如果用户选择了自定义 Key 且填写了内容，保存到 localStorage
   * 2. 如果选择了试用模式，确保 localStorage 中没有旧 Key（清空）
   * 3. 写入引导完成标记
   * 4. 调用父组件的 onComplete 回调
   */
  const handleFinish = () => {
    if (apiKeyMode === 'custom' && customKey) {
      const detected =
        detectProviderFromKey(customKey)
        || (/^sk-/i.test(customKey.trim()) ? getProviderById('deepseek') : null)
        || getProviderById('deepseek')!;
      localStorage.setItem('desmos_api_key', customKey.trim());
      localStorage.setItem('desmos_api_provider', detected.id);
      localStorage.setItem('desmos_api_model', detected.defaultModel);
      localStorage.removeItem('deepseek_api_key');
      localStorage.removeItem('claude_api_key');
    } else {
      localStorage.removeItem('desmos_api_key');
      localStorage.removeItem('desmos_api_provider');
      localStorage.removeItem('desmos_api_model');
      localStorage.removeItem('deepseek_api_key');
    }

    // 写入"引导已完成"标记，下次打开应用时不再显示引导页
    localStorage.setItem('desmos_onboarding_completed', 'true');

    // 调用父组件回调，关闭引导页
    onComplete();
  };

  // ── JSX 渲染 ───────────────────────────────────────────────────────────────

  return (
    // 固定定位的全屏容器（覆盖整个视口）
    // z-[100] 确保引导页显示在所有其他内容的最上方
    // fixed inset-0 = position: fixed; top: 0; right: 0; bottom: 0; left: 0
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 font-sans overflow-hidden bg-white">

      {/* ── 渐变背景色 ──────────────────────────────────────────────────────
          from-indigo-50 via-white to-blue-50 表示从靛蓝色 → 白色 → 蓝色的对角渐变 */}
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-50 via-white to-blue-50" />

      {/* ── 装饰性脉冲光晕（右上角）──────────────────────────────────────────
          这是纯装饰的视觉效果，不可点击（pointer-events-none）
          blur-[100px] 使边缘极度模糊，形成"光晕"效果
          animate-pulse 使其周期性地淡入淡出 */}
      <div className="absolute top-[-10%] right-[-10%] w-[600px] h-[600px] bg-blue-200/30 rounded-full blur-[100px] pointer-events-none animate-pulse" />

      {/* ── 装饰性脉冲光晕（左下角）────────────────────────────────────────
          delay-700 使这个光晕的动画延迟 700ms，与右上角的错开，形成"呼吸感" */}
      <div className="absolute bottom-[-10%] left-[-10%] w-[500px] h-[500px] bg-indigo-200/30 rounded-full blur-[100px] pointer-events-none animate-pulse delay-700" />

      {/* ── 右上角语言切换按钮组 ────────────────────────────────────────────
          absolute top-5 right-5 = 绝对定位，距顶部和右边各 5 单位
          z-20 确保显示在背景层之上 */}
      <div className="absolute top-5 right-5 z-20">
        {/* 按钮容器：毛玻璃效果（半透明 + 模糊背景） */}
        <div className="flex items-center gap-1 bg-white/70 backdrop-blur border border-white/60 shadow rounded-xl p-1">
          {/* 地球图标 */}
          <Globe size={13} className="text-gray-400 ml-1.5 shrink-0" />

          {/* 英文按钮：被选中时深色背景+白字，未选中时浅色文字 */}
          <button
            onClick={() => setLanguage('en')} // 点击切换到英文
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
              language === 'en' ? 'bg-gray-900 text-white shadow-sm' : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            EN
          </button>

          {/* 中文按钮：被选中时深色背景+白字 */}
          <button
            onClick={() => setLanguage('zh')} // 点击切换到中文
            className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all ${
              language === 'zh' ? 'bg-gray-900 text-white shadow-sm' : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            中文
          </button>
        </div>
      </div>

      {/* ── 主内容卡片区域 ───────────────────────────────────────────────────
          max-w-2xl 限制最大宽度，relative z-10 确保在背景光晕之上 */}
      <div className="w-full max-w-3xl relative z-10">
        <div className="bg-white/60 backdrop-blur-xl border border-white/50 shadow-2xl rounded-3xl p-8 md:p-10 overflow-hidden relative">

          {/* ── 顶部进度条 ────────────────────────────────────────────────
              ((step + 1) / 3) * 100 计算进度百分比：
              step=0 → 33%，step=1 → 67%，step=2 → 100% */}
          <div className="absolute top-0 left-0 w-full h-1.5 bg-gray-100">
            <div
              style={{ width: `${((step + 1) / 3) * 100}%` }} // 动态宽度
              className="h-full bg-blue-600 transition-all duration-500 ease-in-out" // 平滑过渡动画
            />
          </div>

          {/* 内容区域（条件渲染：根据 step 显示不同内容） */}
          <div className="relative">

            {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                步骤 0：欢迎页
                step === 0 时才渲染这个 div（条件渲染）
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
            {step === 0 && (
              <div className="text-center py-4 animate-in fade-in slide-in-from-right-4 duration-400">
                {/* Logo 图片，带放大进场动画 */}
                <div className="w-52 h-52 mx-auto mb-8 animate-in zoom-in duration-700 delay-200">
                  <img src={logoImg} alt="AI Desmos Logo" className="w-full h-full object-contain drop-shadow-xl" />
                </div>

                {/* 标题和描述文字区域 */}
                <div className="space-y-4 mb-10">
                  {/* 主标题：渐变文字效果（text-transparent + bg-clip-text） */}
                  <h1 className="text-4xl md:text-5xl font-black tracking-tight text-gray-900 bg-clip-text text-transparent bg-gradient-to-r from-gray-900 to-gray-600">
                    {t('onboard_title')} {/* 翻译函数获取当前语言的标题 */}
                  </h1>
                  {/* 副标题描述 */}
                  <p className="text-xl text-gray-600 max-w-lg mx-auto leading-relaxed">
                    {t('onboard_desc')}
                  </p>
                </div>

                {/* "开始体验"按钮
                    group 类配合 group-hover: 实现图标随按钮悬停而移动的效果 */}
                <button
                  onClick={handleNext} // 点击进入步骤 1
                  className="group px-10 py-4 bg-gray-900 text-white text-lg font-bold rounded-2xl shadow-xl hover:shadow-2xl hover:bg-black active:scale-95 transition-all flex items-center gap-3 mx-auto"
                >
                  {t('onboard_welcome_start')}
                  {/* group-hover:translate-x-1：按钮悬停时箭头向右移动 1 个单位 */}
                  <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
                </button>
              </div>
            )}

            {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                步骤 1：功能亮点
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
            {step === 1 && (
              <div className="animate-in fade-in slide-in-from-right-4 duration-400 flex flex-col max-h-[78vh]">
                <div className="text-center mb-4 shrink-0">
                  <h2 className="text-2xl md:text-3xl font-bold text-gray-900">{t('onboard_step1_title')}</h2>
                  <p className="text-sm text-gray-500 mt-2 max-w-xl mx-auto leading-relaxed">{t('onboard_guide_intro')}</p>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1 mb-4">
                  <UserGuideContent compact />
                </div>

                <div className="flex justify-between pt-2 items-center shrink-0 border-t border-gray-100">
                  <button onClick={handleBack} className="text-gray-500 hover:text-gray-800 font-medium px-4 py-2 flex items-center gap-2 transition-colors">
                    <ArrowLeft size={16} /> {t('onboard_back')}
                  </button>
                  <button
                    onClick={handleNext}
                    className="px-8 py-3 bg-blue-600 text-white font-bold rounded-xl shadow-lg hover:bg-blue-700 active:scale-95 transition-all flex items-center gap-2"
                  >
                    {t('onboard_start')} <ChevronRight size={18} />
                  </button>
                </div>
              </div>
            )}

            {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                步骤 2：API 配置
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
            {step === 2 && (
              <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-400">
                {/* 步骤标题和说明 */}
                <div className="text-center">
                  <h2 className="text-3xl font-bold text-gray-900 mb-3">{t('onboard_step2_title')}</h2>
                  <p className="text-gray-500">{t('onboard_step2_desc')}</p>
                </div>

                {/* 两个选项卡 */}
                <div className="space-y-4 mt-6">

                  {/* ── 选项 A：使用默认试用 Key ─────────────────────────────
                      点击整个 div 即可选中（onClick 绑定到 div）
                      动态 className：选中时加蓝色边框和背景 */}
                  <div
                    onClick={() => setApiKeyMode('default')} // 点击选中"默认 Key"模式
                    className={`cursor-pointer relative p-5 rounded-2xl border-2 transition-all duration-200 group ${
                      apiKeyMode === 'default' ? 'border-blue-500 bg-blue-50/50' : 'border-gray-200 hover:border-blue-200 bg-white/50'
                    }`}
                  >
                    <div className="flex items-start gap-4">
                      {/* 圆形选中指示器：选中时填充蓝色并显示对勾 */}
                      <div className={`mt-1 w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                        apiKeyMode === 'default' ? 'bg-blue-500 border-blue-500 text-white' : 'border-gray-300 group-hover:border-blue-300'
                      }`}>
                        {/* 只有选中时才渲染对勾图标 */}
                        {apiKeyMode === 'default' && <Check size={14} strokeWidth={3} />}
                      </div>

                      {/* 文字说明区域 */}
                      <div className="flex-1">
                        {/* 选项标题：闪电图标 + 文字 */}
                        <h3 className="font-bold text-gray-900 flex items-center gap-2">
                          <Zap size={18} className="text-amber-500" fill="currentColor" /> {/* fill="currentColor" 填充颜色 */}
                          {t('onboard_mode_default')}
                        </h3>
                        {/* 选项说明 */}
                        <p className="text-sm text-gray-500 mt-1">{t('onboard_mode_default_desc')}</p>
                      </div>
                    </div>
                  </div>

                  {/* ── 选项 B：使用自定义 Key ──────────────────────────────
                      选中后会展开一个密码输入框（条件渲染） */}
                  <div
                    onClick={() => setApiKeyMode('custom')} // 点击选中"自定义 Key"模式
                    className={`cursor-pointer p-5 rounded-2xl border-2 transition-all duration-200 group ${
                      apiKeyMode === 'custom' ? 'border-green-600 bg-green-50/30' : 'border-gray-200 hover:border-green-200 bg-white/50'
                    }`}
                  >
                    <div className="flex items-start gap-4">
                      {/* 绿色选中指示器 */}
                      <div className={`mt-1 w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                        apiKeyMode === 'custom' ? 'bg-green-600 border-green-600 text-white' : 'border-gray-300 group-hover:border-green-300'
                      }`}>
                        {apiKeyMode === 'custom' && <Check size={14} strokeWidth={3} />}
                      </div>

                      <div className="flex-1">
                        {/* 选项标题：安全盾牌图标 + 文字 */}
                        <h3 className="font-bold text-gray-900 flex items-center gap-2">
                          <ShieldCheck size={18} className="text-green-600" />
                          {t('onboard_mode_custom')}
                        </h3>
                        <p className="text-sm text-gray-500 mt-1">{t('onboard_mode_custom_desc')}</p>
                      </div>
                    </div>

                    {/* API Key 输入框：只有选择了"自定义 Key"才显示
                        animate-in slide-in-from-top-2 使输入框以动画滑入 */}
                    {apiKeyMode === 'custom' && (
                      <div className="overflow-hidden pl-10 mt-3 animate-in fade-in slide-in-from-top-2 duration-300">
                        <input
                          type="password"           // 密码类型：输入内容显示为小圆点
                          value={customKey}          // 受控组件：值由 React state 控制
                          onChange={(e) => setCustomKey(e.target.value)} // 每次输入都更新 state
                          placeholder="sk-..."       // 占位提示文字
                          className="w-full px-4 py-3 bg-white border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-green-500 font-mono text-sm shadow-inner"
                          autoFocus                  // 自动聚焦（展开后立即可以打字）
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* 导航按钮行 */}
                <div className="flex justify-between pt-6 items-center">
                  {/* 上一步 */}
                  <button onClick={handleBack} className="text-gray-500 hover:text-gray-800 font-medium px-4 py-2 flex items-center gap-2 transition-colors">
                    <ArrowLeft size={16} /> {t('onboard_back')}
                  </button>

                  {/* "进入应用"按钮
                      disabled 条件：还没选模式，或者选了自定义 Key 但没填写（少于5个字符）
                      disabled 时按钮变灰且不可点击 */}
                  <button
                    onClick={handleFinish} // 点击完成引导
                    disabled={!apiKeyMode || (apiKeyMode === 'custom' && customKey.length < 5)}
                    className={`px-8 py-3 rounded-xl font-bold shadow-lg flex items-center gap-2 transition-all ${
                      !apiKeyMode || (apiKeyMode === 'custom' && customKey.length < 5)
                        ? 'bg-gray-200 text-gray-400 cursor-not-allowed shadow-none' // 禁用状态样式
                        : 'bg-gray-900 text-white hover:bg-black hover:shadow-xl active:scale-95' // 可用状态样式
                    }`}
                  >
                    {t('onboard_enter')} <ArrowRight size={18} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── 底部步骤指示器（三个圆点/胶囊） ─────────────────────────────────
            [0, 1, 2].map() 生成三个元素的数组，i 是索引（0, 1, 2）
            当前步骤：宽 8 单位（胶囊形）深色；其他步骤：宽 2 单位（圆形）浅色 */}
        <div className="mt-8 flex justify-center gap-3">
          {[0, 1, 2].map(i => (
            <div
              key={i} // React 需要列表中每个元素有唯一 key
              className={`h-2 rounded-full transition-all duration-500 ease-out ${
                i === step ? 'w-8 bg-gray-800' : 'w-2 bg-gray-300/50' // 当前步骤变成胶囊形
              }`}
            />
          ))}
        </div>

        {/* 版权信息 */}
        <p className="text-[10px] text-gray-400 text-center mt-4">{t('copyright')}</p>
      </div>
    </div>
  );
};

