import { DisconnectCode } from '@pulse/shared';

/**
 * What the connection manager does with a federated socket's close
 * code. Pure so the decision is unit-tested; the manager only wires
 * the outcome to the socket.
 *
 *   permanent    — the peer will refuse every reconnect (handshake
 *                  rejected, shadow banned, account gone, session
 *                  revoked): drop the connection, stop retrying.
 *   refresh-token — the token expired while the client was open (24 h
 *                  TTL, a laptop back from sleep): re-mint it at home,
 *                  swap it in and let the socket reconnect.
 *   retry        — anything else (network blip, peer restarting): the
 *                  transport's own reconnect handles it.
 */
type TFederatedCloseAction = 'permanent' | 'refresh-token' | 'retry';

const PERMANENT_CLOSE_CODES: ReadonlySet<number> = new Set([
  DisconnectCode.FEDERATION_REJECTED,
  DisconnectCode.BANNED,
  DisconnectCode.ACCOUNT_DELETED,
  DisconnectCode.SESSION_REVOKED
]);

const classifyFederatedClose = (
  code: number | undefined
): TFederatedCloseAction => {
  if (code === undefined) return 'retry';
  if (code === DisconnectCode.FEDERATION_TOKEN_EXPIRED) return 'refresh-token';
  if (PERMANENT_CLOSE_CODES.has(code)) return 'permanent';
  return 'retry';
};

/**
 * Re-mint before the peer has to refuse us: a token inside this window
 * of its expiry is replaced on the next (re)connect instead of being
 * presented and bounced with FEDERATION_TOKEN_EXPIRED first.
 */
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

const shouldRefreshFederationToken = (
  tokenExpiresAt: number | undefined,
  now: number = Date.now()
): boolean => {
  if (tokenExpiresAt === undefined || !Number.isFinite(tokenExpiresAt)) {
    return false;
  }
  return tokenExpiresAt - now < TOKEN_REFRESH_WINDOW_MS;
};

export {
  classifyFederatedClose,
  shouldRefreshFederationToken,
  TOKEN_REFRESH_WINDOW_MS,
  type TFederatedCloseAction
};
