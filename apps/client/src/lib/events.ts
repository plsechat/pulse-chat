/**
 * Typed in-process event bus for cross-layer notifications that don't
 * belong in Redux (imperative "refetch now" pings and bridges into
 * component-local state). Replaces the old `window.dispatchEvent(new
 * CustomEvent(...))` side-channel: every event name and payload lives
 * in TAppEventMap, so a typo'd name or wrong payload is a compile
 * error instead of a listener that silently never fires.
 *
 * Zero imports on purpose — lib/e2ee and lib/preference-store emit and
 * listen here without dragging Redux into their layer. A throwing
 * handler is isolated so it can't starve the others (same rule as
 * combineUnsubscribes in subscription-helpers).
 */

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
  'pinned-messages-changed': { channelId: number };
  'dm-pinned-messages-changed': { dmChannelId: number };
  'invites-changed': undefined;
  'notes-changed': { targetUserId: number };
  'preferences-loaded': undefined;
  'e2ee-identity-mismatch': undefined;
  'e2ee-setup-needed': { resolve: () => void; reject: (err: Error) => void };
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
