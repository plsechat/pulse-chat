import { resetApp } from '@/features/app/actions';
import { resetDialogs } from '@/features/dialogs/actions';
import { resetDmsState } from '@/features/dms/actions';
import { resetEventsState } from '@/features/events/actions';
import { resetFriendsState } from '@/features/friends/actions';
import { resetServerScreens } from '@/features/server-screens/actions';
import { resetServerState, setDisconnectInfo } from '@/features/server/actions';
import { store } from '@/features/store';
import { connectionManager } from '@/lib/connection-manager';
import { createHomeSocketManager } from '@/lib/home-socket';
import {
  isCurrentlyReconnecting,
  startReconnecting,
  stopReconnecting
} from '@/lib/reconnect';
import { clearSession, getAccessToken } from '@/lib/supabase';
import { resolveVoiceTRPCClient } from '@/lib/voice-client';
import type { AppRouter } from '@pulse/server/types';
import { DisconnectCode } from '@pulse/shared';

import { toast } from 'sonner';

/** Shown when the server ended this session: a logout from another tab,
 *  a password change on another device, or a replayed refresh token. */
const SESSION_REVOKED_MESSAGE = 'Signed out on this device.';

/** Reset all Redux state (used on intentional disconnect or non-recoverable kick/ban). */
const fullTeardown = () => {
  resetServerScreens();
  resetServerState();
  resetDialogs();
  resetFriendsState();
  resetDmsState();
  resetEventsState();
  resetApp();
};

// One socket, one retry machine: lib/home-socket.ts retires the dying
// client (which stops tRPC's own reconnect loop) and ignores closes from
// clients that are no longer live; lib/reconnect.ts opens the next one.
const homeSocket = createHomeSocketManager({
  getAccessToken,
  onRecoverableClose: (code) => {
    // Already in a reconnection loop (intermediate close from failed attempt)
    if (isCurrentlyReconnecting()) return;

    // Recoverable disconnect — keep UI visible, start reconnecting
    startReconnecting(code);
  },
  onNonRecoverableClose: ({ code, reason, wasClean }) => {
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
          : reason,
      wasClean,
      time: new Date()
    });
  }
});

const connectToTRPC = (host: string) => {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return homeSocket.connect(`${protocol}://${host}`);
};

/**
 * Returns the active tRPC client, or `null` if the WS connection has been
 * torn down (mid-reconnect or before initial connect). Callers MUST handle
 * the null case — typically by returning early. Previously this threw,
 * which produced uncaught console errors during reconnect when render-
 * driven hooks (e.g. useDmMessages) called fetch actions before the new
 * client was ready.
 */
// Function declarations (hoisted): lib/trpc.ts sits in an import cycle
// (features/app/actions → … → lib/preferences-sync → lib/trpc) and a
// module in that cycle may take a reference to these at evaluation
// time, before this module's body has run; a const binding would still
// be in its temporal dead zone there.
function getTRPCClient(): ReturnType<typeof homeSocket.getClient> {
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

  return homeSocket.getClient();
}

// Always returns the home instance client — use for friends, DMs, auth, and
// other operations that must never target a remote federated instance.
// Returns null during reconnect/before-init; callers must guard.
function getHomeTRPCClient(): ReturnType<typeof homeSocket.getClient> {
  return homeSocket.getClient();
}

// The client for the instance HOSTING the live voice session (pinned at
// join time in server.voiceInstanceDomain; undefined = home). Every voice
// mutation and voice subscription goes through this, not getTRPCClient:
// the user can browse another instance mid-call, and the call must keep
// talking to the server it was joined on. Null while that instance is
// not connected; callers must guard.
function getVoiceTRPCClient(): ReturnType<typeof homeSocket.getClient> {
  return resolveVoiceTRPCClient(
    store.getState().server.voiceInstanceDomain,
    (instanceDomain) => connectionManager.getRemoteTRPCClient(instanceDomain),
    () => homeSocket.getClient()
  );
}

const cleanup = (signOut = false) => {
  stopReconnecting();
  homeSocket.close();
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

export {
  cleanup,
  connectToTRPC,
  getHomeTRPCClient,
  getTRPCClient,
  getVoiceTRPCClient,
  type AppRouter
};
