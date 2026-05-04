import { serializer } from '@/components/channel-view/text/renderer/serializer';
import { PinBannerShell } from '@/components/chat-primitives/pin-banner-shell';
import { decryptDmMessages } from '@/features/dms/actions';
import { useUserById } from '@/features/server/users/hooks';
import { stripToPlainText } from '@/helpers/strip-to-plain-text';
import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedDmMessage } from '@pulse/shared';
import parse from 'html-react-parser';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

/**
 * DM equivalent of the channel `PinBanner`. Owns the DM data flow
 * (`dms.getPinned`, `dm-pinned-messages-changed`) and renders the
 * latest pinned message through DM's own legacy-html serializer
 * pipeline. Layout, animation, and width-clamping behavior are
 * provided by the shared `PinBannerShell`.
 */
const DmPinBanner = memo(({ dmChannelId }: { dmChannelId: number }) => {
  const [latest, setLatest] = useState<TJoinedDmMessage | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchLatest = useCallback(async () => {
    if (!dmChannelId) return;
    const trpc = getTRPCClient();
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
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.dmChannelId === dmChannelId) {
        fetchLatest();
      }
    };
    window.addEventListener('dm-pinned-messages-changed', handler);
    return () =>
      window.removeEventListener('dm-pinned-messages-changed', handler);
  }, [dmChannelId, fetchLatest]);

  const author = useUserById(latest?.userId ?? -1);

  // DM messages can be either tiptap-style HTML (legacy) or token JSON.
  // Mirror DmPinnedMessageItem's approach: parse + serializer for
  // expanded body. Plain-text strip is always safe.
  const expandedNode = useMemo(() => {
    if (!latest?.content) return null;
    return parse(latest.content, {
      replace: (domNode) => serializer(domNode, () => {})
    });
  }, [latest?.content]);

  if (!latest) return null;

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
        <div className="msg-content">{expandedNode}</div>
      }
    />
  );
});

DmPinBanner.displayName = 'DmPinBanner';

export { DmPinBanner };
