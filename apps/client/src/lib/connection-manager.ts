import type { AppRouter, TConnectionParams } from '@pulse/shared';
import { createTRPCProxyClient, createWSClient, wsLink } from '@trpc/client';
import {
  classifyFederatedClose,
  shouldRefreshFederationToken
} from './federation-reconnect-policy';

type TConnectionStatus = 'connecting' | 'connected' | 'disconnected';

type TConnection = {
  id: string;
  trpc: ReturnType<typeof createTRPCProxyClient<AppRouter>>;
  wsClient: ReturnType<typeof createWSClient>;
  isHome: boolean;
  instanceDomain: string;
  federationToken?: string;
  /** Epoch ms the token stops being accepted; drives proactive re-minting. */
  tokenExpiresAt?: number;
  status: TConnectionStatus;
  reconnectAttempts: number;
  /** In-flight re-mint, so a reconnect waits for it instead of racing it. */
  pendingRefresh: Promise<boolean> | null;
};

type TFederationToken = { token: string; expiresAt: number };

/** Mints a fresh federation token for `instanceDomain` at the home instance. */
type TTokenRefreshHandler = (
  instanceDomain: string
) => Promise<TFederationToken | null>;

const MAX_RECONNECT_ATTEMPTS = 10;

class ConnectionManager {
  private connections = new Map<string, TConnection>();
  private onStatusChange:
    | ((domain: string, status: TConnectionStatus) => void)
    | null = null;
  private refreshToken: TTokenRefreshHandler | null = null;

  setStatusChangeHandler(
    handler: (domain: string, status: TConnectionStatus) => void
  ) {
    this.onStatusChange = handler;
  }

  /**
   * The app layer owns the home tRPC client and the persisted entries,
   * so it supplies the re-mint; the manager decides WHEN (token about
   * to expire, or the peer just closed with FEDERATION_TOKEN_EXPIRED).
   */
  setTokenRefreshHandler(handler: TTokenRefreshHandler | null) {
    this.refreshToken = handler;
  }

  /**
   * Re-mint the token for a connection. Deduplicated per connection:
   * the close handler and a reconnect's connectionParams can both ask
   * at once and must share one request. Resolves true when the
   * connection now holds a fresh token.
   */
  private refreshConnectionToken(instanceDomain: string): Promise<boolean> {
    const conn = this.connections.get(instanceDomain);
    if (!conn) return Promise.resolve(false);
    if (conn.pendingRefresh) return conn.pendingRefresh;
    if (!this.refreshToken) return Promise.resolve(false);

    const refresh = this.refreshToken(instanceDomain)
      .then((fresh) => {
        if (!fresh) return false;
        // The connection may have been replaced while we waited; only
        // the live entry takes the token.
        const live = this.connections.get(instanceDomain);
        if (live !== conn) return false;
        conn.federationToken = fresh.token;
        conn.tokenExpiresAt = fresh.expiresAt;
        return true;
      })
      .catch((error: unknown) => {
        console.error(
          '[ConnectionManager] token refresh failed for',
          instanceDomain,
          error
        );
        return false;
      })
      .finally(() => {
        if (conn.pendingRefresh === refresh) conn.pendingRefresh = null;
      });

    conn.pendingRefresh = refresh;
    return refresh;
  }

  connectRemote(
    instanceDomain: string,
    remoteUrl: string,
    federationToken: string,
    tokenExpiresAt?: number
  ): TConnection {
    // If already connected or reconnecting, update the token and reuse
    const existing = this.connections.get(instanceDomain);
    if (existing && existing.status !== 'disconnected') {
      console.log(
        '[ConnectionManager] reusing existing connection to',
        instanceDomain
      );
      existing.federationToken = federationToken;
      if (tokenExpiresAt !== undefined) existing.tokenExpiresAt = tokenExpiresAt;
      return existing;
    }

    const url = new URL(remoteUrl);
    const protocol = url.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${url.host}`;

    console.log(
      '[ConnectionManager] creating WebSocket to',
      wsUrl,
      'for',
      instanceDomain
    );

    const wsClient = createWSClient({
      url: wsUrl,
      keepAlive: {
        enabled: true,
        intervalMs: 30_000,
        pongTimeoutMs: 5_000
      },
      connectionParams: async (): Promise<TConnectionParams> => {
        const conn = this.connections.get(instanceDomain);
        // Runs on every (re)connect: a token about to expire — or one
        // the peer just bounced — is replaced before it is presented.
        if (
          conn &&
          (conn.pendingRefresh || shouldRefreshFederationToken(conn.tokenExpiresAt))
        ) {
          await this.refreshConnectionToken(instanceDomain);
        }
        return {
          accessToken: '',
          federationToken: conn?.federationToken || federationToken
        };
      },
      onOpen: () => {
        console.log(
          '[ConnectionManager] WebSocket opened to',
          instanceDomain
        );
        const conn = this.connections.get(instanceDomain);
        if (conn) {
          conn.status = 'connected';
          conn.reconnectAttempts = 0;
        }
        this.onStatusChange?.(instanceDomain, 'connected');
      },
      onClose: (cause) => {
        console.log(
          '[ConnectionManager] WebSocket closed to',
          instanceDomain,
          'cause:',
          cause
        );
        const conn = this.connections.get(instanceDomain);
        const action = classifyFederatedClose(cause?.code);

        // Permanent failures — stop reconnecting. FEDERATION_REJECTED:
        // the peer refused the federation handshake. BANNED: our shadow
        // user is banned instance-wide, every reconnect will be refused;
        // retrying just flickers the status badge forever.
        if (action === 'permanent') {
          console.warn(
            '[ConnectionManager] Permanent close from',
            instanceDomain,
            `(code ${cause?.code}) — stopping reconnect`
          );
          wsClient.close();
          this.connections.delete(instanceDomain);
          this.onStatusChange?.(instanceDomain, 'disconnected');
          return;
        }

        // The peer bounced an expired token: start the re-mint now so
        // the transport's reconnect (which awaits connectionParams)
        // presents the fresh one. Counted as an attempt below so a home
        // instance that cannot mint does not loop forever.
        if (action === 'refresh-token') {
          void this.refreshConnectionToken(instanceDomain);
        }

        // tRPC auto-reconnects. Track consecutive failures and cap them.
        if (conn) {
          conn.reconnectAttempts++;
          conn.status = 'connecting';
          this.onStatusChange?.(instanceDomain, 'connecting');

          if (conn.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            console.error(
              '[ConnectionManager] Max reconnect attempts exceeded for',
              instanceDomain
            );
            wsClient.close();
            conn.status = 'disconnected';
            this.onStatusChange?.(instanceDomain, 'disconnected');
          }
        }
      }
    });

    const trpc = createTRPCProxyClient<AppRouter>({
      links: [wsLink({ client: wsClient })]
    });

    const connection: TConnection = {
      id: instanceDomain,
      trpc,
      wsClient,
      isHome: false,
      instanceDomain,
      federationToken,
      tokenExpiresAt,
      status: 'connecting',
      reconnectAttempts: 0,
      pendingRefresh: null
    };

    this.connections.set(instanceDomain, connection);
    this.onStatusChange?.(instanceDomain, 'connecting');

    return connection;
  }

  reconnectRemote(
    instanceDomain: string,
    remoteUrl: string,
    federationToken: string,
    tokenExpiresAt?: number
  ): TConnection {
    const existing = this.connections.get(instanceDomain);
    if (existing) {
      existing.wsClient.close();
      this.connections.delete(instanceDomain);
    }
    return this.connectRemote(
      instanceDomain,
      remoteUrl,
      federationToken,
      tokenExpiresAt
    );
  }

  getConnection(instanceDomain: string): TConnection | null {
    return this.connections.get(instanceDomain) || null;
  }

  getRemoteTRPCClient(
    instanceDomain: string
  ): ReturnType<typeof createTRPCProxyClient<AppRouter>> | null {
    const conn = this.connections.get(instanceDomain);
    return conn?.trpc || null;
  }

  disconnectRemote(instanceDomain: string): void {
    const conn = this.connections.get(instanceDomain);
    if (conn) {
      conn.wsClient.close();
      conn.status = 'disconnected';
      this.connections.delete(instanceDomain);
      this.onStatusChange?.(instanceDomain, 'disconnected');
    }
  }

  disconnectAll(): void {
    for (const [domain, conn] of this.connections) {
      conn.wsClient.close();
      conn.status = 'disconnected';
      this.onStatusChange?.(domain, 'disconnected');
    }
    this.connections.clear();
  }

  updateToken(
    instanceDomain: string,
    newToken: string,
    expiresAt?: number
  ): void {
    const conn = this.connections.get(instanceDomain);
    if (conn) {
      conn.federationToken = newToken;
      if (expiresAt !== undefined) conn.tokenExpiresAt = expiresAt;
    }
  }

  getConnectedDomains(): string[] {
    return Array.from(this.connections.keys());
  }

  isConnected(instanceDomain: string): boolean {
    const conn = this.connections.get(instanceDomain);
    return conn?.status === 'connected';
  }
}

export const connectionManager = new ConnectionManager();
export type { TConnection, TConnectionStatus, TTokenRefreshHandler };
