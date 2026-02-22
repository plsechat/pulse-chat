import { Button } from '@/components/ui/button';
import { requestConfirmation } from '@/features/dialogs/actions';
import { getTRPCClient } from '@/lib/trpc';
import { Trash, X } from 'lucide-react';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';
import { useSelection } from './selection-context';

const SelectionActionBar = memo(() => {
  const { selectedIds, exitSelectionMode, clearSelection } = useSelection();
  const count = selectedIds.size;

  const onDeleteSelected = useCallback(async () => {
    const choice = await requestConfirmation({
      title: `Delete ${count} Messages`,
      message: `Are you sure you want to delete ${count} selected message(s)? This cannot be undone.`,
      confirmLabel: `Delete ${count}`,
      cancelLabel: 'Cancel'
    });

    if (!choice) return;

    const trpc = getTRPCClient();
    const ids = Array.from(selectedIds);

    try {
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        await trpc.messages.bulkDelete.mutate({ messageIds: batch });
      }
      toast.success(`Deleted ${count} messages`);
      exitSelectionMode();
    } catch {
      toast.error('Failed to delete messages');
    }
  }, [selectedIds, count, exitSelectionMode]);

  if (count === 0) return null;

  return (
    <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-background border border-border rounded-full px-4 py-2 shadow-lg">
      <span className="text-sm font-medium">{count} selected</span>
      <Button
        variant="destructive"
        size="sm"
        onClick={onDeleteSelected}
        className="gap-1"
      >
        <Trash className="h-3.5 w-3.5" />
        Delete
      </Button>
      <Button variant="ghost" size="sm" onClick={clearSelection}>
        Clear
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={exitSelectionMode}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
});

export { SelectionActionBar };
