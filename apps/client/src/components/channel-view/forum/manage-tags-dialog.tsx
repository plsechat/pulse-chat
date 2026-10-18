import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type TTag = {
  id: number;
  name: string;
  color: string;
};

type TManageTagsDialogProps = {
  channelId: number;
  onClose: () => void;
};

const TAG_COLORS = [
  '#808080',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899'
];

/**
 * The colour swatches, on a line of their own that wraps. Sharing a
 * line with the name input and the buttons needed ~476 px in a 400 px
 * dialog, and the body's overflow-y-auto clipped Save off the end.
 */
const ColorSwatches = memo(
  ({
    value,
    onChange,
    compact
  }: {
    value: string;
    onChange: (color: string) => void;
    compact?: boolean;
  }) => (
    <div className="flex flex-wrap gap-1">
      {TAG_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          aria-label={`Tag color ${color}`}
          aria-pressed={value === color}
          className={
            compact
              ? 'h-4 w-4 shrink-0 rounded-full border-2 transition-transform'
              : 'h-5 w-5 shrink-0 rounded-full border-2 transition-transform'
          }
          style={{
            backgroundColor: color,
            borderColor: value === color ? 'white' : 'transparent',
            transform: value === color ? 'scale(1.2)' : 'scale(1)'
          }}
        />
      ))}
    </div>
  )
);

const ManageTagsDialog = memo(
  ({ channelId, onClose }: TManageTagsDialogProps) => {
    const [tags, setTags] = useState<TTag[]>([]);
    const [newTagName, setNewTagName] = useState('');
    const [newTagColor, setNewTagColor] = useState('#808080');
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editName, setEditName] = useState('');
    const [editColor, setEditColor] = useState('');
    const [loading, setLoading] = useState(false);

    const fetchTags = useCallback(async () => {
      const trpc = getTRPCClient();
      if (!trpc) return;

      try {
        const result = await trpc.threads.getForumTags.query({ channelId });
        setTags(result);
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to load tags'));
      }
    }, [channelId]);

    useEffect(() => {
      fetchTags();
    }, [fetchTags]);

    const onCreateTag = useCallback(async () => {
      if (!newTagName.trim() || loading) return;

      setLoading(true);

      const trpc = getTRPCClient();
      if (!trpc) {
        setLoading(false);
        return;
      }

      try {
        await trpc.threads.createForumTag.mutate({
          channelId,
          name: newTagName.trim(),
          color: newTagColor
        });
        setNewTagName('');
        setNewTagColor('#808080');
        fetchTags();
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to create tag'));
      } finally {
        setLoading(false);
      }
    }, [newTagName, newTagColor, channelId, loading, fetchTags]);

    const onUpdateTag = useCallback(
      async (tagId: number) => {
        if (!editName.trim() || loading) return;

        setLoading(true);

        const trpc = getTRPCClient();
        if (!trpc) {
          setLoading(false);
          return;
        }

        try {
          await trpc.threads.updateForumTag.mutate({
            tagId,
            name: editName.trim(),
            color: editColor
          });
          setEditingId(null);
          fetchTags();
        } catch (err) {
          toast.error(getTrpcError(err, 'Failed to update tag'));
        } finally {
          setLoading(false);
        }
      },
      [editName, editColor, loading, fetchTags]
    );

    const onDeleteTag = useCallback(
      async (tagId: number) => {
        const trpc = getTRPCClient();
        if (!trpc) return;

        try {
          await trpc.threads.deleteForumTag.mutate({ tagId });
          fetchTags();
        } catch (err) {
          toast.error(getTrpcError(err, 'Failed to delete tag'));
        }
      },
      [fetchTags]
    );

    const startEditing = useCallback((tag: TTag) => {
      setEditingId(tag.id);
      setEditName(tag.name);
      setEditColor(tag.color);
    }, []);

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-popover border border-border rounded-lg shadow-xl w-full max-w-md mx-4">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
            <h2 className="text-sm font-semibold">Manage Tags</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4 space-y-4 max-h-[calc(var(--vvh)*0.6)] overflow-y-auto">
            {/* Create new tag */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                New Tag
              </label>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  placeholder="Tag name"
                  className="h-8 bg-muted/30 border-border/50"
                  maxLength={50}
                  onEnter={onCreateTag}
                />
                <Button
                  size="sm"
                  onClick={onCreateTag}
                  disabled={!newTagName.trim() || loading}
                  className="h-8 gap-1"
                >
                  <Plus className="w-3 h-3" />
                  Add
                </Button>
              </div>
              <ColorSwatches value={newTagColor} onChange={setNewTagColor} />
            </div>

            {/* Existing tags */}
            {tags.length > 0 && (
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Existing Tags
                </label>
                <div className="space-y-1">
                  {tags.map((tag) => (
                    <div
                      key={tag.id}
                      className={
                        editingId === tag.id
                          ? 'flex flex-col gap-2 p-2 rounded-md bg-muted/20'
                          : 'flex items-center gap-2 p-2 rounded-md bg-muted/20'
                      }
                    >
                      {editingId === tag.id ? (
                        <>
                          <div className="flex items-center gap-1">
                            <Input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              className="h-8 bg-muted/30 border-border/50"
                              maxLength={50}
                              onEnter={() => onUpdateTag(tag.id)}
                              autoFocus
                            />
                            <IconButton
                              size="sm"
                              variant="primary"
                              icon={Check}
                              className="p-1.5"
                              aria-label="Save tag"
                              title="Save"
                              onClick={() => onUpdateTag(tag.id)}
                              disabled={!editName.trim() || loading}
                            />
                            <IconButton
                              size="sm"
                              variant="ghost"
                              icon={X}
                              className="p-1.5"
                              aria-label="Cancel"
                              title="Cancel"
                              onClick={() => setEditingId(null)}
                            />
                          </div>
                          <ColorSwatches
                            value={editColor}
                            onChange={setEditColor}
                            compact
                          />
                        </>
                      ) : (
                        <>
                          <span
                            className="min-w-0 truncate px-2 py-0.5 rounded text-xs font-medium"
                            style={{
                              backgroundColor: `${tag.color}20`,
                              color: tag.color
                            }}
                          >
                            {tag.name}
                          </span>
                          <div className="flex items-center gap-1 ml-auto shrink-0">
                            <button
                              type="button"
                              onClick={() => startEditing(tag)}
                              aria-label={`Edit tag ${tag.name}`}
                              className="text-muted-foreground hover:text-foreground p-1"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteTag(tag.id)}
                              aria-label={`Delete tag ${tag.name}`}
                              className="text-muted-foreground hover:text-red-500 p-1"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }
);

export { ManageTagsDialog };
