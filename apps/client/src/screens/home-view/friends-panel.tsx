import { UserAvatar } from '@/components/user-avatar';
import { Button } from '@/components/ui/button';
import { getOrCreateDmChannel } from '@/features/dms/actions';
import {
  acceptFriendRequest,
  rejectFriendRequest,
  removeFriendAction,
  sendFriendRequest
} from '@/features/friends/actions';
import { useFriendRequests, useFriends } from '@/features/friends/hooks';
import { useOwnUserId, useUsers } from '@/features/server/users/hooks';
import { requestConfirmation } from '@/features/dialogs/actions';
import { cn } from '@/lib/utils';
import type { TJoinedFriendRequest, TJoinedPublicUser } from '@pulse/shared';
import {
  Check,
  Globe,
  MessageSquare,
  Search,
  UserMinus,
  UserPlus,
  X
} from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

type TFriendsPanelProps = {
  onDmSelect: (dmChannelId: number) => void;
};

type TFriendsTab = 'all' | 'pending' | 'add';

const FriendsPanel = memo(({ onDmSelect }: TFriendsPanelProps) => {
  const [tab, setTab] = useState<TFriendsTab>('all');

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-4 border-b border-border px-4">
        <span className="font-semibold text-foreground">Friends</span>
        <div className="flex gap-1">
          {(['all', 'pending', 'add'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'rounded-md px-3 py-1 text-sm transition-colors capitalize',
                tab === t
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
            >
              {t === 'add' ? 'Add Friend' : t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'all' && <AllFriends onDmSelect={onDmSelect} />}
        {tab === 'pending' && <PendingRequests />}
        {tab === 'add' && <AddFriend />}
      </div>
    </div>
  );
});

const AllFriends = memo(
  ({ onDmSelect }: { onDmSelect: (dmChannelId: number) => void }) => {
    const friends = useFriends();

    const handleMessageClick = useCallback(
      async (userId: number) => {
        const channel = await getOrCreateDmChannel(userId);
        if (channel) {
          onDmSelect(channel.id);
        }
      },
      [onDmSelect]
    );

    const handleRemoveClick = useCallback(async (userId: number) => {
      const confirmed = await requestConfirmation({
        title: 'Remove Friend',
        message: 'Are you sure you want to remove this friend?',
        confirmLabel: 'Remove',
        variant: 'danger'
      });

      if (!confirmed) return;

      try {
        await removeFriendAction(userId);
        toast.success('Friend removed');
      } catch {
        toast.error('Failed to remove friend');
      }
    }, []);

    if (friends.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <UserPlus className="h-8 w-8" />
          </div>
          <p className="text-lg font-medium">No friends yet</p>
          <p className="text-sm">Add friends to start chatting!</p>
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <p className="px-2 pb-2 text-xs font-semibold uppercase text-muted-foreground">
          All Friends — {friends.length}
        </p>
        {friends.map((friend) => (
          <FriendRow
            key={friend.id}
            user={friend}
            onMessage={() => handleMessageClick(friend.id)}
            onRemove={() => handleRemoveClick(friend.id)}
          />
        ))}
      </div>
    );
  }
);

const FriendRow = memo(
  ({
    user,
    onMessage,
    onRemove
  }: {
    user: TJoinedPublicUser;
    onMessage: () => void;
    onRemove: () => void;
  }) => (
    <div className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-muted/50 group">
      <div className="flex items-center gap-3">
        <UserAvatar
          userId={user.id}
          className="h-9 w-9"
          showUserPopover
        />
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium">{user.name}</span>
            {user._identity && user._identity.includes('@') && (
              <Globe className="h-3 w-3 text-blue-500 shrink-0" />
            )}
          </div>
          <span className="text-xs capitalize text-muted-foreground">
            {user._identity && user._identity.includes('@')
              ? user._identity.split('@').slice(1).join('@')
              : user.status}
          </span>
        </div>
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onMessage}
          title="Message"
        >
          <MessageSquare className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive hover:text-destructive"
          onClick={onRemove}
          title="Remove Friend"
        >
          <UserMinus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
);

const PendingRequests = memo(() => {
  const requests = useFriendRequests();
  const ownUserId = useOwnUserId();

  const handleAccept = useCallback(async (requestId: number) => {
    try {
      await acceptFriendRequest(requestId);
      toast.success('Friend request accepted');
    } catch {
      toast.error('Failed to accept request');
    }
  }, []);

  const handleReject = useCallback(async (requestId: number) => {
    try {
      await rejectFriendRequest(requestId);
      toast.success('Friend request rejected');
    } catch {
      toast.error('Failed to reject request');
    }
  }, []);

  if (requests.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <Check className="h-8 w-8" />
        </div>
        <p className="text-lg font-medium">No pending requests</p>
        <p className="text-sm">You're all caught up!</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="px-2 pb-2 text-xs font-semibold uppercase text-muted-foreground">
        Pending — {requests.length}
      </p>
      {requests.map((request) => (
        <RequestRow
          key={request.id}
          request={request}
          ownUserId={ownUserId}
          onAccept={() => handleAccept(request.id)}
          onReject={() => handleReject(request.id)}
        />
      ))}
    </div>
  );
});

const RequestRow = memo(
  ({
    request,
    ownUserId,
    onAccept,
    onReject
  }: {
    request: TJoinedFriendRequest;
    ownUserId: number | undefined;
    onAccept: () => void;
    onReject: () => void;
  }) => {
    const isOutgoing = request.senderId === ownUserId;
    const otherUser = isOutgoing ? request.receiver : request.sender;

    return (
      <div className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-muted/50 group">
        <div className="flex items-center gap-3">
          <UserAvatar
            userId={otherUser.id}
            className="h-9 w-9"
            showUserPopover
          />
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium">{otherUser.name}</span>
              {otherUser._identity && otherUser._identity.includes('@') && (
                <Globe className="h-3 w-3 text-blue-500 shrink-0" />
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              {isOutgoing ? 'Outgoing Friend Request' : 'Incoming Friend Request'}
            </span>
          </div>
        </div>
        <div className="flex gap-1">
          {!isOutgoing && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-green-500 hover:text-green-400 hover:bg-green-500/10"
              onClick={onAccept}
              title="Accept"
            >
              <Check className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive"
            onClick={onReject}
            title={isOutgoing ? 'Cancel' : 'Reject'}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }
);

const AddFriend = memo(() => {
  const [searchQuery, setSearchQuery] = useState('');
  const users = useUsers();
  const friends = useFriends();

  const friendIds = useMemo(
    () => new Set(friends.map((f) => f.id)),
    [friends]
  );

  const filteredUsers = useMemo(() => {
    if (!searchQuery.trim()) return [];

    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !friendIds.has(u.id)
    );
  }, [users, searchQuery, friendIds]);

  const handleSendRequest = useCallback(async (userId: number) => {
    try {
      await sendFriendRequest(userId);
      toast.success('Friend request sent');
    } catch {
      toast.error('Failed to send friend request');
    }
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold mb-2">Add Friend</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Search for users on this server to send a friend request.
        </p>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by username..."
            className="w-full rounded-md border border-border bg-background px-10 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {filteredUsers.length > 0 && (
        <div className="space-y-1">
          {filteredUsers.map((user) => (
            <div
              key={user.id}
              className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-muted/50"
            >
              <div className="flex items-center gap-3">
                <UserAvatar
                  userId={user.id}
                  className="h-9 w-9"
                  showUserPopover
                />
                <span className="text-sm font-medium">{user.name}</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => handleSendRequest(user.id)}
                title="Send Friend Request"
              >
                <UserPlus className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {searchQuery.trim() && filteredUsers.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <Search className="mb-2 h-8 w-8 opacity-40" />
          <p className="text-sm">No users found matching "{searchQuery}"</p>
        </div>
      )}
    </div>
  );
});

export { FriendsPanel };
