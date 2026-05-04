import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { useFriends } from '@/features/friends/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getHomeTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Check, X } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

type TAddDmMembersDialogProps = {
  dmChannelId: number;
  // Existing member ids — including self — so the picker can hide
  // them. The dialog doesn't need to know the channel's isGroup
  // flag; the server flips it when a 1:1 is promoted.
  existingMemberIds: number[];
  // Most channels can take up to 10 total members (incl. self), so
  // the picker caps remaining capacity. Caller computes this so the
  // dialog stays purely presentational.
  maxAdd: number;
  onClose: () => void;
  onAdded: () => void;
};

const AddDmMembersDialog = memo(
  ({
    dmChannelId,
    existingMemberIds,
    maxAdd,
    onClose,
    onAdded
  }: TAddDmMembersDialogProps) => {
    const friends = useFriends();
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    const [adding, setAdding] = useState(false);

    const eligibleFriends = useMemo(() => {
      const existing = new Set(existingMemberIds);
      return friends.filter((f) => !existing.has(f.id));
    }, [friends, existingMemberIds]);

    const toggleFriend = useCallback(
      (friendId: number) => {
        setSelectedIds((prev) =>
          prev.includes(friendId)
            ? prev.filter((id) => id !== friendId)
            : prev.length < maxAdd
              ? [...prev, friendId]
              : prev
        );
      },
      [maxAdd]
    );

    const onConfirm = useCallback(async () => {
      if (selectedIds.length === 0 || adding) return;
      setAdding(true);

      const trpc = getHomeTRPCClient();
      if (!trpc) {
        setAdding(false);
        return;
      }

      try {
        await trpc.dms.addMember.mutate({
          dmChannelId,
          userIds: selectedIds
        });
        toast.success(
          selectedIds.length === 1 ? 'Member added' : 'Members added'
        );
        onAdded();
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to add members'));
      } finally {
        setAdding(false);
      }
    }, [selectedIds, adding, dmChannelId, onAdded]);

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-popover border border-border rounded-lg shadow-xl w-full max-w-sm mx-4">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
            <h2 className="text-sm font-semibold">Add to DM</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4 space-y-3">
            <div className="text-xs text-muted-foreground">
              Select friends ({selectedIds.length}/{maxAdd})
            </div>

            <div className="max-h-48 overflow-y-auto space-y-0.5">
              {eligibleFriends.map((friend) => (
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

              {eligibleFriends.length === 0 && (
                <div className="py-4 text-center text-sm text-muted-foreground">
                  {friends.length === 0
                    ? 'No friends to add'
                    : 'All your friends are already in this DM'}
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
              onClick={onConfirm}
              disabled={selectedIds.length === 0 || adding || maxAdd === 0}
            >
              Add
            </Button>
          </div>
        </div>
      </div>
    );
  }
);

AddDmMembersDialog.displayName = 'AddDmMembersDialog';

export { AddDmMembersDialog };
