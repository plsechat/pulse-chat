import { Button } from '@/components/ui/button';
import { leaveDmChannel } from '@/features/dms/actions';
import { useDmChannels } from '@/features/dms/hooks';
import {
  blockUser,
  sendFriendRequest
} from '@/features/friends/actions';
import { useFriends, useIsUserBlocked } from '@/features/friends/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { UserPlus, X } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

// Per-channel acceptance flag — raw localStorage because the typed
// LocalStorageKey enum doesn't model dynamic per-id keys, and adding
// one for each accepted DM would bloat the enum.
const ACCEPTED_KEY_PREFIX = 'dm-accepted-from:';

/**
 * Banner shown above a 1:1 DM conversation when the *other* user
 * is not in the current user's friends list. Lets the recipient
 * choose to accept (send friend request) or decline (leave +
 * block) before continuing the conversation.
 *
 * Group DMs are not gated — joining a group requires being added
 * by an existing member, which is a stronger signal than a
 * cold-call DM.
 *
 * Acceptance is sticky per-channel via localStorage so the banner
 * doesn't reappear after every reload — server-side state for
 * "this DM has been accepted" would need a schema change, kept
 * out of scope for this iteration.
 */
const DmNonFriendBanner = memo(({ dmChannelId }: { dmChannelId: number }) => {
  const dmChannels = useDmChannels();
  const ownUserId = useOwnUserId();
  const friends = useFriends();

  const channel = useMemo(
    () => dmChannels.find((c) => c.id === dmChannelId),
    [dmChannels, dmChannelId]
  );
  const otherUser = useMemo(() => {
    if (!channel || channel.isGroup) return null;
    return channel.members.find((m) => m.id !== ownUserId) ?? null;
  }, [channel, ownUserId]);

  const isFriend = useMemo(
    () => (otherUser ? friends.some((f) => f.id === otherUser.id) : false),
    [friends, otherUser]
  );
  const isBlocked = useIsUserBlocked(otherUser?.id);
  const acceptedKey = `${ACCEPTED_KEY_PREFIX}${dmChannelId}`;
  const [accepted, setAccepted] = useState<boolean>(() => {
    try {
      return localStorage.getItem(acceptedKey) === 'true';
    } catch {
      return false;
    }
  });

  const [busy, setBusy] = useState(false);

  const handleAccept = useCallback(async () => {
    if (!otherUser || busy) return;
    setBusy(true);
    try {
      await sendFriendRequest(otherUser.id);
      toast.success(`Friend request sent to ${otherUser.name}`);
    } catch (err) {
      // Surface the error but still mark as accepted — the user
      // chose to engage; a stale "already friends" or rate-limit
      // shouldn't reblock the conversation.
      toast.error(getTrpcError(err, 'Failed to send friend request'));
    }
    try {
      localStorage.setItem(acceptedKey, 'true');
    } catch {
      // ignore — banner just reappears on next reload, harmless
    }
    setAccepted(true);
    setBusy(false);
  }, [otherUser, busy, acceptedKey]);

  const handleDecline = useCallback(async () => {
    if (!otherUser || busy) return;
    setBusy(true);
    try {
      await blockUser(otherUser.id);
      await leaveDmChannel(dmChannelId);
      toast.success('Conversation declined');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to decline conversation'));
    } finally {
      setBusy(false);
    }
  }, [otherUser, busy, dmChannelId]);

  // Hide if: group DM, no other user resolved, already friends,
  // user has blocked them (the leave path handles this), or the
  // user has already accepted on this device.
  if (!channel || channel.isGroup) return null;
  if (!otherUser || isFriend || isBlocked || accepted) return null;

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-center gap-3">
      <UserPlus className="h-4 w-4 text-amber-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">
          {otherUser.name} is not in your friends list
        </p>
        <p className="text-xs text-muted-foreground">
          Accept to send a friend request, or decline to block them
          and leave the conversation.
        </p>
      </div>
      <div className="flex gap-2 shrink-0">
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={handleDecline}
          disabled={busy}
        >
          <X className="h-3.5 w-3.5 mr-1" />
          Decline
        </Button>
        <Button size="sm" onClick={handleAccept} disabled={busy}>
          <UserPlus className="h-3.5 w-3.5 mr-1" />
          Accept
        </Button>
      </div>
    </div>
  );
});

DmNonFriendBanner.displayName = 'DmNonFriendBanner';

export { DmNonFriendBanner };
