import { ReplyContentPreview } from '@/components/channel-view/text/reply-content-preview';
import { useUserById } from '@/features/server/users/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { memo, useCallback } from 'react';

/**
 * Inline preview that sits above a message when it's a reply. Used
 * by both channel messages and DM messages — same shape, same
 * styling.
 *
 * Visual: a 2px primary-color vertical bar (the universal "this is
 * quoted material" signal) followed by the replied-to author and a
 * truncated content preview. Replaces the older rotated reply-arrow
 * icon — the bar carries the meaning without an icon.
 *
 * `onJumpTo` is provided by the consumer because the scroll
 * mechanism differs between channels (`useScrollToMessage`) and
 * DMs (different scroll controller). Keeping the jump out of this
 * component keeps it agnostic.
 */
type TReplyPreviewProps = {
  replyTo: {
    id: number;
    userId: number;
    content: string | null;
    hasFiles?: boolean;
  };
  onJumpTo: (messageId: number) => void;
};

const ReplyPreview = memo(({ replyTo, onJumpTo }: TReplyPreviewProps) => {
  const user = useUserById(replyTo.userId);
  const handleClick = useCallback(
    () => onJumpTo(replyTo.id),
    [onJumpTo, replyTo.id]
  );

  return (
    <button
      type="button"
      onClick={handleClick}
      className="group flex items-center gap-2 text-xs mb-0.5 cursor-pointer text-left"
    >
      <span className="w-[2px] h-3.5 self-stretch rounded-full bg-primary/40 group-hover:bg-primary/70 shrink-0 transition-colors" />
      <span className="font-semibold text-muted-foreground/90 group-hover:text-foreground transition-colors shrink-0">
        {getDisplayName(user)}
      </span>
      <span className="truncate text-muted-foreground/70 max-w-[300px]">
        {replyTo.content ? (
          <ReplyContentPreview content={replyTo.content} />
        ) : replyTo.hasFiles ? (
          'Attachment'
        ) : (
          'Message deleted'
        )}
      </span>
    </button>
  );
});

ReplyPreview.displayName = 'ReplyPreview';

export { ReplyPreview };
