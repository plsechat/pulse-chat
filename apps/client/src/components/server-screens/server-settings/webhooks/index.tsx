import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { useChannels } from '@/features/server/channels/hooks';
import { getTRPCClient } from '@/lib/trpc';
import type { TWebhook } from '@pulse/shared';
import { Copy, Plus, Trash } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

const Webhooks = memo(() => {
  const [webhooks, setWebhooks] = useState<TWebhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const channels = useChannels();

  const fetchWebhooks = useCallback(async () => {
    const trpc = getTRPCClient();
    try {
      const result = await trpc.webhooks.list.query({});
      setWebhooks(result);
    } catch {
      toast.error('Failed to load webhooks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWebhooks();
  }, [fetchWebhooks]);

  const handleDelete = useCallback(
    async (webhookId: number) => {
      const trpc = getTRPCClient();
      try {
        await trpc.webhooks.delete.mutate({ webhookId });
        setWebhooks((prev) => prev.filter((w) => w.id !== webhookId));
        toast.success('Webhook deleted');
      } catch {
        toast.error('Failed to delete webhook');
      }
    },
    []
  );

  const handleCopyUrl = useCallback((webhook: TWebhook) => {
    const url = `${window.location.origin}/webhooks/${webhook.id}/${webhook.token}`;
    navigator.clipboard.writeText(url);
    toast.success('Webhook URL copied');
  }, []);

  const handleCreated = useCallback(
    (webhook: TWebhook) => {
      setWebhooks((prev) => [...prev, webhook]);
      setShowCreate(false);
    },
    []
  );

  if (loading) {
    return (
      <div className="text-center text-sm text-muted-foreground py-8">
        Loading webhooks...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Webhooks</h3>
          <p className="text-sm text-muted-foreground">
            Webhooks allow external services to send messages to your channels.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Create Webhook
        </Button>
      </div>

      {showCreate && (
        <CreateWebhookForm
          onCreated={handleCreated}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {webhooks.length === 0 && !showCreate && (
        <div className="text-center py-8 text-sm text-muted-foreground">
          No webhooks yet. Create one to get started.
        </div>
      )}

      <div className="space-y-2">
        {webhooks.map((webhook) => {
          const channel = channels.find((c) => c.id === webhook.channelId);
          return (
            <div
              key={webhook.id}
              className="flex items-center justify-between rounded-lg border border-border p-3"
            >
              <div className="flex flex-col gap-0.5">
                <span className="font-medium text-sm">{webhook.name}</span>
                <span className="text-xs text-muted-foreground">
                  #{channel?.name ?? 'Unknown'} &middot; ID: {webhook.id}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => handleCopyUrl(webhook)}
                  title="Copy Webhook URL"
                >
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => handleDelete(webhook.id)}
                  title="Delete Webhook"
                >
                  <Trash className="h-4 w-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

const CreateWebhookForm = memo(
  ({
    onCreated,
    onCancel
  }: {
    onCreated: (webhook: TWebhook) => void;
    onCancel: () => void;
  }) => {
    const [name, setName] = useState('');
    const [channelId, setChannelId] = useState<number | ''>('');
    const [creating, setCreating] = useState(false);
    const channels = useChannels();

    const textChannels = channels.filter(
      (c) => c.type === 'TEXT' || c.type === 'FORUM'
    );

    const handleCreate = useCallback(async () => {
      if (!name.trim() || !channelId || creating) return;
      setCreating(true);
      const trpc = getTRPCClient();
      try {
        const webhook = await trpc.webhooks.create.mutate({
          name: name.trim(),
          channelId: channelId as number
        });
        onCreated(webhook);
        toast.success('Webhook created');
      } catch {
        toast.error('Failed to create webhook');
      } finally {
        setCreating(false);
      }
    }, [name, channelId, creating, onCreated]);

    return (
      <div className="rounded-lg border border-border p-4 space-y-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Webhook name"
          className="w-full px-3 py-2 text-sm bg-muted/30 border border-border/50 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30"
          maxLength={80}
        />
        <Select
          value={channelId ? String(channelId) : ''}
          onValueChange={(value) =>
            setChannelId(value ? parseInt(value) : '')
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select channel" />
          </SelectTrigger>
          <SelectContent>
            {textChannels.map((ch) => (
              <SelectItem key={ch.id} value={String(ch.id)}>
                #{ch.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!name.trim() || !channelId || creating}
          >
            {creating ? 'Creating...' : 'Create'}
          </Button>
        </div>
      </div>
    );
  }
);

export { Webhooks };
