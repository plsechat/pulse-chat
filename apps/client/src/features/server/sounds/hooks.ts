import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedServerSound } from '@pulse/server/types';
import { useCallback, useEffect, useState } from 'react';

/**
 * The active server's soundboard for the settings panel: fetched once,
 * then patched in place from the sound events (another admin's change
 * shows up without a refetch). The clip list does not live in Redux —
 * only the settings panel reads it, and the in-call grid asks the
 * session's server directly (voice.listSounds).
 */
export const useServerSounds = (serverId: number | undefined) => {
  const [sounds, setSounds] = useState<TJoinedServerSound[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc || !serverId) return;
    setLoading(true);
    try {
      setSounds(await trpc.sounds.getAll.query());
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    const trpc = getTRPCClient();
    if (!trpc || !serverId) return;

    return combineUnsubscribes(
      subscribe('onSoundCreate', trpc.sounds.onCreate, (sound) => {
        if (sound.serverId !== serverId) return;
        setSounds((prev) =>
          prev.some((s) => s.id === sound.id) ? prev : [...prev, sound]
        );
      }),
      subscribe('onSoundUpdate', trpc.sounds.onUpdate, (sound) => {
        if (sound.serverId !== serverId) return;
        setSounds((prev) => prev.map((s) => (s.id === sound.id ? sound : s)));
      }),
      subscribe('onSoundDelete', trpc.sounds.onDelete, ({ soundId }) => {
        setSounds((prev) => prev.filter((s) => s.id !== soundId));
      })
    );
  }, [serverId]);

  return { sounds, loading, refetch };
};
