import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { LoadingCard } from '@/components/ui/loading-card';
import { Switch } from '@/components/ui/switch';
import { getHomeTRPCClient } from '@/lib/trpc';
import type {
  TFederationConfig,
  TFederationDeadOutboxRow,
  TFederationInstanceSummary
} from '@pulse/shared';
import {
  AlertTriangle,
  Globe,
  Key,
  Link,
  RotateCcw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Clock
} from 'lucide-react';
import { parseTrpcErrors } from '@/helpers/parse-trpc-errors';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

const statusColors: Record<string, string> = {
  active: 'text-green-500',
  pending: 'text-yellow-500',
  blocked: 'text-red-500'
};

const formatTime = (ts: number | null) =>
  ts ? new Date(ts).toLocaleString() : '';

/**
 * Dead-lettered relays for one peer: what we could not deliver and why
 * (`unsupported:<path>` means the peer runs a version without that
 * route). Loaded on demand — the list is only interesting once the
 * owner looks.
 */
const DeadOutboxList = memo(({ instanceId }: { instanceId: number }) => {
  const [rows, setRows] = useState<TFederationDeadOutboxRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const trpc = getHomeTRPCClient();
    if (!trpc) return;
    trpc.federation.listDeadOutbox
      .query({ instanceId })
      .then((result) => {
        if (!cancelled) setRows(result);
      })
      .catch((error) => {
        console.error('Failed to load dead outbox rows:', error);
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [instanceId]);

  if (rows === null) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing undelivered.</p>;
  }
  return (
    <ul className="space-y-1">
      {rows.map((row) => (
        <li key={row.id} className="text-xs font-mono text-muted-foreground">
          <span className="text-foreground">{row.path}</span>
          {' · '}
          {row.attempts} attempt{row.attempts === 1 ? '' : 's'}
          {row.lastError ? ` · ${row.lastError}` : ''}
          {row.deadAt ? ` · ${formatTime(row.deadAt)}` : ''}
        </li>
      ))}
    </ul>
  );
});

const StatusBadge = ({ status }: { status: string }) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[status] || 'text-muted-foreground'}`}
  >
    {status === 'active' && <ShieldCheck className="h-3 w-3" />}
    {status === 'pending' && <Clock className="h-3 w-3" />}
    {status === 'blocked' && <ShieldAlert className="h-3 w-3" />}
    {status}
  </span>
);

const Federation = memo(() => {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<TFederationConfig | null>(null);
  const [instances, setInstances] = useState<TFederationInstanceSummary[]>([]);
  const [domain, setDomain] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [allowUserFederatableServers, setAllowUserFederatableServers] =
    useState(false);
  const [addUrl, setAddUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [expandedDead, setExpandedDead] = useState<number | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const trpc = getHomeTRPCClient();
      if (!trpc) return;
      const [configResult, instancesResult] = await Promise.all([
        trpc.federation.getConfig.query(),
        trpc.federation.listInstances.query()
      ]);
      setConfig(configResult);
      setInstances(instancesResult);
      setDomain(configResult.domain);
      setEnabled(configResult.enabled);
      setAllowUserFederatableServers(
        configResult.allowUserFederatableServers
      );
    } catch (error) {
      console.error('Failed to load federation config:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Subscribe to real-time federation instance updates
  useEffect(() => {
    const trpc = getHomeTRPCClient();
    if (!trpc) return;
    const sub = trpc.federation.onInstanceUpdate.subscribe(undefined, {
      onData: () => fetchData(),
      onError: (err) =>
        console.error('onFederationInstanceUpdate subscription error:', err)
    });

    return () => sub.unsubscribe();
  }, [fetchData]);

  const handleSaveConfig = useCallback(async () => {
    try {
      const trpc = getHomeTRPCClient();
      if (!trpc) return;
      await trpc.federation.setConfig.mutate({
        enabled,
        domain,
        allowUserFederatableServers
      });
      toast.success('Federation settings saved');
      fetchData();
    } catch (error) {
      console.error('Failed to save federation config:', error);
      toast.error('Failed to save settings');
    }
  }, [enabled, domain, allowUserFederatableServers, fetchData]);

  const handleAddInstance = useCallback(async () => {
    if (!addUrl.trim()) return;

    setAdding(true);
    try {
      const trpc = getHomeTRPCClient();
      if (!trpc) return;
      await trpc.federation.addInstance.mutate({ remoteUrl: addUrl });
      setAddUrl('');
      toast.success('Federation request sent');
      fetchData();
    } catch (error) {
      console.error('Failed to add instance:', error);
      const errors = parseTrpcErrors(error);
      toast.error(errors.remoteUrl || errors._general || 'Failed to add instance');
    } finally {
      setAdding(false);
    }
  }, [addUrl, fetchData]);

  const handleAccept = useCallback(
    async (instanceId: number) => {
      try {
        const trpc = getHomeTRPCClient();
        if (!trpc) return;
        await trpc.federation.acceptInstance.mutate({ instanceId });
        toast.success('Federation accepted');
        fetchData();
      } catch (error) {
        console.error('Failed to accept instance:', error);
        toast.error('Failed to accept');
      }
    },
    [fetchData]
  );

  const handleBlock = useCallback(
    async (instanceId: number) => {
      try {
        const trpc = getHomeTRPCClient();
        if (!trpc) return;
        await trpc.federation.blockInstance.mutate({ instanceId });
        toast.success('Instance blocked');
        fetchData();
      } catch (error) {
        console.error('Failed to block instance:', error);
        toast.error('Failed to block');
      }
    },
    [fetchData]
  );

  const handleRemove = useCallback(
    async (instanceId: number) => {
      try {
        const trpc = getHomeTRPCClient();
        if (!trpc) return;
        await trpc.federation.removeInstance.mutate({ instanceId });
        toast.success('Instance removed');
        fetchData();
      } catch (error) {
        console.error('Failed to remove instance:', error);
        toast.error('Failed to remove');
      }
    },
    [fetchData]
  );

  const handleRetryOutbox = useCallback(
    async (instanceId: number) => {
      try {
        const trpc = getHomeTRPCClient();
        if (!trpc) return;
        const { revived } = await trpc.federation.retryOutbox.mutate({
          instanceId
        });
        toast.success(
          revived === 0
            ? 'Nothing to retry'
            : `Retrying ${revived} undelivered relay${revived === 1 ? '' : 's'}`
        );
        // The drain runs right after; give it a moment before refreshing
        // so the counts reflect the first attempts.
        setTimeout(fetchData, 1500);
      } catch (error) {
        console.error('Failed to retry outbox:', error);
        toast.error('Failed to retry');
      }
    },
    [fetchData]
  );

  if (loading) {
    return <LoadingCard className="h-[400px]" />;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Federation
          </CardTitle>
          <CardDescription>
            Connect with other Pulse instances to form a federated network.
            Users from federated instances can join your servers using their home
            identity.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Group
            label="Enable Federation"
            description="Allow this instance to participate in the Pulse federation network."
          >
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </Group>

          <Group label="Instance Domain">
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="pulse.example.com"
              disabled={!enabled}
            />
          </Group>

          <Group
            label="Allow users to create federatable servers"
            description="When off, only you can mark a server as federatable. When on, any server owner may make their own server federatable."
          >
            <Switch
              checked={allowUserFederatableServers}
              onCheckedChange={setAllowUserFederatableServers}
              disabled={!enabled}
            />
          </Group>

          {config?.hasKeys && config.publicKey && (
            <Group label="Public Key">
              <div className="flex items-center gap-2">
                <Key className="h-4 w-4 text-muted-foreground" />
                <code className="text-xs text-muted-foreground break-all max-w-lg">
                  {config.publicKey.slice(0, 80)}...
                </code>
              </div>
            </Group>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={handleSaveConfig} disabled={!domain.trim()}>
              Save Settings
            </Button>
          </div>
        </CardContent>
      </Card>

      {enabled && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link className="h-5 w-5" />
              Federated Instances
            </CardTitle>
            <CardDescription>
              Manage connections to other Pulse instances.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
                placeholder="https://pulse.other-instance.com"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddInstance();
                }}
              />
              <Button
                onClick={handleAddInstance}
                disabled={adding || !addUrl.trim()}
              >
                {adding ? 'Connecting...' : 'Add Instance'}
              </Button>
            </div>

            {instances.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No federated instances yet. Add one to get started.
              </p>
            ) : (
              <div className="space-y-2">
                {instances.map((instance) => {
                  const degraded =
                    instance.lastError !== null || instance.deadOutbox > 0;
                  return (
                    <div
                      key={instance.id}
                      className="rounded-lg border p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Shield className="h-5 w-5 text-muted-foreground" />
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">
                                {instance.name || instance.domain}
                              </span>
                              <StatusBadge status={instance.status} />
                              <span className="text-xs text-muted-foreground">
                                {instance.direction}
                              </span>
                              {instance.peerVersion && (
                                <span
                                  className="text-xs text-muted-foreground"
                                  title="Peer version"
                                >
                                  v{instance.peerVersion}
                                </span>
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {instance.domain}
                              {instance.pendingOutbox > 0 &&
                                ` · ${instance.pendingOutbox} relay${instance.pendingOutbox === 1 ? '' : 's'} retrying`}
                              {instance.deadOutbox > 0 &&
                                ` · ${instance.deadOutbox} undelivered`}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {instance.status === 'pending' &&
                            instance.direction === 'incoming' && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleAccept(instance.id)}
                              >
                                Accept
                              </Button>
                            )}
                          {instance.status !== 'blocked' && (
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => handleBlock(instance.id)}
                              title="Block"
                            >
                              <ShieldAlert className="h-4 w-4" />
                              Block
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleRemove(instance.id)}
                            title="Remove"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      {degraded && (
                        <div className="flex items-center justify-between gap-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400">
                          <span className="flex items-center gap-1.5 min-w-0">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">
                              degraded:{' '}
                              {instance.lastError ??
                                `${instance.deadOutbox} relay${instance.deadOutbox === 1 ? '' : 's'} could not be delivered`}
                              {instance.lastErrorAt &&
                                ` (${formatTime(instance.lastErrorAt)})`}
                            </span>
                          </span>
                          <span className="flex items-center gap-1 shrink-0">
                            {instance.deadOutbox > 0 && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setExpandedDead(
                                    expandedDead === instance.id
                                      ? null
                                      : instance.id
                                  )
                                }
                              >
                                {expandedDead === instance.id
                                  ? 'Hide'
                                  : 'Details'}
                              </Button>
                            )}
                            {instance.deadOutbox > 0 && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleRetryOutbox(instance.id)}
                                title="Retry undelivered relays"
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                                Retry
                              </Button>
                            )}
                          </span>
                        </div>
                      )}

                      {expandedDead === instance.id && (
                        <DeadOutboxList instanceId={instance.id} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
});

export { Federation };
