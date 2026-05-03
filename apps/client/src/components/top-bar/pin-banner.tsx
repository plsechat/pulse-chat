import { MessageRenderer } from '@/components/channel-view/text/renderer';
import { useUserById } from '@/features/server/users/hooks';
import { useSelectedChannel } from '@/features/server/channels/hooks';
import { stripToPlainText } from '@/helpers/strip-to-plain-text';
import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedMessage } from '@pulse/shared';
import { ChevronDown, ChevronUp, Pin } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';

/**
 * Slim banner under the channel header that surfaces the most recently
 * pinned message in the current channel. Truncated by default; clicking
 * toggles between the truncated row and a full inline preview. If
 * multiple pinned messages exist only the latest is shown — the user
 * still has the Pin icon in the top bar for the full list.
 *
 * The banner re-fetches whenever a pin/unpin event fires so the view
 * stays in sync with the existing pinned-messages-panel popover.
 */
const PinBanner = memo(() => {
  const channel = useSelectedChannel();
  const channelId = channel?.id;
  const isTextChannel = channel?.type === 'TEXT';

  const [latest, setLatest] = useState<TJoinedMessage | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchLatest = useCallback(async () => {
    if (!channelId || !isTextChannel) return;
    const trpc = getTRPCClient();
    if (!trpc) return;
    try {
      const messages = await trpc.messages.getPinned.query({ channelId });
      if (messages.length === 0) {
        setLatest(null);
        return;
      }
      // Server returns pinned messages in createdAt order — pick the
      // newest by id so a manually-resorted backfill doesn't fool us.
      const newest = [...messages].sort((a, b) => b.id - a.id)[0];
      setLatest(newest);
    } catch {
      setLatest(null);
    }
  }, [channelId, isTextChannel]);

  useEffect(() => {
    setExpanded(false);
    fetchLatest();
  }, [fetchLatest]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.channelId === channelId) {
        fetchLatest();
      }
    };
    window.addEventListener('pinned-messages-changed', handler);
    return () =>
      window.removeEventListener('pinned-messages-changed', handler);
  }, [channelId, fetchLatest]);

  const author = useUserById(latest?.userId ?? -1);

  if (!latest || !isTextChannel) return null;

  const previewText = latest.content
    ? stripToPlainText(latest.content)
    : latest.files.length > 0
      ? 'Attachment'
      : '';

  return (
    <div className="hidden md:flex flex-col border-b border-border/60 bg-muted/30">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-2 px-4 py-1.5 text-xs text-left hover:bg-muted/60 transition-colors cursor-pointer"
        title={expanded ? 'Collapse pinned message' : 'Expand pinned message'}
      >
        <Pin className="h-3 w-3 text-yellow-500 shrink-0" />
        <span className="font-semibold text-foreground/80 shrink-0">
          {author?.name ?? 'Pinned'}
        </span>
        <span className="text-muted-foreground/80 truncate min-w-0 flex-1">
          {previewText || 'Pinned message'}
        </span>
        {expanded ? (
          <ChevronUp className="h-3 w-3 text-muted-foreground/60 shrink-0" />
        ) : (
          <ChevronDown className="h-3 w-3 text-muted-foreground/60 shrink-0" />
        )}
      </button>
      {expanded && (
        // The same renderer hosts attachments and embeds, so apply the
        // same width-clamping rules the pinned-messages-panel uses to
        // stop wide images from breaking the banner layout.
        <div className="px-4 pb-2 text-sm overflow-x-hidden [&_img]:max-w-full [&_img]:h-auto [&_video]:max-w-full">
          <MessageRenderer message={latest} />
        </div>
      )}
    </div>
  );
});

export { PinBanner };
