import { DisconnectCode, type AppRouter, type TConnectionParams } from '@pulse/shared';
import { createTRPCProxyClient, createWSClient, wsLink } from '@trpc/client';

type TConnectionStatus = 'connecting' | 'connected' | 'disconnected';

type TConnection = {
  id: string;
  trpc: ReturnType<typeof createTRPCProxyClient<AppRouter>>;
  wsClient: ReturnType<typeof createWSClient>;
  isHome: boolean;
  instanceDomain: string;
  federationToken?: string;
  status: TConnectionStatus;
  reconnectAttempts: number;
};

const MAX_RECONNECT_ATTEMPTS = 10;

class ConnectionManager {
  private connections = new Map<string, TConnection>();
  private onStatusChange:
    | ((domain: string, status: TConnectionStatus) => void)
    | null = null;

  setStatusChangeHandler(
    handler: (domain: string, status: TConnectionStatus) => void
  ) {
    this.onStatusChange = handler;
  }

  connectRemote(
    instanceDomain: string,
    remoteUrl: string,
    federationToken: string
  ): TConnection {
    // If already connected or reconnecting, update the token and reuse
    const existing = this.connections.get(instanceDomain);
    if (existing && existing.status !== 'disconnected') {
      console.log(
        '[ConnectionManager] reusing existing connection to',
        instanceDomain
      );
      existing.federationToken = federationToken;
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
      connectionParams: async (): Promise<TConnectionParams> => {
        const conn = this.connections.get(instanceDomain);
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

        // Federation rejected — permanent failure, stop reconnecting
        if (cause?.code === DisconnectCode.FEDERATION_REJECTED) {
          console.warn(
            '[ConnectionManager] Federation rejected by',
            instanceDomain,
            '— stopping reconnect'
          );
          wsClient.close();
          this.connections.delete(instanceDomain);
          this.onStatusChange?.(instanceDomain, 'disconnected');
          return;
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
      status: 'connecting',
      reconnectAttempts: 0
    };

    this.connections.set(instanceDomain, connection);
    this.onStatusChange?.(instanceDomain, 'connecting');

    return connection;
  }

  reconnectRemote(
    instanceDomain: string,
    remoteUrl: string,
    federationToken: string
  ): TConnection {
    const existing = this.connections.get(instanceDomain);
    if (existing) {
      existing.wsClient.close();
      this.connections.delete(instanceDomain);
    }
    return this.connectRemote(instanceDomain, remoteUrl, federationToken);
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

  updateToken(instanceDomain: string, newToken: string): void {
    const conn = this.connections.get(instanceDomain);
    if (conn) {
      conn.federationToken = newToken;
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
export type { TConnection, TConnectionStatus };
