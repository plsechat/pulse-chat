import { Button } from '@/components/ui/button';
import { getTRPCClient } from '@/lib/trpc';
import { AutomodRuleType, type TAutomodRule } from '@pulse/shared';
import { Plus, Shield, Trash } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

const RULE_TYPE_LABELS: Record<string, string> = {
  [AutomodRuleType.KEYWORD_FILTER]: 'Keyword Filter',
  [AutomodRuleType.SPAM_DETECTION]: 'Spam Detection',
  [AutomodRuleType.MENTION_SPAM]: 'Mention Spam',
  [AutomodRuleType.LINK_FILTER]: 'Link Filter'
};

const AutoMod = memo(() => {
  const [rules, setRules] = useState<TAutomodRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const fetchRules = useCallback(async () => {
    const trpc = getTRPCClient();
    try {
      const result = await trpc.automod.listRules.query();
      setRules(result as TAutomodRule[]);
    } catch {
      toast.error('Failed to load auto-mod rules');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const handleToggle = useCallback(
    async (ruleId: number, enabled: boolean) => {
      const trpc = getTRPCClient();
      try {
        await trpc.automod.toggleRule.mutate({ ruleId, enabled });
        setRules((prev) =>
          prev.map((r) => (r.id === ruleId ? { ...r, enabled } : r))
        );
      } catch {
        toast.error('Failed to toggle rule');
      }
    },
    []
  );

  const handleDelete = useCallback(async (ruleId: number) => {
    const trpc = getTRPCClient();
    try {
      await trpc.automod.deleteRule.mutate({ ruleId });
      setRules((prev) => prev.filter((r) => r.id !== ruleId));
      toast.success('Rule deleted');
    } catch {
      toast.error('Failed to delete rule');
    }
  }, []);

  const handleCreated = useCallback((rule: TAutomodRule) => {
    setRules((prev) => [...prev, rule]);
    setShowCreate(false);
  }, []);

  if (loading) {
    return (
      <div className="text-center text-sm text-muted-foreground py-8">
        Loading auto-mod rules...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Auto-Moderation</h3>
          <p className="text-sm text-muted-foreground">
            Automatically filter messages based on rules.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Create Rule
        </Button>
      </div>

      {showCreate && (
        <CreateAutomodRuleForm
          onCreated={handleCreated}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {rules.length === 0 && !showCreate && (
        <div className="text-center py-8 text-sm text-muted-foreground">
          <Shield className="mx-auto mb-2 h-8 w-8 opacity-50" />
          <p>No auto-mod rules. Create one to get started.</p>
        </div>
      )}

      <div className="space-y-2">
        {rules.map((rule) => (
          <div
            key={rule.id}
            className="flex items-center justify-between rounded-lg border border-border p-3"
          >
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{rule.name}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
                  {RULE_TYPE_LABELS[rule.type] ?? rule.type}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">
                {rule.enabled ? 'Active' : 'Disabled'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  onChange={(e) => handleToggle(rule.id, e.target.checked)}
                  className="rounded border-border"
                />
                <span className="text-xs text-muted-foreground">Enabled</span>
              </label>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive"
                onClick={() => handleDelete(rule.id)}
                title="Delete Rule"
              >
                <Trash className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

const CreateAutomodRuleForm = memo(
  ({
    onCreated,
    onCancel
  }: {
    onCreated: (rule: TAutomodRule) => void;
    onCancel: () => void;
  }) => {
    const [name, setName] = useState('');
    const [type, setType] = useState<AutomodRuleType>(
      AutomodRuleType.KEYWORD_FILTER
    );
    const [keywords, setKeywords] = useState('');
    const [maxMentions, setMaxMentions] = useState(10);
    const [blockedLinks, setBlockedLinks] = useState('');
    const [creating, setCreating] = useState(false);

    const handleCreate = useCallback(async () => {
      if (!name.trim() || creating) return;
      setCreating(true);
      const trpc = getTRPCClient();

      const config: Record<string, unknown> = {};
      if (type === AutomodRuleType.KEYWORD_FILTER) {
        config.keywords = keywords
          .split('\n')
          .map((k) => k.trim())
          .filter(Boolean);
      } else if (type === AutomodRuleType.MENTION_SPAM) {
        config.maxMentions = maxMentions;
      } else if (type === AutomodRuleType.LINK_FILTER) {
        config.blockedLinks = blockedLinks
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
      }

      try {
        const rule = await trpc.automod.createRule.mutate({
          name: name.trim(),
          type,
          config,
          actions: [{ type: 'delete_message' }, { type: 'log' }]
        });
        onCreated(rule as TAutomodRule);
        toast.success('Rule created');
      } catch {
        toast.error('Failed to create rule');
      } finally {
        setCreating(false);
      }
    }, [name, type, keywords, maxMentions, blockedLinks, creating, onCreated]);

    return (
      <div className="rounded-lg border border-border p-4 space-y-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rule name"
          className="w-full px-3 py-2 text-sm bg-muted/30 border border-border/50 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30"
          maxLength={100}
        />

        <select
          value={type}
          onChange={(e) => setType(e.target.value as AutomodRuleType)}
          className="w-full px-3 py-2 text-sm bg-muted/30 border border-border/50 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30"
        >
          {Object.entries(RULE_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        {type === AutomodRuleType.KEYWORD_FILTER && (
          <textarea
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="Keywords (one per line)"
            rows={4}
            className="w-full px-3 py-2 text-sm bg-muted/30 border border-border/50 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30 resize-none"
          />
        )}

        {type === AutomodRuleType.MENTION_SPAM && (
          <div className="flex items-center gap-2">
            <label className="text-sm text-muted-foreground">
              Max mentions:
            </label>
            <input
              type="number"
              value={maxMentions}
              onChange={(e) => setMaxMentions(parseInt(e.target.value) || 0)}
              min={1}
              max={100}
              className="w-20 px-3 py-2 text-sm bg-muted/30 border border-border/50 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
          </div>
        )}

        {type === AutomodRuleType.LINK_FILTER && (
          <textarea
            value={blockedLinks}
            onChange={(e) => setBlockedLinks(e.target.value)}
            placeholder="Blocked domains (one per line)"
            rows={4}
            className="w-full px-3 py-2 text-sm bg-muted/30 border border-border/50 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30 resize-none"
          />
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!name.trim() || creating}
          >
            {creating ? 'Creating...' : 'Create'}
          </Button>
        </div>
      </div>
    );
  }
);

export { AutoMod };
