import { cn } from '@/lib/utils';
import { memo } from 'react';

/**
 * Shared layout language for settings tabs: each SECTION is one grouped
 * card (rows divided by hairlines — the border encodes "these belong
 * together"), every ROW puts the label + description on the left and
 * its control right-aligned. Controls that need width (device pickers,
 * meters, sliders) use the stacked variant instead of squeezing.
 */

const SettingsSection = memo(
  ({
    title,
    description,
    children,
    className
  }: {
    title: string;
    description?: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <section className={cn('space-y-3', className)}>
      <div>
        <h3 className="flex items-center gap-2 text-base font-semibold">
          {/* Accent tick — the section marker shared by every settings tab */}
          <span aria-hidden className="h-4 w-[3px] rounded-full bg-primary" />
          {title}
        </h3>
        {description && (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="rounded-lg border border-border bg-muted/20 divide-y divide-border/60">
        {children}
      </div>
    </section>
  )
);

const SettingRow = memo(
  ({
    label,
    description,
    children
  }: {
    label: string;
    description?: string;
    children: React.ReactNode;
  }) => (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <div className="text-xs text-muted-foreground">{description}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
);

/** Row whose control needs the full width (device pickers, meters). */
const SettingRowStack = memo(
  ({
    label,
    description,
    children
  }: {
    label: string;
    description?: string;
    children: React.ReactNode;
  }) => (
    <div className="space-y-2 px-4 py-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <div className="text-xs text-muted-foreground">{description}</div>
        )}
      </div>
      {children}
    </div>
  )
);

export { SettingRow, SettingRowStack, SettingsSection };
