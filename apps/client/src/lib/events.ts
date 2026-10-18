/**
 * Typed in-process event bus for cross-layer notifications that don't
 * belong in Redux (imperative "refetch now" pings and bridges into
 * component-local state). Replaces the old `window.dispatchEvent(new
 * CustomEvent(...))` side-channel: every event name and payload lives
 * in TAppEventMap, so a typo'd name or wrong payload is a compile
 * error instead of a listener that silently never fires.
 *
 * Zero runtime imports on purpose — lib/e2ee and lib/preference-store
 * emit and listen here without dragging Redux into their layer (the
 * type-only import below is erased). A throwing handler is isolated so
 * it can't starve the others (same rule as combineUnsubscribes in
 * subscription-helpers).
 */

import type { RtpCapabilities } from 'mediasoup-client/types';
import type { TPollUpdate } from '@pulse/server/types';

type TAppEventMap = {
  'mention-user': { userId: number; username: string };
  'forward-message': {
    content: string | null;
    sourceKind: 'channel' | 'dm';
    sourceId: number;
  };
  'jump-to-message': undefined;
  'dm-navigate': { dmChannelId: number };
  'threads-changed': undefined;
  // A channel row was tapped — fires even when that channel was already
  // selected (Redux does not change then), so the mobile drawer can close.
  'channel-selected': { channelId: number };
  'pinned-messages-changed': { channelId: number };
  'dm-pinned-messages-changed': { dmChannelId: number };
  'invites-changed': undefined;
  'notes-changed': { targetUserId: number };
  'preferences-loaded': undefined;
  'e2ee-identity-mismatch': undefined;
  'e2ee-setup-needed': { resolve: () => void; reject: (err: Error) => void };
  // A reconnect re-joined the voice session server-side; the voice
  // provider (the only owner of the media transports) has to run init.
  'voice-rejoin': { routerRtpCapabilities: RtpCapabilities; channelId: number };
  // A poll's counts changed (vote, unvote, close); the card for that
  // message merges them over its own view.
  'poll-updated': TPollUpdate;
  // The channel's Scheduled list / Follows tab should refetch.
  'scheduled-posts-changed': { channelId: number };
  'channel-follows-changed': { channelId: number };
  // The HOME session was (re)opened — first connect or a reconnect. State
  // the server only holds while a socket lives (game presence) is
  // re-reported on it.
  'home-session-opened': undefined;
};

type TAppEvent = keyof TAppEventMap;
type THandler<K extends TAppEvent> = (payload: TAppEventMap[K]) => void;

const listeners = new Map<TAppEvent, Set<THandler<TAppEvent>>>();

/** Subscribe. Returns the unsubscribe function — return it from useEffect. */
const onAppEvent = <K extends TAppEvent>(
  event: K,
  handler: THandler<K>
): (() => void) => {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(handler as THandler<TAppEvent>);
  return () => {
    set.delete(handler as THandler<TAppEvent>);
  };
};

const emitAppEvent = <K extends TAppEvent>(
  event: K,
  ...args: TAppEventMap[K] extends undefined ? [] : [TAppEventMap[K]]
): void => {
  const set = listeners.get(event);
  if (!set) return;
  // Copy before iterating: a handler may unsubscribe (or subscribe)
  // during dispatch.
  for (const handler of [...set]) {
    try {
      handler(args[0] as TAppEventMap[K]);
    } catch (error) {
      console.error(`[events] handler for "${event}" threw:`, error);
    }
  }
};

/** Legacy-named helpers kept for their existing call sites. */
const dispatchMentionUser = (userId: number, username: string) =>
  emitAppEvent('mention-user', { userId, username });

const dispatchForwardMessage = (
  content: string | null,
  sourceKind: 'channel' | 'dm',
  sourceId: number
) => emitAppEvent('forward-message', { content, sourceKind, sourceId });

export { dispatchForwardMessage, dispatchMentionUser, emitAppEvent, onAppEvent };
export type { TAppEventMap };
