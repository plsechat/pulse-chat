import { getHomeTRPCClient } from '@/lib/trpc';

/**
 * Thrown by home-scoped mutation wrappers (friends, DMs) when there is no
 * live home tRPC client. Those wrappers used to `return` silently in that
 * window, so every caller's `toast.success` fired for a request that never
 * left the browser (observed: "Conversation declined" after a block and a
 * leave that both no-op'd). Throwing routes the gap through the `catch →
 * toast.error(getTrpcError(...))` every caller already has; the message is
 * what the user sees.
 *
 * Read/fetch helpers keep returning quietly — the join path re-runs them.
 */
export class NotConnectedError extends Error {
  constructor() {
    super('Not connected — try again in a moment');
    this.name = 'NotConnectedError';
  }
}

/** The home client, or a NotConnectedError for a mutation to surface. */
export const requireHomeTRPCClient = () => {
  const trpc = getHomeTRPCClient();
  if (!trpc) throw new NotConnectedError();
  return trpc;
};
