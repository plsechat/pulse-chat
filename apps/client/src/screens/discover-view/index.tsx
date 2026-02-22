import {
  joinFederatedServer,
  switchServer
} from '@/features/app/actions';
import { useFederatedServers } from '@/features/app/hooks';
import { appSliceActions } from '@/features/app/slice';
import { getHandshakeHash } from '@/features/server/actions';
import { store } from '@/features/store';
import { getFileUrl } from '@/helpers/get-file-url';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type {
  TFederationInstanceSummary,
  TRemoteServerSummary,
  TServerSummary
} from '@pulse/shared';
import { requestTextInput } from '@/features/dialogs/actions';
import { Check, Compass, Globe, Loader2, Lock, Search, Users } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

type TDiscoverServer = TServerSummary & { joined: boolean };

const ServerCard = memo(
  ({
    server,
    onJoin,
    joining
  }: {
    server: TDiscoverServer;
    onJoin: (serverId: number) => void;
    joining: boolean;
  }) => {
    const firstLetter = server.name.charAt(0).toUpperCase();

    return (
      <div className="flex flex-col overflow-hidden rounded-lg bg-card transition-colors hover:bg-accent">
        <div className="flex h-40 items-center justify-center bg-input">
          {server.logo ? (
            <img
              src={getFileUrl(server.logo)}
              alt={server.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-5xl font-bold text-muted-foreground">
              {firstLetter}
            </span>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-2 p-4">
          <h3 className="truncate text-lg font-semibold text-foreground flex items-center gap-1.5">
            {server.name}
            {server.hasPassword && <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />}
          </h3>

          {server.description && (
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {server.description}
            </p>
          )}

          <div className="mt-auto flex items-center justify-between pt-2">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              <span>{server.memberCount ?? 0} members</span>
            </div>

            {server.joined ? (
              <span className="flex items-center gap-1.5 rounded-md bg-input px-4 py-1.5 text-sm font-medium text-muted-foreground">
                <Check className="h-3.5 w-3.5" />
                Joined
              </span>
            ) : (
              <button
                onClick={() => onJoin(server.id)}
                disabled={joining}
                className={cn(
                  'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                  joining
                    ? 'cursor-not-allowed bg-muted text-muted-foreground'
                    : 'bg-green-600 text-white hover:bg-green-700'
                )}
              >
                {joining ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  'Join'
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
);

const FederatedServerCard = memo(
  ({
    server,
    onJoin,
    joining,
    joined
  }: {
    server: TRemoteServerSummary;
    onJoin: (server: TRemoteServerSummary) => void;
    joining: boolean;
    joined: boolean;
  }) => {
    const firstLetter = server.name.charAt(0).toUpperCase();

    return (
      <div className="flex flex-col overflow-hidden rounded-lg bg-card transition-colors hover:bg-accent">
        <div className="flex h-40 items-center justify-center bg-input">
          {server.logo ? (
            <img
              src={getFileUrl(server.logo, server.instanceDomain)}
              alt={server.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-5xl font-bold text-muted-foreground">
              {firstLetter}
            </span>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-2 p-4">
          <h3 className="truncate text-lg font-semibold text-foreground flex items-center gap-1.5">
            {server.name}
            {server.hasPassword && <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />}
          </h3>

          <div className="flex items-center gap-1 text-xs text-blue-500">
            <Globe className="h-3 w-3" />
            <span>{server.instanceDomain}</span>
          </div>

          {server.description && (
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {server.description}
            </p>
          )}

          <div className="mt-auto flex items-center justify-between pt-2">
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              <span>{server.memberCount} members</span>
            </div>

            {joined ? (
              <span className="flex items-center gap-1.5 rounded-md bg-input px-4 py-1.5 text-sm font-medium text-muted-foreground">
                <Check className="h-3.5 w-3.5" />
                Joined
              </span>
            ) : (
              <button
                onClick={() => onJoin(server)}
                disabled={joining}
                className={cn(
                  'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                  joining
                    ? 'cursor-not-allowed bg-muted text-muted-foreground'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                )}
              >
                {joining ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  'Join'
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
);

const DiscoverView = memo(() => {
  const [activeTab, setActiveTab] = useState<'local' | 'federated'>('local');
  const [servers, setServers] = useState<TDiscoverServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [joiningId, setJoiningId] = useState<number | null>(null);
  const federatedServers = useFederatedServers();

  // Federated state
  const [instances, setInstances] = useState<TFederationInstanceSummary[]>([]);
  const [remoteServers, setRemoteServers] = useState<TRemoteServerSummary[]>(
    []
  );
  const [fedLoading, setFedLoading] = useState(false);
  const [joiningFedPublicId, setJoiningFedPublicId] = useState<string | null>(
    null
  );
  const [searchQuery, setSearchQuery] = useState('');

  const filteredServers = useMemo(() => {
    if (!searchQuery.trim()) return servers;
    const q = searchQuery.toLowerCase();
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q)
    );
  }, [servers, searchQuery]);

  const filteredRemoteServers = useMemo(() => {
    if (!searchQuery.trim()) return remoteServers;
    const q = searchQuery.toLowerCase();
    return remoteServers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q) ||
        s.instanceDomain.toLowerCase().includes(q)
    );
  }, [remoteServers, searchQuery]);

  useEffect(() => {
    const fetchServers = async () => {
      try {
        const trpc = getTRPCClient();
        const data = await trpc.servers.discover.query();
        setServers(data);
      } catch (error) {
        console.error('Failed to fetch discoverable servers:', error);
        toast.error('Failed to load servers');
      } finally {
        setLoading(false);
      }
    };

    fetchServers();
  }, []);

  useEffect(() => {
    if (activeTab === 'federated') {
      const fetchFederated = async () => {
        setFedLoading(true);
        try {
          const trpc = getTRPCClient();
          const fedInstances = await trpc.federation.listInstances.query();
          const active = fedInstances.filter((i) => i.status === 'active');
          setInstances(active);

          // Fetch servers from all active instances
          const allServers: TRemoteServerSummary[] = [];
          for (const inst of active) {
            try {
              const result = await trpc.federation.discoverRemote.query({
                instanceId: inst.id
              });
              allServers.push(...result.servers);
            } catch {
              // Skip instances that fail
            }
          }
          setRemoteServers(allServers);
        } catch (error) {
          console.error('Failed to fetch federated servers:', error);
        } finally {
          setFedLoading(false);
        }
      };

      fetchFederated();
    }
  }, [activeTab]);

  const handleJoin = useCallback(async (serverId: number) => {
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;

    let password: string | undefined;
    if (server.hasPassword) {
      const result = await requestTextInput({
        title: 'Server Password',
        message: `"${server.name}" requires a password to join.`,
        type: 'password',
        confirmLabel: 'Join'
      });
      if (!result) return;
      password = result;
    }

    setJoiningId(serverId);

    try {
      const trpc = getTRPCClient();
      const summary = await trpc.servers.joinDiscover.mutate({ serverId, password });

      // Add to Redux state
      store.dispatch(appSliceActions.addJoinedServer(summary));

      // Mark as joined in the discover list
      setServers((prev) =>
        prev.map((s) => (s.id === serverId ? { ...s, joined: true } : s))
      );

      // Switch to the newly joined server
      const hash = getHandshakeHash();
      if (hash) {
        await switchServer(summary.id, hash);
      }

      toast.success(`Joined ${summary.name}`);
    } catch (error: unknown) {
      console.error('Failed to join server:', error);
      const errMsg = error instanceof Error ? error.message : '';
      const msg = errMsg.includes('Invalid password')
        ? 'Invalid password'
        : errMsg.includes('Too many failed')
          ? errMsg
          : 'Failed to join server';
      toast.error(msg);
    } finally {
      setJoiningId(null);
    }
  }, [servers]);

  const handleJoinFederated = useCallback(
    async (server: TRemoteServerSummary) => {
      setJoiningFedPublicId(server.publicId);

      try {
        const trpc = getTRPCClient();

        console.log('[handleJoinFederated] joining server:', server.name, 'on', server.instanceDomain, 'publicId:', server.publicId);

        // Find the instance
        const instance = instances.find(
          (i) => i.domain === server.instanceDomain
        );
        console.log('[handleJoinFederated] found instance:', instance);
        if (!instance) throw new Error('Instance not found');

        // Get federation token + remote URL
        console.log('[handleJoinFederated] calling joinRemote with instanceId:', instance.id);
        const { federationToken, remoteUrl } =
          await trpc.federation.joinRemote.mutate({
            instanceId: instance.id,
            remoteServerPublicId: server.publicId
          });
        console.log('[handleJoinFederated] got token (length:', federationToken.length, '), remoteUrl:', remoteUrl);

        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

        console.log('[handleJoinFederated] calling joinFederatedServer...');
        await joinFederatedServer(
          server.instanceDomain,
          server.instanceName,
          remoteUrl,
          server.publicId,
          federationToken,
          expiresAt
        );
        console.log('[handleJoinFederated] success');
      } catch (error) {
        console.error('[handleJoinFederated] error:', error);
        toast.error('Failed to join federated server');
      } finally {
        setJoiningFedPublicId(null);
      }
    },
    [instances]
  );

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
      <div className="flex h-12 items-center border-b border-border px-4 shadow-sm">
        <Compass className="mr-2 h-5 w-5 text-muted-foreground" />
        <h2 className="font-semibold text-foreground">Discover Servers</h2>
        <div className="ml-4 flex gap-1">
          <button
            onClick={() => {
              setActiveTab('local');
              setSearchQuery('');
            }}
            className={cn(
              'rounded-md px-3 py-1 text-sm font-medium transition-colors',
              activeTab === 'local'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Local
          </button>
          <button
            onClick={() => {
              setActiveTab('federated');
              setSearchQuery('');
            }}
            className={cn(
              'rounded-md px-3 py-1 text-sm font-medium transition-colors flex items-center gap-1',
              activeTab === 'federated'
                ? 'bg-blue-600 text-white'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Globe className="h-3.5 w-3.5" />
            Federated
          </button>
        </div>
        <div className="ml-auto">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search servers..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 w-48 rounded-md border border-border bg-background pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'local' && (
          <>
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : servers.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Compass className="h-12 w-12" />
                <p className="text-lg font-medium">No servers to discover</p>
                <p className="text-sm">
                  Check back later or join a server with an invite link.
                </p>
              </div>
            ) : filteredServers.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Search className="h-12 w-12" />
                <p className="text-lg font-medium">
                  No servers matching &apos;{searchQuery}&apos;
                </p>
              </div>
            ) : (
              <div className="mx-auto grid max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredServers.map((server) => (
                  <ServerCard
                    key={server.id}
                    server={server}
                    onJoin={handleJoin}
                    joining={joiningId === server.id}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {activeTab === 'federated' && (
          <>
            {fedLoading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : remoteServers.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Globe className="h-12 w-12" />
                <p className="text-lg font-medium">
                  No federated servers available
                </p>
                <p className="text-sm">
                  {instances.length === 0
                    ? 'No active federated instances. Ask your admin to set up federation.'
                    : 'Connected instances have no federatable servers.'}
                </p>
              </div>
            ) : filteredRemoteServers.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Search className="h-12 w-12" />
                <p className="text-lg font-medium">
                  No servers matching &apos;{searchQuery}&apos;
                </p>
              </div>
            ) : (
              <div className="mx-auto grid max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredRemoteServers.map((server) => (
                  <FederatedServerCard
                    key={`${server.instanceDomain}:${server.publicId}`}
                    server={server}
                    onJoin={handleJoinFederated}
                    joining={joiningFedPublicId === server.publicId}
                    joined={federatedServers.some(
                      (fs) =>
                        fs.instanceDomain === server.instanceDomain &&
                        fs.server.publicId === server.publicId
                    )}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});

export { DiscoverView };
