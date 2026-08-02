import React from 'react';
import {
  Pen, Sigma, ImageIcon, Eye, Share, Wrench, Lightbulb, RefreshCcw, PaintBucket,
  GraduationCap, Pencil, ScanEye, Trash2, MessageSquareX, Settings, BookOpen,
} from 'lucide-react';
import { useLanguage } from '../lib/i18n';

type UserGuideContentProps = {
  compact?: boolean;
  showFooter?: boolean;
};

const GuideBlock = ({
  icon,
  iconBg,
  border,
  gradient,
  title,
  desc,
  how,
  examples,
  principle,
  steps,
  tips,
  compact,
}: {
  icon: React.ReactNode;
  iconBg: string;
  border: string;
  gradient: string;
  title: string;
  desc: string;
  how?: string;
  examples?: readonly string[];
  principle?: string;
  steps?: readonly string[];
  tips?: readonly string[];
  compact?: boolean;
}) => {
  const { t } = useLanguage();
  const pad = compact ? 'p-4' : 'p-5';
  const textSize = compact ? 'text-xs' : 'text-sm';

  return (
    <section className={`bg-gradient-to-br ${gradient} rounded-2xl ${pad} border ${border}`}>
      <h4 className={`flex items-center gap-2.5 text-gray-900 font-semibold m-0 mb-2 ${compact ? 'text-sm' : ''}`}>
        <span className={`w-8 h-8 rounded-lg ${iconBg} text-white flex items-center justify-center shadow-sm shrink-0`}>
          {icon}
        </span>
        {title}
      </h4>
      <p className={`${textSize} text-gray-600 m-0 mb-2.5 leading-relaxed`}>{desc}</p>
      {how && (
        <div className="mb-2">
          <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 m-0 mb-0.5">{t('guide_how')}</p>
          <p className={`${textSize} text-gray-700 m-0 leading-relaxed`}>{how}</p>
        </div>
      )}
      {examples && examples.length > 0 && (
        <div className="mb-2">
          <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 m-0 mb-1">{t('guide_example')}</p>
          <div className="flex flex-wrap gap-1.5">
            {examples.map(key => (
              <span key={key} className="inline-block px-2 py-0.5 bg-white/80 rounded-full text-[11px] text-gray-700 border border-white/60">
                {t(key)}
              </span>
            ))}
          </div>
        </div>
      )}
      {tips && tips.length > 0 && (
        <ul className="space-y-1 m-0 p-0 list-none mb-2">
          {tips.map(key => (
            <li key={key} className={`flex items-start gap-2 ${textSize} text-gray-600`}>
              <span className="text-emerald-500 mt-0.5 shrink-0">&#x2022;</span>
              {t(key)}
            </li>
          ))}
        </ul>
      )}
      {steps && steps.length > 0 && (
        <div className="bg-white/70 rounded-xl p-3 border border-white/60 space-y-1 mb-2">
          {steps.map(key => (
            <p key={key} className="text-xs text-gray-600 m-0">{t(key)}</p>
          ))}
        </div>
      )}
      {principle && (
        <div className="mt-2 pt-2 border-t border-white/50">
          <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 m-0 mb-0.5">{t('guide_principle')}</p>
          <p className={`${textSize} text-gray-600 m-0 leading-relaxed`}>{principle}</p>
        </div>
      )}
    </section>
  );
};

export const UserGuideContent: React.FC<UserGuideContentProps> = ({ compact, showFooter }) => {
  const { t } = useLanguage();
  const gap = compact ? 'space-y-4' : 'space-y-6';

  return (
    <div className={gap}>
      {!compact && (
        <p className="text-sm text-gray-600 m-0 leading-relaxed">{t('onboard_guide_intro')}</p>
      )}

      <GuideBlock
        compact={compact}
        icon={<Pen size={16} />}
        iconBg="bg-blue-500"
        border="border-blue-100"
        gradient="from-blue-50 to-indigo-50"
        title={t('smart_draw')}
        desc={t('smart_draw_desc')}
        how={t('smart_draw_how')}
        examples={['smart_draw_tip1', 'smart_draw_tip2', 'smart_draw_tip3', 'smart_draw_tip4', 'smart_draw_tip5']}
        principle={t('smart_draw_principle')}
      />

      <GuideBlock
        compact={compact}
        icon={<ImageIcon size={16} />}
        iconBg="bg-emerald-500"
        border="border-emerald-100"
        gradient="from-emerald-50 to-teal-50"
        title={t('image_fitting')}
        desc={t('image_fitting_desc')}
        how={t('image_fitting_how')}
        tips={['image_fitting_tip1', 'image_fitting_tip2', 'image_fitting_tip3', 'image_fitting_tip4']}
        principle={t('image_fitting_principle')}
      />

      <GuideBlock
        compact={compact}
        icon={<Sigma size={16} />}
        iconBg="bg-purple-500"
        border="border-purple-100"
        gradient="from-purple-50 to-pink-50"
        title={t('integral_vis')}
        desc={t('integral_desc')}
        how={t('integral_how')}
        examples={['integral_tip1', 'integral_tip2', 'integral_tip3']}
        principle={t('integral_principle')}
      />

      <GuideBlock
        compact={compact}
        icon={<PaintBucket size={16} />}
        iconBg="bg-fuchsia-500"
        border="border-fuchsia-100"
        gradient="from-fuchsia-50 to-pink-50"
        title={t('region_fill')}
        desc={t('region_fill_desc')}
        how={t('region_fill_how')}
        examples={['region_fill_tip1', 'region_fill_tip2', 'region_fill_tip3']}
        principle={t('region_fill_principle')}
      />

      <GuideBlock
        compact={compact}
        icon={<GraduationCap size={16} />}
        iconBg="bg-rose-500"
        border="border-rose-100"
        gradient="from-rose-50 to-orange-50"
        title={t('solve_problem')}
        desc={t('solve_problem_desc')}
        how={t('solve_problem_how')}
        examples={['solve_problem_example1', 'solve_problem_example2']}
        principle={t('solve_problem_principle')}
      />

      <GuideBlock
        compact={compact}
        icon={<Pencil size={16} />}
        iconBg="bg-violet-500"
        border="border-violet-100"
        gradient="from-violet-50 to-purple-50"
        title={t('hand_draw')}
        desc={t('hand_draw_desc')}
        how={t('hand_draw_how')}
        principle={t('hand_draw_principle')}
      />

      <GuideBlock
        compact={compact}
        icon={<Eye size={16} />}
        iconBg="bg-amber-500"
        border="border-amber-100"
        gradient="from-amber-50 to-orange-50"
        title={t('canvas_analysis')}
        desc={t('canvas_analysis_desc')}
        how={t('canvas_analysis_how')}
        examples={['canvas_analysis_example']}
        principle={t('canvas_analysis_principle')}
      />

      <GuideBlock
        compact={compact}
        icon={<Share size={16} />}
        iconBg="bg-cyan-500"
        border="border-cyan-100"
        gradient="from-cyan-50 to-sky-50"
        title={t('export_title')}
        desc={t('export_desc')}
        steps={['export_step1', 'export_step2', 'export_step3', 'export_step4']}
      />

      <section className={`bg-gradient-to-br from-slate-50 to-gray-50 rounded-2xl ${compact ? 'p-4' : 'p-5'} border border-slate-200`}>
        <h4 className={`flex items-center gap-2.5 text-gray-900 font-semibold m-0 mb-3 ${compact ? 'text-sm' : ''}`}>
          <span className="w-8 h-8 rounded-lg bg-slate-600 text-white flex items-center justify-center shadow-sm shrink-0">
            <Wrench size={16} />
          </span>
          {t('toolbar_title')}
        </h4>
        <div className="space-y-2">
          {[
            { icon: <ScanEye size={14} />, key: 'toolbar_analyze' as const, color: 'text-blue-500' },
            { icon: <Share size={14} />, key: 'toolbar_export' as const, color: 'text-green-500' },
            { icon: <Trash2 size={14} />, key: 'toolbar_clear_canvas' as const, color: 'text-red-500' },
            { icon: <MessageSquareX size={14} />, key: 'toolbar_clear_history' as const, color: 'text-gray-500' },
            { icon: <Settings size={14} />, key: 'toolbar_settings' as const, color: 'text-orange-500' },
            { icon: <BookOpen size={14} />, key: 'toolbar_guide' as const, color: 'text-blue-600' },
          ].map(item => (
            <div key={item.key} className="flex items-center gap-2.5 text-xs text-gray-600">
              <span className={`${item.color} shrink-0`}>{item.icon}</span>
              {t(item.key)}
            </div>
          ))}
        </div>
      </section>

      <section className={`bg-gradient-to-br from-yellow-50 to-lime-50 rounded-2xl ${compact ? 'p-4' : 'p-5'} border border-yellow-100`}>
        <h4 className={`flex items-center gap-2.5 text-gray-900 font-semibold m-0 mb-3 ${compact ? 'text-sm' : ''}`}>
          <span className="w-8 h-8 rounded-lg bg-yellow-500 text-white flex items-center justify-center shadow-sm shrink-0">
            <Lightbulb size={16} />
          </span>
          {t('tips_title')}
        </h4>
        <ul className="space-y-1.5 m-0 p-0 list-none">
          {(['tip_enter', 'tip_context', 'tip_clear_canvas', 'tip_api_key', 'tip_lang'] as const).map(key => (
            <li key={key} className="flex items-start gap-2 text-xs text-gray-600">
              <span className="text-yellow-500 mt-0.5 shrink-0">&#x2022;</span>
              {t(key)}
            </li>
          ))}
        </ul>
      </section>

      <GuideBlock
        compact={compact}
        icon={<RefreshCcw size={16} />}
        iconBg="bg-indigo-500"
        border="border-indigo-100"
        gradient="from-indigo-50 to-violet-50"
        title={t('theory_title')}
        desc={t('theory_desc')}
        steps={['theory_step1', 'theory_step2', 'theory_step3']}
      />

      {showFooter && (
        <div className="pt-4 pb-2 border-t border-gray-100 text-center">
          <p className="text-xs text-gray-400 m-0">AI Desmos v2.0</p>
          <p className="text-[10px] text-gray-400 m-0 mt-1">{t('copyright')}</p>
        </div>
      )}
    </div>
  );
};
