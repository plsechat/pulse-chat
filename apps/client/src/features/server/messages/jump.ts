import { setActiveView } from '@/features/app/actions';
import { store } from '@/features/store';
import { toast } from 'sonner';
import {
  setHighlightedMessageId,
  setSelectedChannelId
} from '../channels/actions';

/**
 * Jump-to-message engine (message links, search results, pins).
 *
 * The hard part is that the target lives behind two async boundaries:
 * the channel switch (remounts the whole channel view) and, when the
 * message is older than the loaded history, a fetch. A module-level
 * latch bridges them: `jumpToMessage` records the target and kicks the
 * navigation; `useMessages` consumes the latch on mount (or via the
 * jump event when the channel is already mounted) and around-fetches if
 * needed; `finishJump` then scrolls + flashes once the row exists.
 */

const JUMP_EVENT = 'pulse:jump-to-message';

type TPendingJump = { channelId: number; messageId: number };

let pendingJump: TPendingJump | null = null;

export const peekPendingJump = (channelId: number): TPendingJump | null =>
  pendingJump?.channelId === channelId ? pendingJump : null;

export const consumePendingJump = (channelId: number): void => {
  if (pendingJump?.channelId === channelId) pendingJump = null;
};

const HIGHLIGHT_DURATION_MS = 2500;

/**
 * Scroll the (now rendered) target into view and flash it. Retried
 * across a few frames because the row renders asynchronously after the
 * fetch — same retry ladder the initial-scroll restore uses.
 */
export const finishJump = (channelId: number, messageId: number): void => {
  consumePendingJump(channelId);
  setHighlightedMessageId(messageId);
  setTimeout(() => setHighlightedMessageId(undefined), HIGHLIGHT_DURATION_MS);

  const scroll = () => {
    document
      .getElementById(`msg-${messageId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  requestAnimationFrame(scroll);
  setTimeout(scroll, 60);
  setTimeout(scroll, 250);
};

/**
 * Navigate to a message anywhere on the active server: switch to the
 * server view (links are clickable from DMs too), select the channel,
 * and hand off to the latch. Works for messages far outside the loaded
 * history via the around-fetch in useMessages.
 */
export const jumpToMessage = (channelId: number, messageId: number): void => {
  const state = store.getState();

  const channel = state.server.channels.find((c) => c.id === channelId);
  if (!channel) {
    // Message-link tokens carry per-instance numeric ids — a link pasted
    // on a different server (or instance) can't resolve here.
    toast.error('That message is on a different server');
    return;
  }

  pendingJump = { channelId, messageId };

  setActiveView('server');
  if (state.server.selectedChannelId !== channelId) {
    // The channel view remounts; useMessages consumes the latch on init.
    setSelectedChannelId(channelId);
    return;
  }

  // Channel already mounted: if the message is loaded just scroll,
  // otherwise poke the mounted hook to around-fetch.
  const loaded = state.server.messagesMap[channelId]?.some(
    (m) => m.id === messageId
  );
  if (loaded) {
    finishJump(channelId, messageId);
    return;
  }
  window.dispatchEvent(new CustomEvent(JUMP_EVENT));
};

export { JUMP_EVENT };
