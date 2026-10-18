import { EmojiPicker } from '@/components/emoji-picker';
import type { TEmojiItem } from '@/components/tiptap-input/types';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import { MessageSquare, Pencil, Pin, PinOff, Reply, Smile, Trash } from 'lucide-react';
import { memo } from 'react';

/**
 * Hover-revealed action chip bar that sits above a message. Shared
 * between channels and DMs — the visual treatment, animation, and
 * keyboard-friendliness are identical, only the callbacks differ.
 *
 * Each `can*` flag controls whether a chip is rendered. The consumer
 * is responsible for computing those flags (channels use Permission
 * checks via `useCan()`; DMs use sender-vs-recipient + own-channel
 * rules). Keeping the gate in the consumer means this primitive
 * stays free of tRPC, Redux, or permission imports.
 *
 * `canCreateThread` and `onCreateThread` are optional because DMs
 * don't thread — omit them in that consumer and the button doesn't
 * render at all.
 */
type TMessageActionsProps = {
  // State
  pinned: boolean;
  editable: boolean;
  hasThread?: boolean;
  // Visibility flags
  canEdit: boolean;
  canDelete: boolean;
  canPin: boolean;
  canReact: boolean;
  canReply?: boolean; // defaults to true; opt out for read-only contexts
  canCreateThread?: boolean;
  // Handlers
  onEdit: () => void;
  onDelete: () => Promise<void> | void;
  onReply: () => void;
  onTogglePin: () => Promise<void> | void;
  onCreateThread?: () => Promise<void> | void;
  onEmojiReact: (emoji: TEmojiItem) => Promise<void> | void;
  // Optional: lock the create-thread button while a request is in
  // flight. Channels track this themselves; DMs don't need it.
  creatingThread?: boolean;
};

const MessageActions = memo(
  ({
    pinned,
    editable,
    hasThread,
    canEdit,
    canDelete,
    canPin,
    canReact,
    canReply = true,
    canCreateThread,
    onEdit,
    onDelete,
    onReply,
    onTogglePin,
    onCreateThread,
    onEmojiReact,
    creatingThread
  }: TMessageActionsProps) => {
    const showThreadButton = canCreateThread && !hasThread && !!onCreateThread;

    // Hover devices: visibility uses opacity + pointer-events instead of
    // `hidden`/`flex` so the bar's flex layout — and the emoji-picker
    // trigger's bounding box — is always present. With `display:none` on
    // close, the trigger had a zero rect and Radix snapped the popover to
    // (0,0) for one paint frame before unmount.
    //
    // Touch (hover: none): there is no hover, so the bar is shown for the
    // ONE tapped row only (`data-actions-open`, active-message-store) and
    // rendered IN FLOW under the message instead of floating over the
    // row above — a floating bar on every row covered the text. The row
    // stays active while the picker is open, so the anchor never vanishes
    // under an open popover.
    return (
      <div
        data-testid="message-actions"
        className={cn(
          'absolute right-4 -top-4 z-10 flex h-8 items-center gap-0.5 rounded-lg border border-border/60 bg-popover/95 p-0.5 shadow-md backdrop-blur-sm transition-opacity duration-150',
          'opacity-0 pointer-events-none group-hover-or-active:opacity-100 group-hover-or-active:pointer-events-auto [&:has([data-state=open])]:opacity-100 [&:has([data-state=open])]:pointer-events-auto',
          '[@media(hover:none)]:static [@media(hover:none)]:mt-1 [@media(hover:none)]:ml-auto [@media(hover:none)]:w-fit [@media(hover:none)]:hidden group-hover-or-active:flex',
          '[&_button[data-slot=icon-button]]:rounded-md [&_button[data-slot=icon-button]]:p-1 [&_button[data-slot=icon-button]]:transition-colors [&_button[data-slot=icon-button]:hover]:bg-accent/60'
        )}
      >
        {canEdit && (
          <IconButton
            size="sm"
            variant="ghost"
            icon={Pencil}
            onClick={onEdit}
            disabled={!editable}
            title="Edit Message"
          />
        )}
        {canDelete && (
          <IconButton
            size="sm"
            variant="ghost"
            icon={Trash}
            onClick={onDelete}
            title="Delete Message"
          />
        )}
        {canPin && (
          <IconButton
            size="sm"
            variant="ghost"
            icon={pinned ? PinOff : Pin}
            onClick={onTogglePin}
            title={pinned ? 'Unpin Message' : 'Pin Message'}
          />
        )}
        {canReply && (
          <IconButton
            size="sm"
            variant="ghost"
            icon={Reply}
            onClick={onReply}
            title="Reply"
          />
        )}
        {showThreadButton && (
          <IconButton
            size="sm"
            variant="ghost"
            icon={MessageSquare}
            onClick={onCreateThread}
            disabled={!!creatingThread}
            title="Create Thread"
          />
        )}
        {canReact && (
          <EmojiPicker onEmojiSelect={onEmojiReact}>
            <IconButton
              size="sm"
              variant="ghost"
              icon={Smile}
              title="Add Reaction"
            />
          </EmojiPicker>
        )}
      </div>
    );
  }
);

MessageActions.displayName = 'MessageActions';

export { MessageActions };
