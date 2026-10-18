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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { requestConfirmation } from '@/features/dialogs/actions';
import { parseFollowAddress } from '@/features/follows/parse-source';
import { useChannelById } from '@/features/server/channels/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import type { TChannelFollowView, TFollowEndpoint } from '@pulse/server/types';
import { Copy, Globe, Hash, Megaphone, Rss } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useChannelFollows, useFollowCandidates } from './hooks';

type TFollowsProps = {
  channelId: number;
};

const endpointLabel = (e: TFollowEndpoint) =>
  e.kind === 'local' ? `#${e.channelName} · ${e.serverName}` : `${e.domain}/${e.channelPublicId}`;

const EndpointLine = memo(({ endpoint }: { endpoint: TFollowEndpoint }) => (
  <span className="flex min-w-0 items-center gap-2">
    {endpoint.kind === 'local' ? (
      <Hash className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    ) : (
      <Globe className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    )}
    <span className="truncate text-sm">{endpointLabel(endpoint)}</span>
    {endpoint.kind === 'remote' && (
      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        federated
      </span>
    )}
  </span>
));

const FollowList = memo(
  ({
    rows,
    side,
    onRemove,
    removeLabel
  }: {
    rows: TChannelFollowView[];
    side: 'source' | 'target';
    onRemove: (row: TChannelFollowView) => void;
    removeLabel: string;
  }) => (
    <ul className="flex flex-col divide-y divide-border/40 rounded-lg border border-border/60">
      {rows.map((row) => (
        <li key={row.id} className="flex items-center gap-2 px-3 py-2">
          <EndpointLine endpoint={row[side]} />
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 shrink-0"
            onClick={() => onRemove(row)}
            aria-label={`${removeLabel} ${endpointLabel(row[side])}`}
          >
            {removeLabel}
          </Button>
        </li>
      ))}
    </ul>
  )
);

/**
 * Channel Settings → Follows. The top card is what THIS channel
 * follows (pick an announcement channel you can see on this instance,
 * or type a peer's follow address); the bottom card appears for an
 * announcement channel and lists who follows it, with its own follow
 * address for peers to copy.
 */
const Follows = memo(({ channelId }: TFollowsProps) => {
  const channel = useChannelById(channelId);
  const { following, followers, address, loading, error, refresh } = useChannelFollows(channelId);
  const { candidates, loading: loadingCandidates } = useFollowCandidates();
  const [sourceId, setSourceId] = useState<string>('');
  const [remote, setRemote] = useState('');
  const [busy, setBusy] = useState(false);

  const followedIds = useMemo(
    () => new Set(following.map((f) => (f.source.kind === 'local' ? f.source.channelId : -1))),
    [following]
  );
  const pickable = useMemo(
    () => candidates.filter((c) => c.channelId !== channelId && !followedIds.has(c.channelId)),
    [candidates, channelId, followedIds]
  );
  const byServer = useMemo(() => {
    const groups = new Map<number, { serverName: string; items: typeof pickable }>();
    for (const c of pickable) {
      const g = groups.get(c.serverId) ?? { serverName: c.serverName, items: [] };
      g.items.push(c);
      groups.set(c.serverId, g);
    }
    return Array.from(groups.values());
  }, [pickable]);

  const remoteParsed = remote.trim().length > 0 ? parseFollowAddress(remote) : null;
  const remoteError =
    remote.trim().length > 0 && !remoteParsed ? 'Use the form domain/server-id/channel-id' : null;

  const run = useCallback(
    async (task: () => Promise<unknown>, fallback: string, success?: string) => {
      setBusy(true);
      try {
        await task();
        if (success) toast.success(success);
        await refresh();
      } catch (err) {
        toast.error(getTrpcError(err, fallback));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const followLocal = useCallback(() => {
    const trpc = getTRPCClient();
    if (!trpc || !sourceId) return;
    void run(
      async () => {
        await trpc.follows.follow.mutate({
          channelId,
          source: { kind: 'local', channelId: Number(sourceId) }
        });
        setSourceId('');
      },
      'Could not follow that channel',
      'Following'
    );
  }, [channelId, sourceId, run]);

  const followRemote = useCallback(() => {
    const trpc = getTRPCClient();
    if (!trpc || !remoteParsed) return;
    void run(
      async () => {
        const result = await trpc.follows.follow.mutate({
          channelId,
          source: { kind: 'remote', address: remote.trim() }
        });
        setRemote('');
        toast.success(
          result.status === 'pending'
            ? 'Follow requested — the peer is not reachable right now; it is delivered when it is.'
            : 'Following'
        );
      },
      'Could not follow that channel'
    );
  }, [channelId, remote, remoteParsed, run]);

  const unfollow = useCallback(
    async (row: TChannelFollowView, what: string) => {
      const ok = await requestConfirmation({
        title: what,
        message: 'Copies already made stay in the channel; new posts stop.',
        confirmLabel: what,
        cancelLabel: 'Keep'
      });
      if (!ok) return;
      const trpc = getTRPCClient();
      if (!trpc) return;
      void run(() => trpc.follows.unfollow.mutate({ followId: row.id }), 'Could not remove the follow');
    },
    [run]
  );

  const copyAddress = useCallback(async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      toast.success('Follow address copied');
    } catch {
      toast.error('Could not copy — select the address and copy it by hand');
    }
  }, [address]);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Rss className="h-4 w-4" aria-hidden="true" />
            Following
          </CardTitle>
          <CardDescription>
            Posts from the announcement channels this channel follows are copied here, with their
            edits and deletions. Reactions stay where they were made.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {!loading && following.length === 0 && (
            <p className="text-sm text-muted-foreground">This channel follows nothing yet.</p>
          )}
          {following.length > 0 && (
            <FollowList
              rows={following}
              side="source"
              removeLabel="Unfollow"
              onRemove={(row) => void unfollow(row, 'Unfollow')}
            />
          )}

          <Group
            label="Follow a channel on this instance"
            description="Announcement channels in communities you are a member of and can see."
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={sourceId} onValueChange={setSourceId} disabled={loadingCandidates || pickable.length === 0}>
                <SelectTrigger className="w-full sm:w-80" aria-label="Announcement channel to follow">
                  <SelectValue
                    placeholder={
                      loadingCandidates
                        ? 'Loading…'
                        : pickable.length === 0
                          ? 'No announcement channels to follow'
                          : 'Pick an announcement channel'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {byServer.map((group) => (
                    <SelectGroup key={group.serverName}>
                      <SelectLabel>{group.serverName}</SelectLabel>
                      {group.items.map((c) => (
                        <SelectItem key={c.channelId} value={String(c.channelId)}>
                          #{c.channelName}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={followLocal} disabled={!sourceId || busy}>
                Follow
              </Button>
            </div>
          </Group>

          <Group
            label="Follow a channel on a federated instance"
            description="Paste the follow address shown in that channel's settings: domain/server-id/channel-id."
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={remote}
                onChange={(e) => setRemote(e.target.value)}
                placeholder="peer.example/server-id/channel-id"
                aria-label="Follow address"
                aria-invalid={remoteError !== null}
                aria-describedby="follow-address-error"
                className="w-full sm:w-80"
              />
              <Button onClick={followRemote} disabled={!remoteParsed || busy}>
                Follow
              </Button>
            </div>
            <p id="follow-address-error" className="min-h-5 text-sm text-destructive" role="alert">
              {remoteError ?? ''}
            </p>
          </Group>
        </CardContent>
      </Card>

      {channel?.announcement && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Megaphone className="h-4 w-4" aria-hidden="true" />
              Followers
            </CardTitle>
            <CardDescription>
              Channels that receive a copy of every post made here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {!loading && followers.length === 0 && (
              <p className="text-sm text-muted-foreground">Nobody follows this channel yet.</p>
            )}
            {followers.length > 0 && (
              <FollowList
                rows={followers}
                side="target"
                removeLabel="Remove"
                onRemove={(row) => void unfollow(row, 'Remove follower')}
              />
            )}
            <Group
              label="Follow address"
              description={
                address
                  ? 'Give this to another instance so one of its channels can follow this one.'
                  : 'Federated following needs federation on, a federatable community, and a public channel.'
              }
            >
              {address && (
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" data-testid="follow-address">
                    {address}
                  </code>
                  <Button variant="outline" size="sm" onClick={() => void copyAddress()} aria-label="Copy follow address">
                    <Copy className="h-4 w-4" />
                    Copy
                  </Button>
                </div>
              )}
            </Group>
          </CardContent>
        </Card>
      )}
    </>
  );
});

export { Follows };
