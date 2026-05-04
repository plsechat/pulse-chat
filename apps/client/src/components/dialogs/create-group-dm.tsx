import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { useFriends } from '@/features/friends/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getHomeTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Check, X } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';

type TCreateGroupDmDialogProps = {
  onClose: () => void;
  onCreated: (dmChannelId: number) => void;
};

const CreateGroupDmDialog = memo(
  ({ onClose, onCreated }: TCreateGroupDmDialogProps) => {
    const friends = useFriends();
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    const [groupName, setGroupName] = useState('');
    const [creating, setCreating] = useState(false);

    const toggleFriend = useCallback((friendId: number) => {
      setSelectedIds((prev) =>
        prev.includes(friendId)
          ? prev.filter((id) => id !== friendId)
          : prev.length < 9
            ? [...prev, friendId]
            : prev
      );
    }, []);

    const onCreate = useCallback(async () => {
      if (selectedIds.length === 0 || creating) return;

      setCreating(true);

      const trpc = getHomeTRPCClient();
      if (!trpc) {
        setCreating(false);
        return;
      }

      try {
        const channel = await trpc.dms.createGroup.mutate({
          userIds: selectedIds,
          name: groupName.trim() || undefined
        });

        onCreated(channel.id);
        toast.success('Group DM created');
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to create group DM'));
      } finally {
        setCreating(false);
      }
    }, [selectedIds, groupName, creating, onCreated]);

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-popover border border-border rounded-lg shadow-xl w-full max-w-sm mx-4">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
            <h2 className="text-sm font-semibold">Create Group DM</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4 space-y-3">
            <input
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Group name (optional)"
              className="w-full px-3 py-2 text-sm bg-muted/30 border border-border/50 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30"
              maxLength={100}
            />

            <div className="text-xs text-muted-foreground">
              Select friends ({selectedIds.length}/9)
            </div>

            <div className="max-h-48 overflow-y-auto space-y-0.5">
              {friends.map((friend) => (
                <button
                  key={friend.id}
                  type="button"
                  onClick={() => toggleFriend(friend.id)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors',
                    selectedIds.includes(friend.id)
                      ? 'bg-primary/10'
                      : 'hover:bg-muted/50'
                  )}
                >
                  <UserAvatar
                    userId={friend.id}
                    className="h-7 w-7"
                    showUserPopover={false}
                  />
                  <span className="flex-1 text-left truncate">
                    {friend.name}
                  </span>
                  {selectedIds.includes(friend.id) && (
                    <Check className="w-4 h-4 text-primary" />
                  )}
                </button>
              ))}

              {friends.length === 0 && (
                <div className="py-4 text-center text-sm text-muted-foreground">
                  No friends to add
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 px-4 py-3 border-t border-border/50">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={onCreate}
              disabled={selectedIds.length === 0 || creating}
            >
              Create
            </Button>
          </div>
        </div>
      </div>
    );
  }
);

export { CreateGroupDmDialog };
