import { setHighlightedMessageId } from '@/features/server/channels/actions';
import { useCallback } from 'react';

/**
 * Scroll a message into view + flash the Redux-driven highlight on it.
 *
 * Replaces the channel-side `setHighlightedMessageId(id) → rAF →
 * scrollIntoView → setTimeout → clear` block that was repeated three
 * times across reply-bar, reply-preview, and the thread-list popover.
 *
 * `idPrefix` defaults to `'msg'` (channel messages render with that
 * id-attribute prefix). The DM conversation has its own dm-msg prefix
 * AND uses a CSS-class highlight rather than the Redux flag, so it
 * doesn't share this hook today — see [pulse-consolidation-proposal]
 * tier B4 follow-up.
 */
const HIGHLIGHT_DURATION_MS = 2500;

const useScrollToMessage = (idPrefix = 'msg') =>
  useCallback(
    (messageId: number) => {
      setHighlightedMessageId(messageId);
      requestAnimationFrame(() => {
        const el = document.getElementById(`${idPrefix}-${messageId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      setTimeout(
        () => setHighlightedMessageId(undefined),
        HIGHLIGHT_DURATION_MS
      );
    },
    [idPrefix]
  );

export { useScrollToMessage };
