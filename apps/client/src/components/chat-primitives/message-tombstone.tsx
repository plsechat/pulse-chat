import { Tooltip } from '@/components/ui/tooltip';
import type { TTombstoneAudit } from '@/features/tombstone';
import { fullDateTime, timeOnly } from '@/helpers/time-format';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { memo } from 'react';

/**
 * The body of a deleted message: an italic muted "Message deleted" in
 * the row's place, with the audit line ("deleted by <name> · <time>")
 * only when the caller resolved one (features/tombstone.ts decides
 * who may see it). Screen readers get the row's nature before the
 * label, since the row has lost its author's text.
 */
const MessageTombstone = memo(
  ({
    audit,
    className
  }: {
    audit: TTombstoneAudit | null;
    className?: string;
  }) => (
    <p
      className={cn(
        'text-sm italic text-muted-foreground/70 select-none',
        className
      )}
    >
      <span className="sr-only">deleted message</span>
      <span>Message deleted</span>
      {audit && (
        <Tooltip content={format(new Date(audit.deletedAt), fullDateTime())}>
          <span className="not-italic text-xs text-muted-foreground/60">
            {' · '}
            {audit.deleterName ? `deleted by ${audit.deleterName}` : 'deleted'}
            {' · '}
            {format(new Date(audit.deletedAt), timeOnly())}
          </span>
        </Tooltip>
      )}
    </p>
  )
);

MessageTombstone.displayName = 'MessageTombstone';

export { MessageTombstone };
