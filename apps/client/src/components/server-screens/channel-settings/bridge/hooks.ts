import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import type {
  TBridgeRemoteChannel,
  TBridgeRemoteGuild,
  TBridgeStatus
} from '@pulse/server/types';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The Bridge tab's data: the channel's bridge status (also what decides
 * whether the tab is offered at all) and the remote picker's lists.
 * Plain tRPC calls; the status is refetched after every change the tab
 * makes rather than pushed, since nothing else on the client cares.
 */

export const useBridgeStatus = (channelId: number) => {
  const [status, setStatus] = useState<TBridgeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) {
      setLoading(false);
      return;
    }

    try {
      const next = await trpc.channels.bridgeStatus.query({ channelId });
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(getTrpcError(err, 'Could not load the bridge status'));
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, loading, error, refresh };
};

type TRemoteListing = {
  guilds: TBridgeRemoteGuild[];
  channels: TBridgeRemoteChannel[];
  guildId: string | null;
  loadingGuilds: boolean;
  loadingChannels: boolean;
  error: string | null;
  selectGuild: (guildId: string | null) => void;
  reload: () => void;
};

/**
 * The servers the bot sits in, and the text channels of the chosen
 * one. `enabled` is false while the bot is not connected (the lists
 * would only fail) or the tab shows an existing link whose guild is
 * fixed: then `initialGuildId` is listed straight away for the name.
 */
export const useRemoteListing = (enabled: boolean, initialGuildId: string | null): TRemoteListing => {
  const [guilds, setGuilds] = useState<TBridgeRemoteGuild[]>([]);
  const [channels, setChannels] = useState<TBridgeRemoteChannel[]>([]);
  const [guildId, setGuildId] = useState<string | null>(initialGuildId);
  const [loadingGuilds, setLoadingGuilds] = useState(false);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    setGuildId(initialGuildId);
  }, [initialGuildId]);

  useEffect(() => {
    if (!enabled) return;
    const trpc = getTRPCClient();
    if (!trpc) return;

    const ticket = ++latest.current;
    setLoadingGuilds(true);
    trpc.channels.bridgeRemoteChannels
      .query({})
      .then((listing) => {
        if (ticket !== latest.current) return;
        setGuilds(listing.guilds);
        setError(null);
      })
      .catch((err) => {
        if (ticket !== latest.current) return;
        setError(getTrpcError(err, 'Could not list the servers the bot is in'));
      })
      .finally(() => {
        if (ticket === latest.current) setLoadingGuilds(false);
      });
  }, [enabled, generation]);

  useEffect(() => {
    if (!enabled || !guildId) {
      setChannels([]);
      return;
    }
    const trpc = getTRPCClient();
    if (!trpc) return;

    let cancelled = false;
    setLoadingChannels(true);
    trpc.channels.bridgeRemoteChannels
      .query({ guildId })
      .then((listing) => {
        if (cancelled) return;
        setChannels(listing.channels);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(getTrpcError(err, 'Could not list the channels of that server'));
      })
      .finally(() => {
        if (!cancelled) setLoadingChannels(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, guildId, generation]);

  return {
    guilds,
    channels,
    guildId,
    loadingGuilds,
    loadingChannels,
    error,
    selectGuild: setGuildId,
    reload: () => setGeneration((g) => g + 1)
  };
};
