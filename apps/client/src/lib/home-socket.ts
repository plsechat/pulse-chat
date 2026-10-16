import { DisconnectCode } from '@pulse/shared';
import type { AppRouter } from '@pulse/server/types';
import { createTRPCProxyClient, createWSClient, wsLink } from '@trpc/client';

/**
 * Lifecycle of the HOME WebSocket client.
 *
 * Exactly one socket is live at a time and exactly one machine retries:
 * lib/reconnect.ts. tRPC's ws client has its own retry loop (it reopens
 * on every close in non-lazy mode, re-sends pending subscriptions and
 * keeps a 30 s keepalive going) — left running, every recoverable close
 * produced a second authenticated socket next to the one the reconnect
 * loop opened, and N orphans after N disconnect cycles. Closing the
 * dying client from inside its own close callback flips tRPC's
 * `allowReconnect` off before its retry timer fires, which is the only
 * supported way to stop that loop (a `retryDelayMs` that throws is
 * caught by tRPC and retried without end).
 *
 * The close callback also compares the client it was created for with
 * the live one: a client that was already replaced (reconnect) or
 * retired (sign-out) is an orphan, and its late close — a server
 * restart, an idle kill — must not null the live references or start
 * another reconnect. That orphan close used to blank the live client
 * for every home-scoped caller while the UI still showed "connected".
 *
 * Kept free of app imports so it can be exercised with a fake socket
 * factory; lib/trpc.ts supplies the session hooks.
 */

type WsClient = ReturnType<typeof createWSClient>;
type WsClientOptions = Parameters<typeof createWSClient>[0];
type TrpcClient = ReturnType<typeof createTRPCProxyClient<AppRouter>>;

type CloseInfo = {
  code: number;
  reason: string;
  wasClean: boolean;
};

type HomeSocketHooks = {
  /** Connection params for every (re)open of the socket. */
  getAccessToken: () => Promise<string | null>;
  /** The live socket closed and the session can be resumed. */
  onRecoverableClose: (code: number) => void;
  /** The server ended the session for good (ban, deletion, revocation). */
  onNonRecoverableClose: (info: CloseInfo) => void;
};

/** Socket construction, injectable so tests can hand in a fake factory. */
type HomeSocketDeps = {
  createWSClient: (opts: WsClientOptions) => WsClient;
  createTrpcClient: (ws: WsClient) => TrpcClient;
};

type HomeSocketManager = {
  /** Open a fresh socket; any previous one is retired first. */
  connect: (url: string) => TrpcClient;
  /** The live tRPC client, or null between a close and the next connect. */
  getClient: () => TrpcClient | null;
  /** Retire the live socket on purpose; its close callback is ignored. */
  close: () => void;
};

/** Whether a disconnect code means the user cannot reconnect. */
const isNonRecoverable = (code: number) =>
  code === DisconnectCode.BANNED ||
  code === DisconnectCode.ACCOUNT_DELETED ||
  code === DisconnectCode.SESSION_REVOKED;

/**
 * tRPC types `onClose` as `(cause?: { code?: number }) => void` but
 * forwards the socket's CloseEvent at runtime; narrow it so reason /
 * wasClean are read only when they are really there.
 */
const isCloseEvent = (cause: unknown): cause is CloseEvent =>
  typeof CloseEvent !== 'undefined' && cause instanceof CloseEvent;

const defaultDeps: HomeSocketDeps = {
  createWSClient,
  createTrpcClient: (ws) =>
    createTRPCProxyClient<AppRouter>({ links: [wsLink({ client: ws })] })
};

const createHomeSocketManager = (
  hooks: HomeSocketHooks,
  deps: HomeSocketDeps = defaultDeps
): HomeSocketManager => {
  let live: { ws: WsClient; trpc: TrpcClient } | null = null;

  /** Retire a client: stops tRPC's own retry loop and closes the socket. */
  const retire = (ws: WsClient) => {
    void ws.close().catch(() => undefined);
  };

  const connect = (url: string) => {
    if (live) {
      const previous = live;
      live = null;
      retire(previous.ws);
    }

    // The callback closes over the client it was created for (the socket
    // opens asynchronously, so `ws` is assigned before it can ever run)
    // — never over whichever client is live later.
    const ws: WsClient = deps.createWSClient({
      url,
      keepAlive: {
        enabled: true,
        intervalMs: 30_000,
        pongTimeoutMs: 5_000
      },
      onClose: (cause) => {
        // Orphan guard: only the live client's close drives the session.
        if (live?.ws !== ws) return;

        live = null;
        retire(ws);

        const code = cause?.code ?? 0;
        if (isNonRecoverable(code)) {
          hooks.onNonRecoverableClose({
            code,
            reason: isCloseEvent(cause) ? cause.reason : '',
            wasClean: isCloseEvent(cause) ? cause.wasClean : false
          });
          return;
        }

        hooks.onRecoverableClose(code);
      },
      connectionParams: async () => ({
        accessToken: (await hooks.getAccessToken()) || ''
      })
    });

    const trpc = deps.createTrpcClient(ws);
    live = { ws, trpc };
    return trpc;
  };

  const getClient = () => live?.trpc ?? null;

  const close = () => {
    if (!live) return;
    const previous = live;
    // Cleared before closing so the close callback sees an orphan and
    // neither starts a reconnect nor reports a disconnect.
    live = null;
    retire(previous.ws);
  };

  return { connect, getClient, close };
};

export { createHomeSocketManager, isNonRecoverable };
export type { CloseInfo, HomeSocketDeps, HomeSocketHooks, HomeSocketManager };
