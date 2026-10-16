import { ChatMessageBody } from '@/components/chat-primitives/message-body';
import { PinBannerShell } from '@/components/chat-primitives/pin-banner-shell';
import { decryptDmMessages } from '@/features/dms/actions';
import { useHomeUserById } from '@/features/server/users/hooks';
import { stripToPlainText } from '@/helpers/strip-to-plain-text';
import { getHomeTRPCClient } from '@/lib/trpc';
import type { TJoinedDmMessage } from '@pulse/server/types';
import { memo, useCallback, useEffect, useState } from 'react';
import { onAppEvent } from '@/lib/events';

/**
 * DM equivalent of the channel `PinBanner`. Owns the DM data flow
 * (`dms.getPinned`, `dm-pinned-messages-changed`) and renders the
 * latest pinned message through the shared `ChatMessageBody` in
 * compact mode — the same legacy-HTML → DOMPurify → serializer and
 * token → TokenContentRenderer pipeline every message body uses
 * (audit A8-16: this banner used to hand raw content to an HTML
 * parser). Layout, animation, and width-clamping behavior are
 * provided by the shared `PinBannerShell`.
 */
const DmPinBanner = memo(({ dmChannelId }: { dmChannelId: number }) => {
  const [latest, setLatest] = useState<TJoinedDmMessage | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchLatest = useCallback(async () => {
    if (!dmChannelId) return;
    const trpc = getHomeTRPCClient();
    if (!trpc) return;
    try {
      const messages = await trpc.dms.getPinned.query({ dmChannelId });
      if (messages.length === 0) {
        setLatest(null);
        return;
      }
      // Decrypt before display via the same batch helper used by
      // history + live so an E2EE pin doesn't show the raw envelope.
      const decrypted = await decryptDmMessages(messages);
      const newest = [...decrypted].sort((a, b) => b.id - a.id)[0];
      setLatest(newest);
    } catch {
      setLatest(null);
    }
  }, [dmChannelId]);

  useEffect(() => {
    setExpanded(false);
    fetchLatest();
  }, [fetchLatest]);

  useEffect(() => {
    return onAppEvent('dm-pinned-messages-changed', (payload) => {
      if (payload.dmChannelId === dmChannelId) {
        fetchLatest();
      }
    });
  }, [dmChannelId, fetchLatest]);

  // DM authors are HOME-space ids — ambient lookup reads the wrong
  // roster while a federated server is active.
  const author = useHomeUserById(latest?.userId ?? -1);

  if (!latest) return null;

  // Plain-text strip is format-aware (legacy HTML and tokens).
  const previewText = latest.content
    ? stripToPlainText(latest.content)
    : latest.files && latest.files.length > 0
      ? 'Attachment'
      : '';

  return (
    <PinBannerShell
      authorName={author?.name ?? 'Pinned'}
      previewText={previewText}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((e) => !e)}
      expandedContent={
        <ChatMessageBody message={latest} homeScope compact />
      }
    />
  );
});

DmPinBanner.displayName = 'DmPinBanner';

export { DmPinBanner };
