import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu';
import { UserStatusBadge } from '@/components/user-status';
import { deleteDmChannel, enableDmEncryption } from '@/features/dms/actions';
import { useDmChannels } from '@/features/dms/hooks';
import { requestConfirmation } from '@/features/dialogs/actions';
import { useFriendRequests } from '@/features/friends/hooks';
import { useOwnUserId, useUserStatus } from '@/features/server/users/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import { getInitialsFromName } from '@/helpers/get-initials-from-name';
import { cn } from '@/lib/utils';
import type { TJoinedDmChannel, TJoinedPublicUser } from '@pulse/shared';
import { AvatarImage } from '@radix-ui/react-avatar';
import { Lock, MessageSquare, Plus, Trash2, Users } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import type { THomeTab } from '.';

type THomeSidebarProps = {
  activeTab: THomeTab;
  selectedDmChannelId: number | undefined;
  onDmSelect: (dmChannelId: number) => void;
  onFriendsClick: () => void;
  onCreateGroupDm?: () => void;
};

const HomeSidebar = memo(
  ({
    activeTab,
    selectedDmChannelId,
    onDmSelect,
    onFriendsClick,
    onCreateGroupDm
  }: THomeSidebarProps) => {
    const friendRequests = useFriendRequests();
    const dmChannels = useDmChannels();
    const pendingCount = friendRequests.length;

    return (
      <>
        <div className="flex w-full h-12 items-center border-b border-border px-4">
          <h2 className="font-semibold text-foreground">Home</h2>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="p-2">
            <button
              onClick={onFriendsClick}
              className={cn(
                'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                activeTab === 'friends'
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
            >
              <Users className="h-5 w-5" />
              <span>Friends</span>
              {pendingCount > 0 && (
                <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-bold text-destructive-foreground">
                  {pendingCount}
                </span>
              )}
            </button>
          </div>

          <div className="px-4 py-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                Direct Messages
              </span>
              {onCreateGroupDm && (
                <button
                  type="button"
                  onClick={onCreateGroupDm}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  title="Create Group DM"
                >
                  <Plus className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          <div className="px-2 space-y-0.5">
            {dmChannels.map((channel) => (
              <DmChannelItem
                key={channel.id}
                channel={channel}
                isSelected={selectedDmChannelId === channel.id}
                onSelect={() => onDmSelect(channel.id)}
              />
            ))}

            {dmChannels.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                  <MessageSquare className="h-6 w-6" />
                </div>
                <p className="font-medium">No conversations yet</p>
                <p className="text-xs mt-1">Start a DM to begin chatting</p>
              </div>
            )}
          </div>
        </div>
      </>
    );
  }
);

type TDmChannelItemProps = {
  channel: TJoinedDmChannel;
  isSelected: boolean;
  onSelect: () => void;
};

const DmChannelItem = memo(
  ({ channel, isSelected, onSelect }: TDmChannelItemProps) => {
    const ownUserId = useOwnUserId();

    const otherMembers = useMemo(
      () => channel.members.filter((m) => m.id !== ownUserId),
      [channel.members, ownUserId]
    );

    const displayName = useMemo(() => {
      if (channel.isGroup && channel.name) return channel.name;
      if (channel.isGroup) {
        return otherMembers.map((m) => m.name).join(', ') || 'Group DM';
      }

      return otherMembers[0]?.name ?? 'Unknown';
    }, [channel.isGroup, channel.name, otherMembers]);

    const handleDelete = useCallback(async () => {
      const confirmed = await requestConfirmation({
        title: 'Delete Conversation',
        message:
          'This will permanently delete all messages for both sides. This cannot be undone.',
        confirmLabel: 'Delete',
        variant: 'danger'
      });
      if (!confirmed) return;
      try {
        await deleteDmChannel(channel.id);
        toast.success('Conversation deleted');
      } catch {
        toast.error('Failed to delete conversation');
      }
    }, [channel.id]);

    const handleEnableEncryption = useCallback(async () => {
      const confirmed = await requestConfirmation({
        title: 'Enable Encryption',
        message:
          'This will enable end-to-end encryption for this conversation. This cannot be reversed.',
        confirmLabel: 'Enable',
        variant: 'info'
      });
      if (!confirmed) return;
      try {
        await enableDmEncryption(channel.id);
        toast.success('Encryption enabled');
      } catch {
        toast.error('Failed to enable encryption');
      }
    }, [channel.id]);

    if (otherMembers.length === 0) return null;

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            onClick={onSelect}
            className={cn(
              'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              isSelected
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
          >
            {channel.isGroup ? (
              <div className="relative h-8 w-8 flex-shrink-0">
                {otherMembers.slice(0, 2).map((m, i) => (
                  <DmMemberAvatar
                    key={m.id}
                    member={m}
                    className={cn(
                      'h-6 w-6 absolute border-2 border-background',
                      i === 0 ? 'top-0 left-0' : 'bottom-0 right-0'
                    )}
                  />
                ))}
              </div>
            ) : (
              <DmMemberAvatarWithStatus
                member={otherMembers[0]}
                className="h-8 w-8 flex-shrink-0"
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col items-start">
              <span className="truncate font-medium">{displayName}</span>
              {channel.isGroup && (
                <span className="text-[10px] text-muted-foreground">
                  {channel.members.length} members
                </span>
              )}
              {!channel.isGroup && channel.lastMessage?.content && (
                <span className="truncate text-xs text-muted-foreground w-full text-left">
                  {channel.lastMessage.content.replace(/<[^>]*>/g, '').slice(0, 40)}
                </span>
              )}
            </div>
            {channel.unreadCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-bold text-destructive-foreground">
                {channel.unreadCount}
              </span>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {!channel.e2ee && (
            <>
              <ContextMenuItem onClick={handleEnableEncryption}>
                <Lock className="mr-2 h-4 w-4" />
                Enable Encryption
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem
            onClick={handleDelete}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete Conversation
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }
);

/** Avatar with status badge for 1-on-1 DM items in the sidebar. */
const DmMemberAvatarWithStatus = memo(
  ({ member, className }: { member: TJoinedPublicUser; className?: string }) => {
    const status = useUserStatus(member.id);
    return (
      <div className="relative w-fit h-fit flex-shrink-0">
        <Avatar className={cn('h-8 w-8', className)}>
          <AvatarImage src={getFileUrl(member.avatar)} />
          <AvatarFallback className="bg-muted text-xs">
            {getInitialsFromName(member.name)}
          </AvatarFallback>
        </Avatar>
        <UserStatusBadge
          status={status}
          className="absolute bottom-0 right-0"
        />
      </div>
    );
  }
);

/** Avatar rendered directly from DM channel member data — no Redux lookup needed. */
const DmMemberAvatar = memo(
  ({ member, className }: { member: TJoinedPublicUser; className?: string }) => (
    <Avatar className={cn('h-8 w-8', className)}>
      <AvatarImage src={getFileUrl(member.avatar)} />
      <AvatarFallback className="bg-muted text-xs">
        {getInitialsFromName(member.name)}
      </AvatarFallback>
    </Avatar>
  )
);

export { HomeSidebar };
