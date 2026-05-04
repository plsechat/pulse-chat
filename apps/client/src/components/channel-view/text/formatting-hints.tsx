import { useAppearanceSettings } from '@/hooks/use-appearance-settings';
import { memo } from 'react';

const HINT_BASE =
  'inline-flex items-center px-1.5 rounded text-[11px] font-mono leading-tight text-muted-foreground/70';

/**
 * Toggleable hint bar above the message composer that shows the supported
 * markdown shortcuts, each label styled the way the rendered output will
 * look. Visibility is driven by `appearance.showFormattingHints`
 * (Settings → Appearance → Miscellaneous).
 */
const FormattingHints = memo(() => {
  const { settings } = useAppearanceSettings();
  if (!settings.showFormattingHints) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pb-1">
      <span className={`${HINT_BASE} font-bold`}>**bold**</span>
      <span className={`${HINT_BASE} italic`}>*italic*</span>
      <span className={`${HINT_BASE} underline`}>__underline__</span>
      <span className={`${HINT_BASE} line-through`}>~~strike~~</span>
      <span className={`${HINT_BASE} bg-muted/50`}>`code`</span>
      <span className={`${HINT_BASE} bg-muted/50`}>```codeblock```</span>
      <span className={`${HINT_BASE} text-primary`}>[link](url)</span>
      <span className={`${HINT_BASE} italic border-l-2 border-muted pl-1`}>
        &gt; quote
      </span>
      <span className={HINT_BASE}>- list</span>
      <span className={HINT_BASE}>1. list</span>
    </div>
  );
});

export { FormattingHints };
