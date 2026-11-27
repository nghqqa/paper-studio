import { Languages } from 'lucide-react'
import { useI18n } from '@/lib/i18n'

export function LanguageToggle({ className }: { className?: string }) {
  const { locale, toggleLocale, t } = useI18n()
  return (
    <button
      type="button"
      onClick={toggleLocale}
      data-testid="locale-toggle"
      aria-label={locale === 'zh-CN' ? 'Switch interface language to English' : '切换为简体中文界面'}
      title={locale === 'zh-CN' ? '切换界面语言 (中文 / EN)' : 'Switch Language (EN / 中文)'}
      className={
        className ??
        'inline-flex h-7 items-center gap-1 rounded border border-border bg-panel px-2 text-xs text-fg-muted hover:bg-hover hover:text-fg'
      }
    >
      <Languages aria-hidden className="size-3.5" />
      <span>{t('locale.switch_label')}</span>
    </button>
  )
}
