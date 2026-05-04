import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { memo } from 'react';

/**
 * Right-aligned Cancel + Save button pair that lives at the bottom
 * of every settings form. Replaces 8+ near-identical inline copies
 * across `components/server-screens/`. Centralizing means a future
 * tweak to spacing, button order, or a destructive-state variant
 * lands once.
 *
 * Defaults match the shape that all existing call-sites already
 * use — `Cancel` (outline) + `Save Changes` (solid). Override the
 * labels for forms that need different verbs (e.g. `Reset` /
 * `Apply`). `saving` disables Save and is intended to be the same
 * boolean a caller's `useTRPCSave`-shaped hook tracks.
 */
type TSettingsFormFooterProps = {
  onCancel: () => void;
  onSave: () => void;
  saving?: boolean;
  saveDisabled?: boolean;
  cancelLabel?: string;
  saveLabel?: string;
  className?: string;
};

const SettingsFormFooter = memo(
  ({
    onCancel,
    onSave,
    saving,
    saveDisabled,
    cancelLabel = 'Cancel',
    saveLabel = 'Save Changes',
    className
  }: TSettingsFormFooterProps) => {
    return (
      <div className={cn('flex justify-end gap-2 pt-4', className)}>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          {cancelLabel}
        </Button>
        <Button onClick={onSave} disabled={saving || saveDisabled}>
          {saveLabel}
        </Button>
      </div>
    );
  }
);

SettingsFormFooter.displayName = 'SettingsFormFooter';

export { SettingsFormFooter };
