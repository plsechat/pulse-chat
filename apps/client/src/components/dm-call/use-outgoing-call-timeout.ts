import { leaveDmVoiceCall } from '@/features/dms/actions';
import {
  useDmActiveCalls,
  useOwnDmCallChannelId
} from '@/features/dms/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

const SOLO_TIMEOUT_MS = 30_000;

/**
 * Watch the user's current DM voice call. If they are the only
 * participant for SOLO_TIMEOUT_MS, auto-leave the call. Covers two
 * symmetric cases:
 *
 *  - Outgoing call where no one answered: caller starts alone, peer
 *    never joins → "No answer" toast on auto-leave.
 *  - Active call where everyone else dropped: caller had peers, now
 *    they're gone → "Call ended" toast on auto-leave.
 *
 * Only DM voice calls — server voice channels often have legitimate
 * solo occupancy (waiting for friends, music bots, etc.) and an
 * auto-kick there would be hostile. If we ever want a server-channel
 * version it should be opt-in per channel.
 *
 * Mounted at the App root *inside* VoiceProvider so leaveDmVoiceCall
 * tears down the real Mediasoup transports, not the no-op stub from
 * the default context.
 */
const useOutgoingCallTimeout = () => {
  const ownDmCallChannelId = useOwnDmCallChannelId();
  const activeCalls = useDmActiveCalls();
  const ownUserId = useOwnUserId();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks whether at least one peer has ever been in the call with
  // us. Drives the toast text on auto-leave: never-joined vs. left.
  const hadPeerRef = useRef(false);

  useEffect(() => {
    if (ownDmCallChannelId === undefined || ownUserId == null) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Reset for the next call so a previous "had peer" doesn't
      // bleed into a fresh outgoing one.
      hadPeerRef.current = false;
      return;
    }

    const call = activeCalls[ownDmCallChannelId];
    const userIds = call ? Object.keys(call.users).map(Number) : [];
    const otherJoined = userIds.some((id) => id !== ownUserId);

    if (otherJoined) {
      hadPeerRef.current = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    // Solo. Start the timer if not already running.
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;

      // Re-check at fire time — a join might have landed in state
      // after we scheduled but before the timer ran.
      const ownStillSet = ownDmCallChannelId !== undefined;
      if (!ownStillSet) return;
      const liveCall = activeCalls[ownDmCallChannelId];
      const liveUserIds = liveCall
        ? Object.keys(liveCall.users).map(Number)
        : [];
      const liveOther = liveUserIds.some((id) => id !== ownUserId);
      if (liveOther) return;

      const message = hadPeerRef.current ? 'Call ended' : 'No answer';
      // Best-effort — surface the toast even if the server-side
      // leave call fails.
      leaveDmVoiceCall().catch(() => {});
      toast.info(message);
    }, SOLO_TIMEOUT_MS);
  }, [ownDmCallChannelId, activeCalls, ownUserId]);
};

export { useOutgoingCallTimeout };
