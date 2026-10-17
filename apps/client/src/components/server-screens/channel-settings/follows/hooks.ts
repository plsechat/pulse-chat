import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { onAppEvent } from '@/lib/events';
import { getTRPCClient } from '@/lib/trpc';
import type { TChannelFollowView, TFollowSourceCandidate } from '@pulse/server/types';
import { useCallback, useEffect, useState } from 'react';

type TFollowsState = {
  following: TChannelFollowView[];
  followers: TChannelFollowView[];
  /** What a peer types to follow this channel; null when it is not followable from outside. */
  address: string | null;
};

/**
 * The Follows tab's data: both relations of the channel, refetched on
 * the server's CHANNEL_FOLLOWS_UPDATE ping, and the announcement
 * channels the caller may pick as a source.
 */
export const useChannelFollows = (channelId: number) => {
  const [state, setState] = useState<TFollowsState>({ following: [], followers: [], address: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) {
      setLoading(false);
      return;
    }
    try {
      setState(await trpc.follows.list.query({ channelId }));
      setError(null);
    } catch (err) {
      setError(getTrpcError(err, 'Could not load the follows'));
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      onAppEvent('channel-follows-changed', (payload) => {
        if (payload.channelId === channelId) void refresh();
      }),
    [channelId, refresh]
  );

  return { ...state, loading, error, refresh };
};

export const useFollowCandidates = () => {
  const [candidates, setCandidates] = useState<TFollowSourceCandidate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const trpc = getTRPCClient();
    if (!trpc) {
      setLoading(false);
      return;
    }
    trpc.follows.candidates
      .query()
      .then((list) => {
        if (!cancelled) setCandidates(list);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { candidates, loading };
};
