import { DisconnectCode, type AppRouter, type TConnectionParams } from '@pulse/shared';
import { createTRPCProxyClient, createWSClient, wsLink } from '@trpc/client';

type TConnection = {
  id: string;
  trpc: ReturnType<typeof createTRPCProxyClient<AppRouter>>;
  wsClient: ReturnType<typeof createWSClient>;
  isHome: boolean;
  instanceDomain: string;
  federationToken?: string;
  status: 'connecting' | 'connected' | 'disconnected';
};

class ConnectionManager {
  private connections = new Map<string, TConnection>();

  connectRemote(
    instanceDomain: string,
    remoteUrl: string,
    federationToken: string
  ): TConnection {
    // If already connected, update the token and return
    const existing = this.connections.get(instanceDomain);
    if (existing && existing.status === 'connected') {
      console.log('[ConnectionManager] reusing existing connection to', instanceDomain);
      existing.federationToken = federationToken;
      return existing;
    }

    const url = new URL(remoteUrl);
    const protocol = url.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${url.host}`;

    console.log('[ConnectionManager] creating WebSocket to', wsUrl, 'for', instanceDomain);

    const wsClient = createWSClient({
      url: wsUrl,
      connectionParams: async (): Promise<TConnectionParams> => {
        const conn = this.connections.get(instanceDomain);
        console.log('[ConnectionManager] connectionParams called for', instanceDomain, 'hasToken:', !!(conn?.federationToken || federationToken));
        return {
          accessToken: '',
          federationToken: conn?.federationToken || federationToken
        };
      },
      onOpen: () => {
        console.log('[ConnectionManager] WebSocket opened to', instanceDomain);
      },
      onClose: (cause) => {
        console.log('[ConnectionManager] WebSocket closed to', instanceDomain, 'cause:', cause);
        if (cause?.code === DisconnectCode.FEDERATION_REJECTED) {
          console.warn('[ConnectionManager] Federation rejected by', instanceDomain, '— stopping reconnect');
          wsClient.close();
          this.connections.delete(instanceDomain);
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
      status: 'connected'
    };

    this.connections.set(instanceDomain, connection);
    console.log('[ConnectionManager] connection registered for', instanceDomain);

    return connection;
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
    }
  }

  disconnectAll(): void {
    for (const [, conn] of this.connections) {
      conn.wsClient.close();
      conn.status = 'disconnected';
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
export type { TConnection };
