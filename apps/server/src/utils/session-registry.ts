/**
 * Live WebSocket connections, reachable by auth session family.
 *
 * When a session family is revoked (logout, a password change on another
 * device, refresh-token reuse) the sockets that were opened with an access
 * token of that family must go too — the per-request check in the auth
 * backend only guards NEW connections and uploads, an already-open socket
 * never presents its token again. wss.ts registers every socket that
 * carries a family-bearing token here and the backend asks for them to be
 * closed by (user, family).
 *
 * Lives next to permission-cache-registry.ts for the same reason: wss.ts
 * imports the app router, so neither a route nor the auth backend can
 * import wss.ts back without a cycle.
 *
 * Entries are keyed by the connection token. A refreshed page reuses the
 * same access token within its 15-minute life, so a re-registration for
 * the same token replaces the old socket's entry; the unregister handed
 * back to the old socket only removes the entry it created, never the
 * replacement.
 */
import { DisconnectCode } from '@pulse/shared';
import { decodeJwt } from 'jose';

type TSessionSocket = {
  userId: number;
  token: string;
  close: (code: number, reason: string) => void;
};

const socketsByToken = new Map<string, TSessionSocket>();
const tokensByUserId = new Map<number, Set<string>>();

/**
 * Family id (`sid` claim) of an access token the auth backend has already
 * verified. Decoding only — the signature was checked when the connection
 * was authenticated, and the id is only ever matched against families the
 * backend itself revoked. Undefined for every other token shape (OIDC
 * session, federation, supabase, the test mock's plain ids).
 */
const readSessionFamilyId = (token: string): string | undefined => {
  try {
    const sid = decodeJwt(token).sid;
    return typeof sid === 'string' && sid.length > 0 ? sid : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Register a socket under its connection token; returns the matching
 * unregister, which is a no-op once another socket took the token over.
 */
const registerSessionSocket = (
  userId: number,
  token: string,
  close: TSessionSocket['close']
): (() => void) => {
  const entry: TSessionSocket = { userId, token, close };
  socketsByToken.set(token, entry);

  let tokens = tokensByUserId.get(userId);
  if (!tokens) {
    tokens = new Set();
    tokensByUserId.set(userId, tokens);
  }
  tokens.add(token);

  return () => {
    if (socketsByToken.get(token) !== entry) return;
    socketsByToken.delete(token);
    const remaining = tokensByUserId.get(userId);
    if (!remaining) return;
    remaining.delete(token);
    if (remaining.size === 0) tokensByUserId.delete(userId);
  };
};

/**
 * Close every registered socket of `userId` whose token belongs to
 * `familyId`. Returns how many were closed. Closing is best-effort: a
 * socket that is already gone must not stop the others from closing.
 */
const closeSocketsForFamily = (
  userId: number,
  familyId: string,
  reason = 'Session revoked'
): number => {
  const tokens = tokensByUserId.get(userId);
  if (!tokens) return 0;

  let closed = 0;
  for (const token of Array.from(tokens)) {
    const entry = socketsByToken.get(token);
    if (!entry || readSessionFamilyId(token) !== familyId) continue;
    try {
      entry.close(DisconnectCode.SESSION_REVOKED, reason);
      closed += 1;
    } catch {
      // Socket already closed or torn down — nothing left to do.
    }
  }
  return closed;
};

export { closeSocketsForFamily, readSessionFamilyId, registerSessionSocket };
