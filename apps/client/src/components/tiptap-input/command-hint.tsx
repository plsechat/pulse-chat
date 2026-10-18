import { cn } from '@/lib/utils';
import { memo } from 'react';
import type { TUsageHint } from './plugins/command-palette';

type TCommandHintProps = {
  hint: TUsageHint;
};

/**
 * One line above the composer while a command's arguments are typed:
 * what has been typed, every argument it takes with the one the
 * cursor is in marked, and what the command does. A status region, so
 * a screen reader hears it when the slot changes and not on every
 * keystroke inside one.
 */
const CommandHint = memo(({ hint }: TCommandHintProps) => {
  return (
    <div
      data-testid="command-hint"
      role="status"
      className="flex min-w-0 items-center gap-x-1.5 px-1 pb-1 text-xs leading-5 text-muted-foreground"
    >
      <span className="shrink-0 font-mono text-foreground/85">{hint.head}</span>
      {hint.slots.map((slot, index) => (
        <span
          key={index}
          data-active={slot.active || undefined}
          className={cn(
            'shrink-0 font-mono',
            slot.active
              ? 'rounded-sm bg-primary/12 px-1 text-primary'
              : 'text-muted-foreground/70'
          )}
        >
          {slot.label}
        </span>
      ))}
      {hint.description && (
        <span className="min-w-0 truncate">— {hint.description}</span>
      )}
    </div>
  );
});

export { CommandHint };
