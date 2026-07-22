import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getTRPCClient } from '@/lib/trpc';
import { filesize } from 'filesize';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { MetricChart } from './metric-chart';

type THealth = {
  version: string;
  bunVersion: string;
  uptimeMs: number;
  memory: { rss: number; heapUsed: number };
  connections: { onlineUsers: number; connections: number };
  voice: { serverRooms: number; dmRooms: number; participants: number };
  federation: {
    domain: string;
    name: string | null;
    status: string;
    direction: string;
    lastSeenAt: number | null;
  }[];
  database: {
    sizeBytes: number;
    users: number;
    deletedUsers: number;
    servers: number;
    channels: number;
    messages: number;
  };
  storage: { totalBytes: number; fileCount: number };
};

type TMetricSample = {
  ts: number;
  cpuSystemPercent: number;
  cpuProcessPercent: number;
  rssBytes: number;
  heapUsedBytes: number;
  elLagMs: number;
  wsConnections: number;
  voiceParticipants: number;
  netRxBps: number;
  netTxBps: number;
};

// Series pair: chart-1 ↔ chart-3, NOT chart-1 ↔ chart-2 — the default
// theme's 1/2 are adjacent teal/green (ΔE ~10, below the legibility
// floor); 1/3 was validated across every theme (sunset + sand chart-3
// re-stepped for it).
const CHART_1 = 'var(--chart-1)';
const CHART_3 = 'var(--chart-3)';
const HOUR_MS = 60 * 60 * 1000;

const formatUptime = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d > 0 ? `${d}d ${h}h ${m % 60}m` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-lg border border-border bg-muted/20 p-3">
    <p className="text-xs text-muted-foreground">{label}</p>
    <p className="text-lg font-semibold text-foreground">{value}</p>
  </div>
);

/** Runtime health — metadata and resource totals, never content. */
const InstanceHealth = () => {
  const [health, setHealth] = useState<THealth | null>(null);
  const [samples, setSamples] = useState<TMetricSample[]>([]);
  const [rangeMs, setRangeMs] = useState(HOUR_MS);

  const fetchHealth = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    setHealth(await trpc.admin.getHealth.query());
  }, []);

  const fetchMetrics = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;
    const result = await trpc.admin.getMetrics.query({ sinceMs: rangeMs });
    setSamples([...result.samples]);
  }, [rangeMs]);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  // The sampler ticks every 15s server-side; poll on the same cadence
  // so the graphs stay live while the panel is open.
  useEffect(() => {
    fetchMetrics();
    const timer = setInterval(fetchMetrics, 15_000);
    return () => clearInterval(timer);
  }, [fetchMetrics]);

  if (!health) return null;

  const pts = (pick: (s: TMetricSample) => number) =>
    samples.map((s) => ({ ts: s.ts, v: pick(s) }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Server version" value={`v${health.version}`} />
        <Stat label="Bun" value={health.bunVersion} />
        <Stat label="Uptime" value={formatUptime(health.uptimeMs)} />
        <Stat label="Memory (RSS)" value={String(filesize(health.memory.rss))} />
        <Stat label="Online users" value={String(health.connections.onlineUsers)} />
        <Stat label="Connections" value={String(health.connections.connections)} />
        <Stat
          label="Voice rooms"
          value={`${health.voice.serverRooms + health.voice.dmRooms} (${health.voice.participants} in call)`}
        />
        <Stat label="Database size" value={String(filesize(health.database.sizeBytes))} />
        <Stat
          label="Accounts"
          value={`${health.database.users}${health.database.deletedUsers ? ` (${health.database.deletedUsers} deleted)` : ''}`}
        />
        <Stat label="Servers" value={String(health.database.servers)} />
        <Stat label="Channels" value={String(health.database.channels)} />
        <Stat label="Messages" value={String(health.database.messages)} />
        <Stat label="Stored files" value={String(health.storage.fileCount)} />
        <Stat label="Storage used" value={String(filesize(health.storage.totalBytes))} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium text-foreground">
            Last {rangeMs === HOUR_MS ? 'hour' : '6 hours'}
          </h4>
          <div className="ml-auto flex gap-1">
            {(
              [
                [HOUR_MS, '1h'],
                [6 * HOUR_MS, '6h']
              ] as const
            ).map(([ms, label]) => (
              <Button
                key={label}
                size="sm"
                variant={rangeMs === ms ? 'default' : 'secondary'}
                onClick={() => setRangeMs(ms)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        {samples.length < 2 ? (
          <p className="rounded-lg border border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
            Collecting samples — graphs appear after a minute of uptime.
          </p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            <MetricChart
              title="CPU"
              format={(v) => `${v.toFixed(1)}%`}
              series={[
                {
                  label: 'System',
                  color: CHART_1,
                  points: pts((s) => s.cpuSystemPercent)
                },
                {
                  label: 'Pulse process',
                  color: CHART_3,
                  points: pts((s) => s.cpuProcessPercent)
                }
              ]}
            />
            <MetricChart
              title="Memory"
              format={(v) => String(filesize(v))}
              series={[
                { label: 'RSS', color: CHART_1, points: pts((s) => s.rssBytes) },
                {
                  label: 'Heap used',
                  color: CHART_3,
                  points: pts((s) => s.heapUsedBytes)
                }
              ]}
            />
            <MetricChart
              title="Network"
              format={(v) => `${filesize(v)}/s`}
              series={[
                {
                  label: 'Received',
                  color: CHART_1,
                  points: pts((s) => s.netRxBps)
                },
                { label: 'Sent', color: CHART_3, points: pts((s) => s.netTxBps) }
              ]}
            />
            <MetricChart
              title="Event-loop lag"
              format={(v) => `${v.toFixed(1)} ms`}
              series={[
                { label: 'Lag', color: CHART_1, points: pts((s) => s.elLagMs) }
              ]}
            />
            <MetricChart
              title="Connections"
              format={(v) => String(Math.round(v))}
              series={[
                {
                  label: 'WebSocket',
                  color: CHART_1,
                  points: pts((s) => s.wsConnections)
                },
                {
                  label: 'In voice',
                  color: CHART_3,
                  points: pts((s) => s.voiceParticipants)
                }
              ]}
            />
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-foreground">
            Federation peers
          </h4>
          <Button size="sm" variant="ghost" onClick={fetchHealth}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
        {health.federation.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No federated instances.
          </p>
        ) : (
          <div className="space-y-2">
            {health.federation.map((peer) => (
              <div
                key={peer.domain}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm"
              >
                <span className="font-medium text-foreground">
                  {peer.name || peer.domain}
                </span>
                <span className="text-muted-foreground">{peer.domain}</span>
                <Badge
                  variant={peer.status === 'active' ? 'default' : 'secondary'}
                >
                  {peer.status}
                </Badge>
                <Badge variant="outline">{peer.direction}</Badge>
                <span className="ml-auto text-xs text-muted-foreground">
                  {peer.lastSeenAt
                    ? `last seen ${new Date(peer.lastSeenAt).toLocaleString()}`
                    : 'never seen'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export { InstanceHealth };
