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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { requestConfirmation } from '@/features/dialogs/actions';
import { useChannelById } from '@/features/server/channels/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { cn } from '@/lib/utils';
import { getTRPCClient } from '@/lib/trpc';
import type { TBridgeDirection, TBridgeStatus } from '@pulse/server/types';
import { Link2, Link2Off, RefreshCw } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  DIRECTION_OPTIONS,
  directionLabel,
  remoteChannelLabel,
  summarizeConnection,
  whyNotBridgeable
} from './format';
import { useRemoteListing } from './hooks';

type TBridgeProps = {
  channelId: number;
  status: TBridgeStatus;
  refresh: () => Promise<void>;
};

const TONE_CLASS = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  muted: 'bg-muted-foreground'
} as const;

const ConnectionLine = memo(({ status }: { status: TBridgeStatus }) => {
  const summary = summarizeConnection(status);

  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <span
        aria-hidden="true"
        className={cn('inline-block h-2 w-2 shrink-0 rounded-full', TONE_CLASS[summary.tone])}
      />
      <span>{summary.text}</span>
    </p>
  );
});

const DirectionSelect = memo(
  ({
    value,
    onChange,
    disabled
  }: {
    value: TBridgeDirection;
    onChange: (direction: TBridgeDirection) => void;
    disabled?: boolean;
  }) => (
    <Select value={value} onValueChange={(next) => onChange(next as TBridgeDirection)} disabled={disabled}>
      <SelectTrigger className="w-full sm:w-64" aria-label="Direction">
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
  )
);

/**
 * Channel Settings → Bridge. Offered only while the bridge plugin runs
 * (the parent checks `status.available`). Two states: no link yet —
 * pick a server and a channel the bot can see, choose a direction,
 * link; linked — the pair, the direction (changeable in place), today's
 * count, the last error, and Unlink.
 */
const Bridge = memo(({ channelId, status, refresh }: TBridgeProps) => {
  const channel = useChannelById(channelId);
  const link = status.link;
  const listing = useRemoteListing(status.configured, link?.remoteGuildId ?? null);
  const [remoteChannelId, setRemoteChannelId] = useState<string | null>(null);
  const [direction, setDirection] = useState<TBridgeDirection>('both');
  const [busy, setBusy] = useState(false);

  const linkedChannelName = useMemo(
    () => (link ? remoteChannelLabel(listing.channels, link.remoteChannelId) : ''),
    [link, listing.channels]
  );
  const linkedGuildName = useMemo(
    () => (link ? (listing.guilds.find((g) => g.id === link.remoteGuildId)?.name ?? null) : null),
    [link, listing.guilds]
  );

  const submitLink = useCallback(
    async (nextDirection: TBridgeDirection, remoteGuildId: string, targetChannelId: string) => {
      const trpc = getTRPCClient();
      if (!trpc) return;

      setBusy(true);
      try {
        await trpc.channels.bridgeLink.mutate({
          channelId,
          remoteGuildId,
          remoteChannelId: targetChannelId,
          direction: nextDirection
        });
        await refresh();
        toast.success(link ? 'Bridge updated' : 'Channel bridged');
      } catch (error) {
        toast.error(getTrpcError(error, 'Could not bridge the channel'));
      } finally {
        setBusy(false);
      }
    },
    [channelId, link, refresh]
  );

  const onLink = useCallback(() => {
    if (!listing.guildId || !remoteChannelId) return;
    void submitLink(direction, listing.guildId, remoteChannelId);
  }, [direction, listing.guildId, remoteChannelId, submitLink]);

  const onDirectionChange = useCallback(
    (next: TBridgeDirection) => {
      if (!link) {
        setDirection(next);
        return;
      }
      void submitLink(next, link.remoteGuildId, link.remoteChannelId);
    },
    [link, submitLink]
  );

  const onUnlink = useCallback(async () => {
    const confirmed = await requestConfirmation({
      title: 'Unlink this channel',
      message:
        'Messages stop flowing in both directions and the webhook on the other side is removed. What has already been mirrored stays.',
      confirmLabel: 'Unlink',
      variant: 'danger'
    });
    if (!confirmed) return;

    const trpc = getTRPCClient();
    if (!trpc) return;

    setBusy(true);
    try {
      await trpc.channels.bridgeUnlink.mutate({ channelId });
      await refresh();
      toast.success('Channel unlinked');
    } catch (error) {
      toast.error(getTrpcError(error, 'Could not unlink the channel'));
    } finally {
      setBusy(false);
    }
  }, [channelId, refresh]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bridge</CardTitle>
        <CardDescription>
          Mirror this channel with a channel on a server the bridge bot has joined. Messages, edits,
          deletions, reactions, threads and scheduled events flow both ways and each side shows the
          other's authors by name and avatar. Voice is not bridged.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <ConnectionLine status={status} />

        {!status.bridgeable && channel && (
          <Alert>
            <AlertTitle>This channel cannot be bridged</AlertTitle>
            <AlertDescription>{whyNotBridgeable(channel)}</AlertDescription>
          </Alert>
        )}

        {status.bridgeable && link && (
          <>
            <Group label="Linked to">
              <p className="text-sm">
                <span className="font-medium">{linkedChannelName}</span>
                {linkedGuildName && <span className="text-muted-foreground"> in {linkedGuildName}</span>}
              </p>
            </Group>

            <Group
              label="Direction"
              description={DIRECTION_OPTIONS.find((o) => o.value === link.direction)?.description}
            >
              <DirectionSelect value={link.direction} onChange={onDirectionChange} disabled={busy} />
            </Group>

            <Group label="Today">
              <p className="text-sm text-muted-foreground">
                {status.mirroredToday === 1
                  ? '1 message mirrored since midnight (UTC).'
                  : `${status.mirroredToday} messages mirrored since midnight (UTC).`}
              </p>
            </Group>

            {status.linkError && (
              <Alert variant="destructive">
                <AlertTitle>The last message could not be mirrored</AlertTitle>
                <AlertDescription>{status.linkError}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void refresh()} disabled={busy}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Refresh
              </Button>
              <Button variant="destructive" onClick={() => void onUnlink()} disabled={busy}>
                <Link2Off className="h-4 w-4" aria-hidden="true" />
                Unlink
              </Button>
            </div>
          </>
        )}

        {status.bridgeable && !link && (
          <>
            <Group
              label="Server"
              description="The bot lists the servers it has been added to. Add it there first if the one you want is missing."
            >
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={listing.guildId ?? ''}
                  onValueChange={(next) => {
                    listing.selectGuild(next || null);
                    setRemoteChannelId(null);
                  }}
                  disabled={!status.configured || busy || listing.loadingGuilds}
                >
                  <SelectTrigger className="w-full sm:w-72" aria-label="Server">
                    <SelectValue
                      placeholder={
                        !status.configured
                          ? 'No bot token set'
                          : listing.loadingGuilds
                            ? 'Loading…'
                            : listing.guilds.length === 0
                              ? 'The bot is not in any server yet'
                              : 'Choose a server'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {listing.guilds.map((guild) => (
                      <SelectItem key={guild.id} value={guild.id}>
                        {guild.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Reload the lists"
                  onClick={listing.reload}
                  disabled={!status.configured || busy}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </Group>

            <Group label="Channel" description="Text and announcement channels the bot can see.">
              <Select
                value={remoteChannelId ?? ''}
                onValueChange={(next) => setRemoteChannelId(next || null)}
                disabled={!listing.guildId || busy || listing.loadingChannels}
              >
                <SelectTrigger className="w-full sm:w-72" aria-label="Channel">
                  <SelectValue
                    placeholder={
                      !listing.guildId
                        ? 'Choose a server first'
                        : listing.loadingChannels
                          ? 'Loading…'
                          : listing.channels.length === 0
                            ? 'No text channels the bot can see'
                            : 'Choose a channel'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {listing.channels.map((remote) => (
                    <SelectItem key={remote.id} value={remote.id}>
                      {remote.parentName ? `${remote.parentName} / #${remote.name}` : `#${remote.name}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Group>

            <Group
              label="Direction"
              description={DIRECTION_OPTIONS.find((o) => o.value === direction)?.description}
            >
              <DirectionSelect value={direction} onChange={onDirectionChange} disabled={busy} />
            </Group>

            {listing.error && (
              <Alert variant="destructive">
                <AlertTitle>The lists could not be loaded</AlertTitle>
                <AlertDescription>{listing.error}</AlertDescription>
              </Alert>
            )}

            <Button onClick={onLink} disabled={!listing.guildId || !remoteChannelId || busy}>
              <Link2 className="h-4 w-4" aria-hidden="true" />
              {busy ? 'Linking…' : `Link channel (${directionLabel(direction).toLowerCase()})`}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
});

export { Bridge };
