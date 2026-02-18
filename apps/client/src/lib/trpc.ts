import { resetApp } from '@/features/app/actions';
import { resetDialogs } from '@/features/dialogs/actions';
import { resetDmsState } from '@/features/dms/actions';
import { resetFriendsState } from '@/features/friends/actions';
import { resetServerScreens } from '@/features/server-screens/actions';
import { resetServerState, setDisconnectInfo } from '@/features/server/actions';
import { store } from '@/features/store';
import { getAccessToken, supabase } from '@/lib/supabase';
import { connectionManager } from '@/lib/connection-manager';
import { startReconnecting, stopReconnecting, isCurrentlyReconnecting } from '@/lib/reconnect';
import { DisconnectCode, type AppRouter, type TConnectionParams } from '@pulse/shared';
import { createTRPCProxyClient, createWSClient, wsLink } from '@trpc/client';

let wsClient: ReturnType<typeof createWSClient> | null = null;
let trpc: ReturnType<typeof createTRPCProxyClient<AppRouter>> | null = null;
/** Set to true when the client intentionally closes the connection (sign-out). */
let intentionalClose = false;

/** Whether a disconnect code means the user cannot reconnect. */
const isNonRecoverable = (code: number) =>
  code === DisconnectCode.KICKED || code === DisconnectCode.BANNED;

const initializeTRPC = (host: string) => {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';

  wsClient = createWSClient({
    url: `${protocol}://${host}`,
    // @ts-expect-error - the onclose type is not correct in trpc
    onClose: (cause: CloseEvent) => {
      const code = cause.code;

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
        // Kicked/Banned — full teardown, show the Disconnected screen
        fullTeardown();
        setDisconnectInfo({
          code: cause.code,
          reason: cause.reason,
          wasClean: cause.wasClean,
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

const getTRPCClient = () => {
  // When viewing a federated server, route calls to the remote instance
  const state = store.getState();
  const instanceDomain = state.app.activeInstanceDomain;

  if (instanceDomain) {
    const remote = connectionManager.getRemoteTRPCClient(instanceDomain);
    if (remote) return remote;
  }

  if (!trpc) {
    throw new Error('TRPC client is not initialized');
  }

  return trpc;
};

// Always returns the home instance client — use for friends, DMs, auth, and
// other operations that must never target a remote federated instance
const getHomeTRPCClient = () => {
  if (!trpc) {
    throw new Error('TRPC client is not initialized');
  }

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
    supabase.auth.signOut();
  }
};

export { cleanup, connectToTRPC, getHomeTRPCClient, getTRPCClient, type AppRouter };
