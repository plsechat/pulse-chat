import { TypingDots } from '@/components/typing-dots';
import { memo, type ReactNode } from 'react';

/**
 * The typing row, shared by channels and DMs. Presentational only —
 * each surface resolves its own typing user names (channel via the
 * ambient roster, DM via the home roster) and passes the first one or
 * two plus the total count (only the first two are ever named, so the
 * DM side needn't resolve more than that). Renders the fixed-height
 * idle placeholder when nobody is typing so the message list doesn't
 * jump.
 */
const bold = (name: string): ReactNode => <strong>{name}</strong>;

const TypingIndicator = memo(({
  names,
  total
}: {
  names: string[];
  total: number;
}) => {
  if (total === 0) {
    return <div className="h-6" />;
  }

  return (
    <div className="flex h-6 items-center gap-2 px-4 text-xs text-muted-foreground">
      <TypingDots />
      <span>
        {total === 1 ? (
          <>{bold(names[0] ?? 'Someone')} is typing...</>
        ) : total === 2 ? (
          <>
            {bold(names[0] ?? 'Someone')} and {bold(names[1] ?? 'someone')} are
            typing...
          </>
        ) : (
          <>
            {bold(names[0] ?? 'Someone')} and {total - 1} others are typing...
          </>
        )}
      </span>
    </div>
  );
});

TypingIndicator.displayName = 'TypingIndicator';

export { TypingIndicator };
