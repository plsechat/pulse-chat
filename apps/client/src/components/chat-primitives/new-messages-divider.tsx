import { memo } from 'react';

/**
 * Marker that sits before the first unread message when the user
 * scrolls into a position where they have unread messages. Lives in
 * shared chat-primitives because both channel and DM views should
 * paint it the same way (currently only the channel view consumes
 * it; DM unread plumbing arrives later).
 *
 * The id `new-messages-divider` is hooked by scroll-into-view logic
 * in the channel view — keep it stable.
 */
const NewMessagesDivider = memo(() => (
  <div className="flex items-center gap-3 px-4 py-1" id="new-messages-divider">
    <div className="flex-1 h-px bg-destructive/40" />
    <span className="text-[10px] font-semibold text-destructive/90 shrink-0 uppercase tracking-wider px-2 py-0.5 rounded-full bg-destructive/10 ring-1 ring-destructive/30">
      New messages
    </span>
    <div className="flex-1 h-px bg-destructive/40" />
  </div>
));

NewMessagesDivider.displayName = 'NewMessagesDivider';

export { NewMessagesDivider };
