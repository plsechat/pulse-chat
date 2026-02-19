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
import { getTRPCClient, getHomeTRPCClient } from '@/lib/trpc';
import type {
  TFederationConfig,
  TFederationInstanceSummary
} from '@pulse/shared';
import {
  Globe,
  Key,
  Link,
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
  const [addUrl, setAddUrl] = useState('');
  const [adding, setAdding] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const trpc = getTRPCClient();
      const [configResult, instancesResult] = await Promise.all([
        trpc.federation.getConfig.query(),
        trpc.federation.listInstances.query()
      ]);
      setConfig(configResult);
      setInstances(instancesResult);
      setDomain(configResult.domain);
      setEnabled(configResult.enabled);
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
    const sub = trpc.federation.onInstanceUpdate.subscribe(undefined, {
      onData: () => fetchData(),
      onError: (err) =>
        console.error('onFederationInstanceUpdate subscription error:', err)
    });

    return () => sub.unsubscribe();
  }, [fetchData]);

  const handleSaveConfig = useCallback(async () => {
    try {
      const trpc = getTRPCClient();
      await trpc.federation.setConfig.mutate({ enabled, domain });
      toast.success('Federation settings saved');
      fetchData();
    } catch (error) {
      console.error('Failed to save federation config:', error);
      toast.error('Failed to save settings');
    }
  }, [enabled, domain, fetchData]);

  const handleAddInstance = useCallback(async () => {
    if (!addUrl.trim()) return;

    setAdding(true);
    try {
      const trpc = getTRPCClient();
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
        const trpc = getTRPCClient();
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
        const trpc = getTRPCClient();
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
        const trpc = getTRPCClient();
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
                {instances.map((instance) => (
                  <div
                    key={instance.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
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
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {instance.domain}
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
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
});

export { Federation };
