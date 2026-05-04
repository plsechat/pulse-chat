import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { setActiveView } from '@/features/app/actions';
import { dismissRingingCall, joinDmVoiceCall } from '@/features/dms/actions';
import { useDmChannels, useRingingCalls } from '@/features/dms/hooks';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { useOwnUserId } from '@/features/server/users/hooks';
import { LocalStorageKey, setLocalStorageItem } from '@/helpers/storage';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useVoice } from '@/features/server/voice/hooks';
import { getHomeTRPCClient } from '@/lib/trpc';
import { Phone, PhoneOff } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useOutgoingCallTimeout } from './use-outgoing-call-timeout';

const RING_INTERVAL_MS = 2500;

/**
 * Global pop-up that shows whenever an incoming-call ring is queued
 * up in `state.dms.ringingCalls`. Mounted at the App root so it
 * follows the user across views — they get rung whether they're in
 * a server, on Friends, in a DM, etc.
 *
 * UX:
 * - Plays the INCOMING_CALL chime on mount and every RING_INTERVAL_MS
 *   while open. Stops on accept/dismiss/auto-end.
 * - Accept: navigates to the DM (in case the user wasn't in it),
 *   joins the voice call, primes Mediasoup. Mirrors the Join button
 *   in DmCallBanner so the two paths land in the same state.
 * - Decline: clears the ring locally. There's no server-side
 *   "decline" event — the call stays alive for the other peers and
 *   the originator just won't see this user join.
 * - Auto-dismiss: when the call ends (DM_CALL_ENDED), the action
 *   reducer drops the entry from ringingCalls and the modal hides.
 */
const IncomingCallModal = memo(() => {
  // Caller-side: auto-end an outgoing call with a "No answer" toast
  // if no one joins within the timeout. Lives next to the modal
  // because both belong to the call-lifecycle UX and need to be
  // mounted inside VoiceProvider so leaveDmVoiceCall reaches the
  // real Mediasoup transports.
  useOutgoingCallTimeout();

  const ringingCalls = useRingingCalls();
  // Show only the most recent ringing call (rare: someone might
  // start two calls before answering one). Stack behavior could
  // come later; keep the modal singular for now.
  const dmChannelId = ringingCalls[ringingCalls.length - 1];

  if (dmChannelId === undefined) return null;
  return <IncomingCallContent key={dmChannelId} dmChannelId={dmChannelId} />;
});

IncomingCallModal.displayName = 'IncomingCallModal';

const IncomingCallContent = memo(
  ({ dmChannelId }: { dmChannelId: number }) => {
    const channels = useDmChannels();
    const ownUserId = useOwnUserId();
    const { init } = useVoice();
    const [accepting, setAccepting] = useState(false);

    const channel = useMemo(
      () => channels.find((c) => c.id === dmChannelId),
      [channels, dmChannelId]
    );

    const otherMembers = useMemo(
      () => channel?.members.filter((m) => m.id !== ownUserId) ?? [],
      [channel, ownUserId]
    );

    // Group DM: list the names; 1:1: just the other user. The first
    // few members (avatars) plus a "+N" overflow chip if it's a big
    // group keeps the modal small.
    const callerSummary = useMemo(() => {
      if (!channel) return 'Incoming call';
      if (channel.isGroup) {
        const labelMembers = otherMembers.slice(0, 3);
        const names = labelMembers.map((m) => m.name).join(', ');
        const extra = otherMembers.length - labelMembers.length;
        return channel.name
          ? channel.name
          : extra > 0
            ? `${names} +${extra}`
            : names || 'Group call';
      }
      return otherMembers[0]?.name ?? 'Incoming call';
    }, [channel, otherMembers]);

    // Ring loop. Plays once immediately and again every interval
    // until the modal unmounts (decline / accept / auto-dismiss).
    useEffect(() => {
      playSound(SoundType.INCOMING_CALL);
      const id = window.setInterval(() => {
        playSound(SoundType.INCOMING_CALL);
      }, RING_INTERVAL_MS);
      return () => window.clearInterval(id);
    }, []);

    const handleAccept = useCallback(async () => {
      if (accepting) return;
      setAccepting(true);
      try {
        // Land on the DM view first so the user sees the conversation
        // they just accepted into. HomeView reads ACTIVE_DM_CHANNEL_ID
        // from local storage on mount; we set it before flipping the
        // active view so the route lands in the right DM.
        setLocalStorageItem(LocalStorageKey.HOME_TAB, 'dm');
        setLocalStorageItem(
          LocalStorageKey.ACTIVE_DM_CHANNEL_ID,
          String(dmChannelId)
        );
        // Tell HomeView (already mounted) to switch — the local state
        // there is the source of truth for which DM is rendered, so
        // localStorage alone wouldn't trigger a re-render.
        window.dispatchEvent(
          new CustomEvent('dm-navigate', { detail: { dmChannelId } })
        );
        setActiveView('home');

        const result = await joinDmVoiceCall(dmChannelId);
        if (result) {
          await init(result.routerRtpCapabilities, dmChannelId);
        }
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to accept call'));
        // Fall through — clear the ring either way so the modal closes.
      } finally {
        setAccepting(false);
        dismissRingingCall(dmChannelId);
      }
    }, [accepting, dmChannelId, init]);

    const handleDecline = useCallback(() => {
      // Always dismiss locally first — even if the server-side
      // notify fails, the user has clicked decline and the modal
      // should close with the ring stopping. Best-effort publish
      // notifies the caller (and other ringers in a group).
      dismissRingingCall(dmChannelId);
      const trpc = getHomeTRPCClient();
      trpc?.dms.declineCall.mutate({ dmChannelId }).catch(() => {});
    }, [dmChannelId]);

    return (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={handleDecline}
      >
        <div
          className="bg-popover border border-border rounded-xl shadow-2xl w-full max-w-sm mx-4 p-6 flex flex-col items-center gap-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Incoming call
          </div>

          {channel?.isGroup ? (
            <div className="flex -space-x-3">
              {otherMembers.slice(0, 3).map((m) => (
                <UserAvatar
                  key={m.id}
                  userId={m.id}
                  className="h-16 w-16 ring-4 ring-popover"
                  showStatusBadge={false}
                  showUserPopover={false}
                />
              ))}
            </div>
          ) : (
            otherMembers[0] && (
              <UserAvatar
                userId={otherMembers[0].id}
                className="h-20 w-20"
                showStatusBadge={false}
                showUserPopover={false}
              />
            )
          )}

          <div className="text-center">
            <div className="text-lg font-semibold text-foreground">
              {callerSummary}
            </div>
            <div className="text-xs text-muted-foreground">
              {channel?.isGroup ? 'Group voice call' : 'Voice call'}
            </div>
          </div>

          <div className="flex w-full gap-3">
            <Button
              variant="outline"
              className="flex-1 gap-2 text-destructive hover:text-destructive"
              onClick={handleDecline}
            >
              <PhoneOff className="h-4 w-4" />
              Decline
            </Button>
            <Button
              className="flex-1 gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={handleAccept}
              disabled={accepting}
            >
              <Phone className="h-4 w-4" />
              {accepting ? 'Joining…' : 'Accept'}
            </Button>
          </div>
        </div>
      </div>
    );
  }
);

IncomingCallContent.displayName = 'IncomingCallContent';

export { IncomingCallModal };
