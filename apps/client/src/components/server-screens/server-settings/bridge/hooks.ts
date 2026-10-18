import { useActiveServerId } from '@/features/app/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import type { TBridgeRemoteGuild, TBridgeServerStatus } from '@pulse/server/types';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Data of Server Settings → Bridge. The status is a plain tRPC query
 * refetched after every change the section makes; while the server
 * reports a sync in progress it is polled, since pairing hundreds of
 * channels takes minutes and the owner wants to watch the counts move.
 */

const SYNC_POLL_MS = 3_000;

export const useServerBridgeStatus = () => {
  const serverId = useActiveServerId();
  const [status, setStatus] = useState<TBridgeServerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) {
      setLoading(false);
      return;
    }

    const ticket = ++latest.current;
    try {
      const next = await trpc.servers.bridgeStatus.query();
      if (ticket !== latest.current) return;
      setStatus(next);
      setError(null);
    } catch (err) {
      if (ticket !== latest.current) return;
      setError(getTrpcError(err, 'Could not load the bridge status'));
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setStatus(null);
    setLoading(true);
    void refresh();
  }, [refresh, serverId]);

  const running = status?.sync.running ?? false;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  return { status, loading, error, refresh };
};

/**
 * Whether the settings shell lists the Bridge section at all: the
 * plugin must be running on the instance. Asked only when the caller
 * may (MANAGE_SETTINGS), once per server, so a member without the
 * permission never triggers a FORBIDDEN round-trip for a nav entry.
 */
export const useServerBridgeAvailable = (enabled: boolean): boolean => {
  const serverId = useActiveServerId();
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    setAvailable(false);
    if (!enabled) return;
    const trpc = getTRPCClient();
    if (!trpc) return;

    let cancelled = false;
    trpc.servers.bridgeStatus
      .query()
      .then((status) => {
        if (!cancelled) setAvailable(status.available);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, serverId]);

  return available;
};

/** The servers the bot sits in, for the picker; `enabled` while a token is set and nothing is linked yet. */
export const useRemoteGuilds = (enabled: boolean) => {
  const [guilds, setGuilds] = useState<TBridgeRemoteGuild[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const trpc = getTRPCClient();
    if (!trpc) return;

    const ticket = ++latest.current;
    setLoading(true);
    trpc.servers.bridgeRemoteGuilds
      .query()
      .then((list) => {
        if (ticket !== latest.current) return;
        setGuilds(list);
        setError(null);
      })
      .catch((err) => {
        if (ticket !== latest.current) return;
        setError(getTrpcError(err, 'Could not list the servers the bot is in'));
      })
      .finally(() => {
        if (ticket === latest.current) setLoading(false);
      });
  }, [enabled, generation]);

  return { guilds, loading, error, reload: () => setGeneration((g) => g + 1) };
};
