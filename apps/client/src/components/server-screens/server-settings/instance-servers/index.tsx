import { Badge } from '@/components/ui/badge';
import { getTRPCClient } from '@/lib/trpc';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

type TAdminServerRow = {
  id: number;
  publicId: string;
  name: string;
  description: string | null;
  ownerId: number | null;
  ownerName: string | null;
  ownerDeleted: boolean;
  hasPassword: boolean;
  discoverable: boolean;
  federatable: boolean;
  enablePlugins: boolean;
  allowNewUsers: boolean;
  createdAt: number;
  memberCount: number;
  channelCount: number;
};

type TServerInfo = {
  categoryCount: number;
  roleCount: number;
  inviteCount: number;
  emojiCount: number;
  webhookCount: number;
  messageCount: number;
};

const InfoStat = ({ label, value }: { label: string; value: number }) => (
  <div className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
    <div className="text-base font-semibold tabular-nums">{value}</div>
    <div className="text-xs text-muted-foreground">{label}</div>
  </div>
);

/**
 * Global server directory — every server on the instance with its
 * owner and counts; expanding a row pulls the content drill-down
 * (messages, roles, invites, …) on demand.
 */
const InstanceServers = () => {
  const [rows, setRows] = useState<TAdminServerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);
  const [info, setInfo] = useState<Record<number, TServerInfo>>({});

  const fetchServers = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    setLoading(true);
    try {
      setRows(await trpc.admin.listServers.query());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  const toggle = async (serverId: number) => {
    if (openId === serverId) {
      setOpenId(null);
      return;
    }
    setOpenId(serverId);
    if (!info[serverId]) {
      const trpc = getTRPCClient();
      if (!trpc) return;
      const details = await trpc.admin.getServerInfo.query({ serverId });
      setInfo((prev) => ({ ...prev, [serverId]: details }));
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/20 divide-y divide-border/60">
        {rows.map((server) => {
          const open = openId === server.id;
          const details = info[server.id];
          return (
            <div key={server.id}>
              <button
                type="button"
                onClick={() => toggle(server.id)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/40"
              >
                {open ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{server.name}</span>
                    {server.hasPassword && (
                      <Badge variant="outline">Password</Badge>
                    )}
                    {server.discoverable && (
                      <Badge variant="secondary">Discoverable</Badge>
                    )}
                    {server.federatable && (
                      <Badge variant="secondary">Federatable</Badge>
                    )}
                    {server.enablePlugins && (
                      <Badge variant="secondary">Plugins</Badge>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    Owned by{' '}
                    {server.ownerName ?? 'nobody'}
                    {server.ownerDeleted ? ' (deleted account)' : ''} · created{' '}
                    {new Date(server.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div className="shrink-0 text-right text-xs text-muted-foreground">
                  <div className="text-sm font-medium tabular-nums text-foreground">
                    {server.memberCount}
                  </div>
                  member{server.memberCount === 1 ? '' : 's'}
                </div>
              </button>
              {open && (
                <div className="space-y-3 border-t border-border/60 bg-background/30 px-4 py-3">
                  {server.description && (
                    <p className="text-sm text-muted-foreground">
                      {server.description}
                    </p>
                  )}
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                    <InfoStat label="Channels" value={server.channelCount} />
                    {details ? (
                      <>
                        <InfoStat
                          label="Messages"
                          value={details.messageCount}
                        />
                        <InfoStat label="Roles" value={details.roleCount} />
                        <InfoStat label="Invites" value={details.inviteCount} />
                        <InfoStat label="Emojis" value={details.emojiCount} />
                        <InfoStat
                          label="Webhooks"
                          value={details.webhookCount}
                        />
                      </>
                    ) : (
                      <div className="col-span-2 self-center text-xs text-muted-foreground">
                        Loading…
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {server.publicId} · registration{' '}
                    {server.allowNewUsers ? 'open' : 'closed'}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!loading && rows.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No servers on this instance.
          </div>
        )}
      </div>
    </div>
  );
};

export { InstanceServers };
