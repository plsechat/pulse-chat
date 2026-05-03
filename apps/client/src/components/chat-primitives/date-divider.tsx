import { format, isToday, isYesterday } from 'date-fns';
import { memo } from 'react';

/**
 * Day-marker that sits between message groups when the day rolls
 * over (`Today` / `Yesterday` / `Apr 30, 2026`). Used by both the
 * channel view and the DM view — same shape, same component, no
 * channel-specific assumptions.
 *
 * Visual rhythm: a hairline rule running through the column with a
 * soft pill carrying the label. Reads as a deliberate marker
 * instead of a footer separator.
 */
const DateDivider = memo(({ timestamp }: { timestamp: number }) => {
  const date = new Date(timestamp);
  const label = isToday(date)
    ? 'Today'
    : isYesterday(date)
      ? 'Yesterday'
      : format(date, 'MMMM d, yyyy');

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="flex-1 h-px bg-border/60" />
      <span className="text-[11px] font-medium text-muted-foreground/80 shrink-0 px-2.5 py-0.5 rounded-full bg-muted/60 ring-1 ring-border/40">
        {label}
      </span>
      <div className="flex-1 h-px bg-border/60" />
    </div>
  );
});

DateDivider.displayName = 'DateDivider';

export { DateDivider };
