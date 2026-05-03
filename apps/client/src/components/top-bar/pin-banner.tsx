import { MessageRenderer } from '@/components/channel-view/text/renderer';
import { PinBannerShell } from '@/components/chat-primitives/pin-banner-shell';
import { useSelectedChannel } from '@/features/server/channels/hooks';
import { useUserById } from '@/features/server/users/hooks';
import { stripToPlainText } from '@/helpers/strip-to-plain-text';
import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedMessage } from '@pulse/shared';
import { memo, useCallback, useEffect, useState } from 'react';

/**
 * Channel-specific pin banner. Owns the channel data flow (selected
 * channel → fetch pinned via `messages.getPinned` → listen for
 * `pinned-messages-changed`) and hands the resolved data to the
 * shared `PinBannerShell` for layout. The DM equivalent uses the
 * same shell but with `dms.getPinned` and the DM event bus.
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
    <PinBannerShell
      authorName={author?.name ?? 'Pinned'}
      previewText={previewText}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((e) => !e)}
      expandedContent={<MessageRenderer message={latest} />}
    />
  );
});

export { PinBanner };
