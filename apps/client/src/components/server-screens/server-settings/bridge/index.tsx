import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Group } from '@/components/ui/group';
import { LoadingCard } from '@/components/ui/loading-card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { requestConfirmation } from '@/features/dialogs/actions';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { cn } from '@/lib/utils';
import { getTRPCClient } from '@/lib/trpc';
import type {
  TBridgeCreateMissing,
  TBridgeDirection,
  TBridgeMode,
  TBridgeServerStatus
} from '@pulse/server/types';
import { Link2, Link2Off, RefreshCw } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DIRECTION_OPTIONS, directionLabel, summarizeConnection } from '../../channel-settings/bridge/format';
import { QueryErrorRow } from '../query-state';
import {
  CREATE_MISSING_OPTIONS,
  createMissingLabel,
  DELETION_NOTE,
  describeSkipped,
  MODE_OPTIONS,
  modeLabel,
  summarizeCounts,
  summarizeSync
} from './format';
import { useRemoteGuilds, useServerBridgeStatus } from './hooks';

/**
 * Server Settings → Integrations → Bridge. Offered only while the
 * bridge plugin runs (the shell asks `servers.bridgeStatus`). Two
 * states: not linked — pick the remote server, how channels pair and the
 * default direction, link; linked — the pairing settings (changeable in
 * place), the counts, the last sync with what it skipped and why, "Sync
 * channels now" and "Unlink server".
 */

const TONE_CLASS = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  muted: 'bg-muted-foreground',
  busy: 'bg-sky-500 animate-pulse'
} as const;

type TSettings = {
  mode: TBridgeMode;
  createMissing: TBridgeCreateMissing;
  defaultDirection: TBridgeDirection;
};

const DEFAULT_SETTINGS: TSettings = { mode: 'match', createMissing: 'both', defaultDirection: 'both' };

const Dot = memo(({ tone }: { tone: keyof typeof TONE_CLASS }) => (
  <span aria-hidden="true" className={cn('inline-block h-2 w-2 shrink-0 rounded-full', TONE_CLASS[tone])} />
));

const ConnectionLine = memo(({ status }: { status: TBridgeServerStatus }) => {
  const summary = summarizeConnection(status);

  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Dot tone={summary.tone} />
      <span>{summary.text}</span>
    </p>
  );
});

type TPairingFieldsProps = {
  value: TSettings;
  onChange: (next: TSettings) => void;
  disabled: boolean;
};

/** Mode, what to create (mirror only) and the default direction — shared by both states. */
const PairingFields = memo(({ value, onChange, disabled }: TPairingFieldsProps) => (
  <>
    <Group
      label="How channels pair"
      description={MODE_OPTIONS.find((o) => o.value === value.mode)?.description}
    >
      <Select
        value={value.mode}
        onValueChange={(next) => onChange({ ...value, mode: next as TBridgeMode })}
        disabled={disabled}
      >
        <SelectTrigger className="w-full sm:w-72" aria-label="How channels pair">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Group>

    {value.mode === 'mirror' && (
      <Group
        label="Create missing channels"
        description={CREATE_MISSING_OPTIONS.find((o) => o.value === value.createMissing)?.description}
      >
        <Select
          value={value.createMissing}
          onValueChange={(next) => onChange({ ...value, createMissing: next as TBridgeCreateMissing })}
          disabled={disabled}
        >
          <SelectTrigger className="w-full sm:w-72" aria-label="Create missing channels">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CREATE_MISSING_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Group>
    )}

    <Group
      label="Default direction"
      description={`${DIRECTION_OPTIONS.find((o) => o.value === value.defaultDirection)?.description ?? ''} Each channel can set its own on its Bridge tab.`}
    >
      <Select
        value={value.defaultDirection}
        onValueChange={(next) => onChange({ ...value, defaultDirection: next as TBridgeDirection })}
        disabled={disabled}
      >
        <SelectTrigger className="w-full sm:w-72" aria-label="Default direction">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DIRECTION_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Group>
  </>
));

type TStatusCardProps = {
  status: TBridgeServerStatus;
  /** Injected by the render test; the component reads the clock otherwise. */
  now?: number;
};

/**
 * The linked state's facts: the remote server, the pairing settings in
 * words, the counts, the last sync and what it skipped. Pure — it
 * renders from the status alone, so it has a render test.
 */
const BridgeStatusCard = memo(({ status, now = Date.now() }: TStatusCardProps) => {
  const link = status.link;
  if (!link) return null;

  const sync = summarizeSync(status.sync, now);
  const skipped = describeSkipped(status.sync.last?.skipped ?? []);

  return (
    <div className="space-y-4" data-testid="bridge-status-card">
      <Group label="Linked to">
        <p className="text-sm">
          <span className="font-medium">{status.remoteGuildName ?? `server ${link.remoteGuildId}`}</span>
          <span className="text-muted-foreground">
            {' '}
            — {modeLabel(link.mode).toLowerCase()}
            {link.mode === 'mirror' ? `, creating missing channels ${createMissingLabel(link.createMissing).toLowerCase()}` : ''}
            , {directionLabel(link.defaultDirection).toLowerCase()} by default
          </span>
        </p>
      </Group>

      <Group label="Channels">
        <p className="text-sm text-muted-foreground">{summarizeCounts(status.counts)}</p>
      </Group>

      <Group label="Sync">
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Dot tone={sync.tone} />
          <span>{sync.text}</span>
        </p>
      </Group>

      {skipped.length > 0 && (
        <Group label="Left alone" description="Channels the last sync did not pair, and why.">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {skipped.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Group>
      )}

      {status.lastError && (
        <Alert variant="destructive">
          <AlertTitle>The bridge reported an error</AlertTitle>
          <AlertDescription>{status.lastError}</AlertDescription>
        </Alert>
      )}

      <p className="text-sm text-muted-foreground">{DELETION_NOTE}</p>
    </div>
  );
});

const Bridge = memo(() => {
  const { status, loading, error, refresh } = useServerBridgeStatus();
  const link = status?.link ?? null;
  const guilds = useRemoteGuilds(Boolean(status?.available && status.configured && !link));
  const [remoteGuildId, setRemoteGuildId] = useState<string | null>(null);
  const [settings, setSettings] = useState<TSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);

  // The pairing fields mirror the link on record; edits save at once.
  useEffect(() => {
    if (link) {
      setSettings({ mode: link.mode, createMissing: link.createMissing, defaultDirection: link.defaultDirection });
    }
  }, [link]);

  const save = useCallback(
    async (guildId: string, next: TSettings, success: string) => {
      const trpc = getTRPCClient();
      if (!trpc) return;

      setBusy(true);
      try {
        await trpc.servers.bridgeLink.mutate({ remoteGuildId: guildId, ...next });
        await refresh();
        toast.success(success);
      } catch (err) {
        toast.error(getTrpcError(err, 'Could not link the server'));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const onLink = useCallback(() => {
    if (!remoteGuildId) return;
    void save(remoteGuildId, settings, 'Server linked — pairing channels');
  }, [remoteGuildId, save, settings]);

  const onSettingsChange = useCallback(
    (next: TSettings) => {
      setSettings(next);
      if (link) void save(link.remoteGuildId, next, 'Bridge updated');
    },
    [link, save]
  );

  const onSync = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;

    setBusy(true);
    try {
      await trpc.servers.bridgeSync.mutate();
      await refresh();
      toast.success('Sync started');
    } catch (err) {
      toast.error(getTrpcError(err, 'Could not start the sync'));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const onUnlink = useCallback(async () => {
    if (!status) return;
    const paired = status.counts.paired;
    const confirmed = await requestConfirmation({
      title: 'Unlink this server',
      message: `${paired === 1 ? '1 channel pair' : `${paired} channel pairs`} and ${paired === 1 ? 'its webhook' : 'their webhooks'} on the other side are removed. Channels created on either side stay; channels linked on their own are untouched.`,
      confirmLabel: 'Unlink server',
      variant: 'danger'
    });
    if (!confirmed) return;

    const trpc = getTRPCClient();
    if (!trpc) return;

    setBusy(true);
    try {
      const result = await trpc.servers.bridgeUnlink.mutate();
      await refresh();
      toast.success(`Server unlinked — ${result.removed === 1 ? '1 pair' : `${result.removed} pairs`} removed`);
    } catch (err) {
      toast.error(getTrpcError(err, 'Could not unlink the server'));
    } finally {
      setBusy(false);
    }
  }, [refresh, status]);

  if (loading && !status) return <LoadingCard className="h-64" />;
  if (error && !status) return <QueryErrorRow message={error} onRetry={() => void refresh()} />;
  if (!status) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bridge</CardTitle>
        <CardDescription>
          Mirror this whole community with a server the bridge bot has joined. Channels pair by name or
          are created on the side that lacks them, new channels follow automatically, and each channel
          can opt out or set its own direction on its Bridge tab. Messages, edits, deletions, reactions,
          threads and scheduled events flow both ways. Voice is not bridged.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <ConnectionLine status={status} />

        {link && (
          <>
            <BridgeStatusCard status={status} />

            <PairingFields value={settings} onChange={onSettingsChange} disabled={busy} />

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void onSync()} disabled={busy || status.sync.running}>
                <RefreshCw className={cn('h-4 w-4', status.sync.running && 'animate-spin')} aria-hidden="true" />
                {status.sync.running ? 'Syncing…' : 'Sync channels now'}
              </Button>
              <Button variant="destructive" onClick={() => void onUnlink()} disabled={busy}>
                <Link2Off className="h-4 w-4" aria-hidden="true" />
                Unlink server
              </Button>
            </div>
          </>
        )}

        {!link && (
          <>
            <Group
              label="Remote server"
              description="The bot lists the servers it has been added to. Add it there first if the one you want is missing."
            >
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={remoteGuildId ?? ''}
                  onValueChange={(next) => setRemoteGuildId(next || null)}
                  disabled={!status.configured || busy || guilds.loading}
                >
                  <SelectTrigger className="w-full sm:w-72" aria-label="Remote server">
                    <SelectValue
                      placeholder={
                        !status.configured
                          ? 'No bot token set'
                          : guilds.loading
                            ? 'Loading…'
                            : guilds.guilds.length === 0
                              ? 'The bot is not in any server yet'
                              : 'Choose a server'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {guilds.guilds.map((guild) => (
                      <SelectItem key={guild.id} value={guild.id}>
                        {guild.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Reload the list"
                  onClick={guilds.reload}
                  disabled={!status.configured || busy}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </Group>

            <PairingFields value={settings} onChange={setSettings} disabled={busy} />

            {guilds.error && (
              <Alert variant="destructive">
                <AlertTitle>The list could not be loaded</AlertTitle>
                <AlertDescription>{guilds.error}</AlertDescription>
              </Alert>
            )}

            <p className="text-sm text-muted-foreground">{DELETION_NOTE}</p>

            <Button onClick={onLink} disabled={!remoteGuildId || busy || !status.configured}>
              <Link2 className="h-4 w-4" aria-hidden="true" />
              {busy ? 'Linking…' : 'Link server'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
});

export { Bridge, BridgeStatusCard };
