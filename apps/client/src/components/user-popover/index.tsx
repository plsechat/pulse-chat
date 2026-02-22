import { setActiveView, setModViewOpen } from '@/features/app/actions';
import { useActiveInstanceDomain } from '@/features/app/hooks';
import { requestTextInput } from '@/features/dialogs/actions';
import { getOrCreateDmChannel } from '@/features/dms/actions';
import { useFriends } from '@/features/friends/hooks';
import {
  removeFriendAction,
  sendFriendRequest
} from '@/features/friends/actions';
import { useUserRoles } from '@/features/server/hooks';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import { getHomeTRPCClient, getTRPCClient } from '@/lib/trpc';
import { Permission, UserStatus } from '@pulse/shared';
import { format, formatDistanceToNow } from 'date-fns';
import {
  Copy,
  Globe,
  MessageSquare,
  Pencil,
  Plus,
  ShieldCheck,
  StickyNote,
  UserCog,
  UserMinus,
  UserPlus,
  X
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Protect } from '../protect';
import { RoleBadge } from '../role-badge';
import { IconButton } from '../ui/icon-button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { UserAvatar } from '../user-avatar';
import { UserStatusBadge } from '../user-status';

type TNote = {
  id: number;
  content: string;
  createdAt: number;
};

type TUserPopoverProps = {
  userId: number;
  children: React.ReactNode;
};

const UserPopover = memo(({ userId, children }: TUserPopoverProps) => {
  const user = useUserById(userId);
  const roles = useUserRoles(userId);
  const ownUserId = useOwnUserId();
  const friends = useFriends();
  const activeInstanceDomain = useActiveInstanceDomain();
  const isOwnUser = !activeInstanceDomain && userId === ownUserId;

  const [notes, setNotes] = useState<TNote[]>([]);
  const [notesLoaded, setNotesLoaded] = useState(false);

  const isFriend = useMemo(
    () => friends.some((f) => f.id === userId),
    [friends, userId]
  );

  const fetchNotes = useCallback(async () => {
    try {
      const trpc = getTRPCClient();
      const result = await trpc.notes.getAll.query({ targetUserId: userId });
      setNotes(result.notes);
      setNotesLoaded(true);
    } catch {
      // silently fail
    }
  }, [userId]);

  // Refetch notes when they change in another tab
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.targetUserId === userId && notesLoaded) {
        fetchNotes();
      }
    };
    window.addEventListener('notes-changed', handler);
    return () => window.removeEventListener('notes-changed', handler);
  }, [userId, notesLoaded, fetchNotes]);

  const handlePopoverOpen = useCallback(
    (open: boolean) => {
      if (open) {
        setNotesLoaded(false);
        fetchNotes();
      }
    },
    [fetchNotes]
  );

  const handleAddNote = useCallback(async () => {
    const text = await requestTextInput({
      title: 'Add Note',
      message: `Note about ${user?.name ?? 'this user'}`,
      confirmLabel: 'Save',
      cancelLabel: 'Cancel'
    });

    if (text) {
      try {
        const trpc = getTRPCClient();
        await trpc.notes.add.mutate({ targetUserId: userId, content: text });
        toast.success('Note saved');
        fetchNotes();
      } catch {
        toast.error('Failed to save note');
      }
    }
  }, [userId, user, fetchNotes]);

  const handleDeleteNote = useCallback(
    async (noteId: number) => {
      try {
        const trpc = getTRPCClient();
        await trpc.notes.delete.mutate({ noteId });
        setNotes((prev) => prev.filter((n) => n.id !== noteId));
        toast.success('Note deleted');
      } catch {
        toast.error('Failed to delete note');
      }
    },
    []
  );

  const resolveLocalUserId = useCallback(async (): Promise<number> => {
    if (!activeInstanceDomain || !user) return userId;

    if (!user.publicId) {
      console.error('Cannot resolve federated user without publicId');
      return userId;
    }

    const trpc = getHomeTRPCClient();
    const result = await trpc.federation.ensureShadowUser.mutate({
      instanceDomain: activeInstanceDomain,
      remoteUserId: userId,
      username: user.name,
      remotePublicId: user.publicId
    });
    return result.localUserId;
  }, [activeInstanceDomain, userId, user]);

  const handleSendMessage = useCallback(async () => {
    try {
      const localId = await resolveLocalUserId();
      const channel = await getOrCreateDmChannel(localId);
      if (channel) {
        setActiveView('home');
      }
    } catch {
      toast.error('Failed to open DM channel');
    }
  }, [resolveLocalUserId]);

  const handleAddFriend = useCallback(async () => {
    try {
      const localId = await resolveLocalUserId();
      await sendFriendRequest(localId);
      toast.success('Friend request sent');
    } catch {
      toast.error('Failed to send friend request');
    }
  }, [resolveLocalUserId]);

  const handleRemoveFriend = useCallback(async () => {
    try {
      const localId = await resolveLocalUserId();
      await removeFriendAction(localId);
      toast.success('Friend removed');
    } catch {
      toast.error('Failed to remove friend');
    }
  }, [resolveLocalUserId]);

  const handleEditNickname = useCallback(async () => {
    const text = await requestTextInput({
      title: 'Set Nickname',
      message: 'Nickname for this server (leave empty to clear)',
      confirmLabel: 'Save',
      cancelLabel: 'Cancel',
      defaultValue: user?.nickname ?? '',
      allowEmpty: true
    });

    if (text !== null && text !== undefined) {
      try {
        const trpc = getTRPCClient();
        const nickname = text.trim() || null;
        if (isOwnUser) {
          await trpc.users.setNickname.mutate({ nickname });
        } else {
          await trpc.users.setUserNickname.mutate({ userId, nickname });
        }
        toast.success(nickname ? 'Nickname updated' : 'Nickname cleared');
      } catch {
        toast.error('Failed to update nickname');
      }
    }
  }, [userId, user, isOwnUser]);

  if (!user) return <>{children}</>;

  return (
    <Popover onOpenChange={handlePopoverOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start" side="right">
        <div className="relative">
          {user.banned && (
            <div className="absolute right-2 top-2 bg-red-500 text-white text-xs px-2 py-1 rounded-md flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" />
              Banned
            </div>
          )}
          {user.banner ? (
            <div
              className="h-24 w-full rounded-t-md bg-cover bg-center bg-no-repeat"
              style={{
                backgroundImage: `url(${getFileUrl(user.banner)})`
              }}
            />
          ) : (
            <div
              className="h-24 w-full rounded-t-md"
              style={{
                background: user.bannerColor || '#5865f2'
              }}
            />
          )}
          <div className="absolute left-4 top-16">
            <UserAvatar
              userId={user.id}
              className="h-16 w-16 border-4 border-card"
              showStatusBadge={false}
            />
          </div>
        </div>

        <div className="px-4 pt-12 pb-4">
          <div className="mb-3">
            <div className="flex items-center gap-1.5">
              <span className="text-lg font-semibold text-foreground truncate">
                {user.nickname || user.name}
              </span>
              {isOwnUser ? (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  onClick={handleEditNickname}
                  title="Edit nickname"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              ) : (
                <Protect permission={Permission.MANAGE_USERS}>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                    onClick={handleEditNickname}
                    title="Edit nickname"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </Protect>
              )}
            </div>
            {user.nickname && (
              <span className="text-xs text-muted-foreground">
                {user.name}
              </span>
            )}
            {user._identity && user._identity.includes('@') && (
              <div className="flex items-center gap-1 mt-0.5">
                <Globe className="h-3 w-3 text-blue-500" />
                <span className="text-xs text-blue-500">
                  Federated from {user._identity.split('@').slice(1).join('@')}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2">
                <UserStatusBadge
                  status={user.status || UserStatus.OFFLINE}
                  className="h-3 w-3"
                />
                <span className="text-xs text-muted-foreground capitalize">
                  {user.status || UserStatus.OFFLINE}
                </span>
              </div>
            </div>
          </div>

          {roles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {roles.map((role) => (
                <RoleBadge key={role.id} role={role} />
              ))}
            </div>
          )}

          {user.bio && (
            <div className="mt-3">
              <p className="text-sm text-foreground leading-relaxed">
                {user.bio}
              </p>
            </div>
          )}

          {notesLoaded && (
            <div className="mt-3 pt-3 border-t border-border">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase">
                  <StickyNote className="h-3 w-3" />
                  Notes
                </div>
                <button
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={handleAddNote}
                >
                  <Plus className="h-3 w-3" />
                  Add
                </button>
              </div>
              {notes.length > 0 ? (
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {notes.map((note) => (
                    <div
                      key={note.id}
                      className="group flex items-start gap-2 text-sm"
                    >
                      <p className="flex-1 text-foreground text-xs leading-relaxed break-words">
                        {note.content}
                      </p>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-[10px] text-muted-foreground">
                          {formatDistanceToNow(new Date(note.createdAt), {
                            addSuffix: true
                          })}
                        </span>
                        <button
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                          onClick={() => handleDeleteNote(note.id)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  No notes yet
                </p>
              )}
            </div>
          )}

          {!isOwnUser && (
            <div className="flex items-center gap-1 mt-3 pt-3 border-t border-border">
              <IconButton
                icon={MessageSquare}
                variant="secondary"
                size="sm"
                title="Send Message"
                onClick={handleSendMessage}
              />
              {isFriend ? (
                <IconButton
                  icon={UserMinus}
                  variant="secondary"
                  size="sm"
                  title="Remove Friend"
                  onClick={handleRemoveFriend}
                />
              ) : (
                <IconButton
                  icon={UserPlus}
                  variant="secondary"
                  size="sm"
                  title="Add Friend"
                  onClick={handleAddFriend}
                />
              )}
              {user.publicId && (
                <IconButton
                  icon={Copy}
                  variant="secondary"
                  size="sm"
                  title="Copy User ID"
                  onClick={() => {
                    navigator.clipboard.writeText(user.publicId!);
                    toast.success('User ID copied');
                  }}
                />
              )}
            </div>
          )}

          <div className="flex justify-between items-center mt-4 pt-3 border-t border-border">
            <p className="text-xs text-muted-foreground">
              Member since {format(new Date(user.createdAt), 'PP')}
            </p>

            <Protect permission={Permission.MANAGE_USERS}>
              <IconButton
                icon={UserCog}
                variant="ghost"
                size="sm"
                title="Moderation View"
                onClick={() => setModViewOpen(true, user.id)}
              />
            </Protect>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
});

UserPopover.displayName = 'UserPopover';

export { UserPopover };
