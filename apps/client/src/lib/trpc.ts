import { resetApp } from '@/features/app/actions';
import { resetDialogs } from '@/features/dialogs/actions';
import { resetDmsState } from '@/features/dms/actions';
import { resetFriendsState } from '@/features/friends/actions';
import { resetServerScreens } from '@/features/server-screens/actions';
import { resetServerState, setDisconnectInfo } from '@/features/server/actions';
import { store } from '@/features/store';
import { clearSession, getAccessToken } from '@/lib/supabase';
import { connectionManager } from '@/lib/connection-manager';
import { startReconnecting, stopReconnecting, isCurrentlyReconnecting } from '@/lib/reconnect';
import { DisconnectCode, type AppRouter, type TConnectionParams } from '@pulse/shared';
import { createTRPCProxyClient, createWSClient, wsLink } from '@trpc/client';
import { toast } from 'sonner';

let wsClient: ReturnType<typeof createWSClient> | null = null;
let trpc: ReturnType<typeof createTRPCProxyClient<AppRouter>> | null = null;
/** Set to true when the client intentionally closes the connection (sign-out). */
let intentionalClose = false;

/**
 * tRPC types `onClose` as `(cause?: { code?: number }) => void` but
 * forwards the socket's CloseEvent at runtime; narrow it so reason /
 * wasClean are read only when they are really there.
 */
const isCloseEvent = (cause: unknown): cause is CloseEvent =>
  typeof CloseEvent !== 'undefined' && cause instanceof CloseEvent;

/** Whether a disconnect code means the user cannot reconnect. */
const isNonRecoverable = (code: number) =>
  code === DisconnectCode.BANNED ||
  code === DisconnectCode.ACCOUNT_DELETED ||
  code === DisconnectCode.SESSION_REVOKED;

/** Shown when the server ended this session: a logout from another tab,
 *  a password change on another device, or a replayed refresh token. */
const SESSION_REVOKED_MESSAGE = 'Signed out on this device.';

const initializeTRPC = (host: string) => {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';

  wsClient = createWSClient({
    url: `${protocol}://${host}`,
    keepAlive: {
      enabled: true,
      intervalMs: 30_000,
      pongTimeoutMs: 5_000
    },
    onClose: (cause) => {
      const code = cause?.code ?? 0;

      // Null out the ws/trpc references so connect() recreates them
      wsClient = null;
      trpc = null;


      // If we intentionally closed (user sign-out / cleanup), do nothing —
      // cleanup() already handles the full teardown
      if (intentionalClose) {
        intentionalClose = false;
        return;
      }

      if (isNonRecoverable(code)) {
        // Banned / deleted / signed out — full teardown, no reconnect.
        fullTeardown();

        if (code === DisconnectCode.SESSION_REVOKED) {
          // The stored tokens are dead server-side; drop them so the
          // login screen shows instead of a reconnect loop on a token
          // the server will keep refusing. clearSession's own logout
          // call is a harmless repeat.
          void clearSession();
          toast.info(SESSION_REVOKED_MESSAGE);
        }

        setDisconnectInfo({
          code,
          reason:
            code === DisconnectCode.SESSION_REVOKED
              ? SESSION_REVOKED_MESSAGE
              : isCloseEvent(cause)
                ? cause.reason
                : '',
          wasClean: isCloseEvent(cause) ? cause.wasClean : false,
          time: new Date()
        });
        return;
      }

      // Already in a reconnection loop (intermediate close from failed attempt)
      if (isCurrentlyReconnecting()) return;

      // Recoverable disconnect — keep UI visible, start reconnecting
      startReconnecting(code);
    },
    connectionParams: async (): Promise<TConnectionParams> => {
      return {
        accessToken: (await getAccessToken()) || ''
      };
    }
  });

  trpc = createTRPCProxyClient<AppRouter>({
    links: [wsLink({ client: wsClient })]
  });

  return trpc;
};

const connectToTRPC = (host: string) => {
  // Always create a fresh connection (old one is dead after disconnect)
  return initializeTRPC(host);
};

/**
 * Returns the active tRPC client, or `null` if the WS connection has been
 * torn down (mid-reconnect or before initial connect). Callers MUST handle
 * the null case — typically by returning early. Previously this threw,
 * which produced uncaught console errors during reconnect when render-
 * driven hooks (e.g. useDmMessages) called fetch actions before the new
 * client was ready.
 */
const getTRPCClient = ():
  | ReturnType<typeof createTRPCProxyClient<AppRouter>>
  | null => {
  // When viewing a federated server, route calls to the remote instance
  const state = store.getState();
  const instanceDomain = state.app.activeInstanceDomain;

  if (instanceDomain) {
    // Never fall back to the home client while a remote instance is
    // active: an instance-scoped call routed to the home server silently
    // reads/writes the WRONG instance's data. Observed as the federated
    // message pane showing the HOME channel's history for a colliding
    // numeric channel id while the remote connection was still coming up
    // (and markAsRead flagging the wrong channel). Callers already guard
    // null.
    return connectionManager.getRemoteTRPCClient(instanceDomain) ?? null;
  }

  return trpc;
};

// Always returns the home instance client — use for friends, DMs, auth, and
// other operations that must never target a remote federated instance.
// Returns null during reconnect/before-init; callers must guard.
const getHomeTRPCClient = ():
  | ReturnType<typeof createTRPCProxyClient<AppRouter>>
  | null => {
  return trpc;
};

/** Reset all Redux state (used on intentional disconnect or non-recoverable kick/ban). */
const fullTeardown = () => {
  resetServerScreens();
  resetServerState();
  resetDialogs();
  resetFriendsState();
  resetDmsState();
  resetApp();
};

const cleanup = (signOut = false) => {
  stopReconnecting();
  intentionalClose = true;

  if (wsClient) {
    wsClient.close();
    wsClient = null;
  }

  trpc = null;
  fullTeardown();

  if (signOut) {
    void clearSession();
    // Wipe E2EE IDB so the next user on this browser doesn't inherit
    // the previous user's identity, sessions, or sender keys. Dynamic
    // import to avoid a lib/e2ee → lib/trpc circular dependency.
    void import('@/lib/e2ee/store').then(({ clearAllStores }) =>
      clearAllStores()
    );
  }
};

export { cleanup, connectToTRPC, getHomeTRPCClient, getTRPCClient, type AppRouter };
