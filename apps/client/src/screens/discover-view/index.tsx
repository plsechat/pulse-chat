import { useFederatedServers } from '@/features/app/hooks';
import { startServerPreview } from '@/features/server/preview/actions';
import { EmptyState } from '@/components/ui/empty-state';
import { getFileUrl } from '@/helpers/get-file-url';
import { getHomeTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TFederationActiveInstance } from '@pulse/shared';
import type { TRemoteServerSummary, TServerSummary } from '@pulse/server/types';
import { BookOpen, Check, Compass, Globe, Loader2, Lock, Search, Users } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DirectorySection } from './directory-section';
import { joinLocalServerFromCard, joinRemoteServerFromCard } from './join-actions';

type TDiscoverServer = TServerSummary & { joined: boolean };

const ServerCard = memo(
  ({
    server,
    onJoin,
    onPreview,
    joining,
    previewing
  }: {
    server: TDiscoverServer;
    onJoin: (serverId: number) => void;
    onPreview: (serverId: number) => void;
    joining: boolean;
    previewing: boolean;
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
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => onPreview(server.id)}
                  disabled={joining || previewing}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    joining || previewing
                      ? 'cursor-not-allowed bg-muted text-muted-foreground'
                      : 'bg-input text-foreground hover:bg-accent'
                  )}
                >
                  {previewing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    'Preview'
                  )}
                </button>
                <button
                  onClick={() => onJoin(server.id)}
                  disabled={joining || previewing}
                  className={cn(
                    'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                    joining || previewing
                      ? 'cursor-not-allowed bg-muted text-muted-foreground'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90'
                  )}
                >
                  {joining ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    'Join'
                  )}
                </button>
              </div>
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
  const [activeTab, setActiveTab] = useState<'local' | 'federated' | 'directory'>('local');
  const [servers, setServers] = useState<TDiscoverServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [joiningId, setJoiningId] = useState<number | null>(null);
  const [previewingId, setPreviewingId] = useState<number | null>(null);
  const federatedServers = useFederatedServers();

  // Federated state
  const [instances, setInstances] = useState<TFederationActiveInstance[]>([]);
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
        const trpc = getHomeTRPCClient();
        if (!trpc) return;
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
          const trpc = getHomeTRPCClient();
          if (!trpc) return;
          const active = await trpc.federation.listActiveInstances.query();
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

    setJoiningId(serverId);

    try {
      const summary = await joinLocalServerFromCard({
        serverId,
        name: server.name,
        hasPassword: server.hasPassword ?? false
      });
      if (!summary) return;

      // Mark as joined in the discover list
      setServers((prev) =>
        prev.map((s) => (s.id === serverId ? { ...s, joined: true } : s))
      );
    } finally {
      setJoiningId(null);
    }
  }, [servers]);

  const handlePreview = useCallback(async (serverId: number) => {
    setPreviewingId(serverId);

    try {
      // Errors are toasted inside startServerPreview
      await startServerPreview({ serverId });
    } finally {
      setPreviewingId(null);
    }
  }, []);

  const handleJoinFederated = useCallback(
    async (server: TRemoteServerSummary) => {
      const instance = instances.find((i) => i.domain === server.instanceDomain);
      if (!instance) {
        toast.error('Instance not found');
        return;
      }

      setJoiningFedPublicId(server.publicId);
      try {
        await joinRemoteServerFromCard({
          publicId: server.publicId,
          name: server.name,
          instance: {
            id: instance.id,
            domain: server.instanceDomain,
            name: server.instanceName
          },
          hasPassword: server.hasPassword ?? false
        });
      } finally {
        setJoiningFedPublicId(null);
      }
    },
    [instances]
  );

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-12 flex-wrap items-center gap-y-2 border-b border-border px-4 py-2 shadow-sm">
        <Compass className="mr-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h2 className="font-semibold text-foreground">Discover Servers</h2>
        <div className="ml-4 flex gap-1" role="group" aria-label="Discover sections">
          <button
            type="button"
            aria-pressed={activeTab === 'local'}
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
            type="button"
            aria-pressed={activeTab === 'federated'}
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
            <Globe className="h-3.5 w-3.5" aria-hidden="true" />
            Federated
          </button>
          <button
            type="button"
            aria-pressed={activeTab === 'directory'}
            onClick={() => {
              setActiveTab('directory');
              setSearchQuery('');
            }}
            className={cn(
              'rounded-md px-3 py-1 text-sm font-medium transition-colors flex items-center gap-1',
              activeTab === 'directory'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
            Directory
          </button>
        </div>
        <div className="ml-auto">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              aria-label={activeTab === 'directory' ? 'Search the directory by name, tag or game' : 'Search servers'}
              placeholder={activeTab === 'directory' ? 'Search name, tag, game…' : 'Search servers...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 w-40 rounded-md border border-border bg-background pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring sm:w-48"
            />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {activeTab === 'directory' && (
          <DirectorySection active searchQuery={searchQuery} />
        )}

        {activeTab === 'local' && (
          <>
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : servers.length === 0 ? (
              <EmptyState
                icon={Compass}
                title="No servers to discover"
                description="Check back later or join a server with an invite link."
                className="h-full"
              />
            ) : filteredServers.length === 0 ? (
              <EmptyState
                icon={Search}
                title={`No servers matching '${searchQuery}'`}
                className="h-full"
              />
            ) : (
              <div className="mx-auto grid max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredServers.map((server) => (
                  <ServerCard
                    key={server.id}
                    server={server}
                    onJoin={handleJoin}
                    onPreview={handlePreview}
                    joining={joiningId === server.id}
                    previewing={previewingId === server.id}
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
              <EmptyState
                icon={Globe}
                title="No federated servers available"
                description={
                  instances.length === 0
                    ? 'No active federated instances. Ask your admin to set up federation.'
                    : 'Connected instances have no federatable servers.'
                }
                className="h-full"
              />
            ) : filteredRemoteServers.length === 0 ? (
              <EmptyState
                icon={Search}
                title={`No servers matching '${searchQuery}'`}
                className="h-full"
              />
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
