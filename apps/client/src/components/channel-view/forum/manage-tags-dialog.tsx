import { Button } from '@/components/ui/button';
import { getTRPCClient } from '@/lib/trpc';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
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

      try {
        const result = await trpc.threads.getForumTags.query({ channelId });
        setTags(result);
      } catch {
        // ignore
      }
    }, [channelId]);

    useEffect(() => {
      fetchTags();
    }, [fetchTags]);

    const onCreateTag = useCallback(async () => {
      if (!newTagName.trim() || loading) return;

      setLoading(true);

      const trpc = getTRPCClient();

      try {
        await trpc.threads.createForumTag.mutate({
          channelId,
          name: newTagName.trim(),
          color: newTagColor
        });
        setNewTagName('');
        setNewTagColor('#808080');
        fetchTags();
      } catch {
        toast.error('Failed to create tag');
      } finally {
        setLoading(false);
      }
    }, [newTagName, newTagColor, channelId, loading, fetchTags]);

    const onUpdateTag = useCallback(
      async (tagId: number) => {
        if (!editName.trim() || loading) return;

        setLoading(true);

        const trpc = getTRPCClient();

        try {
          await trpc.threads.updateForumTag.mutate({
            tagId,
            name: editName.trim(),
            color: editColor
          });
          setEditingId(null);
          fetchTags();
        } catch {
          toast.error('Failed to update tag');
        } finally {
          setLoading(false);
        }
      },
      [editName, editColor, loading, fetchTags]
    );

    const onDeleteTag = useCallback(
      async (tagId: number) => {
        const trpc = getTRPCClient();

        try {
          await trpc.threads.deleteForumTag.mutate({ tagId });
          fetchTags();
        } catch {
          toast.error('Failed to delete tag');
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
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
            {/* Create new tag */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                New Tag
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  placeholder="Tag name"
                  className="flex-1 px-3 py-1.5 text-sm bg-muted/30 border border-border/50 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30"
                  maxLength={50}
                  onKeyDown={(e) => e.key === 'Enter' && onCreateTag()}
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
              <div className="flex gap-1">
                {TAG_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setNewTagColor(color)}
                    className="w-5 h-5 rounded-full border-2 transition-transform"
                    style={{
                      backgroundColor: color,
                      borderColor:
                        newTagColor === color ? 'white' : 'transparent',
                      transform:
                        newTagColor === color ? 'scale(1.2)' : 'scale(1)'
                    }}
                  />
                ))}
              </div>
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
                      className="flex items-center gap-2 p-2 rounded-md bg-muted/20"
                    >
                      {editingId === tag.id ? (
                        <>
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="flex-1 px-2 py-1 text-sm bg-muted/30 border border-border/50 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30"
                            maxLength={50}
                            onKeyDown={(e) =>
                              e.key === 'Enter' && onUpdateTag(tag.id)
                            }
                            autoFocus
                          />
                          <div className="flex gap-0.5">
                            {TAG_COLORS.map((color) => (
                              <button
                                key={color}
                                type="button"
                                onClick={() => setEditColor(color)}
                                className="w-4 h-4 rounded-full border-2 transition-transform"
                                style={{
                                  backgroundColor: color,
                                  borderColor:
                                    editColor === color
                                      ? 'white'
                                      : 'transparent',
                                  transform:
                                    editColor === color
                                      ? 'scale(1.2)'
                                      : 'scale(1)'
                                }}
                              />
                            ))}
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            onClick={() => onUpdateTag(tag.id)}
                            disabled={!editName.trim() || loading}
                          >
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <span
                            className="px-2 py-0.5 rounded text-xs font-medium"
                            style={{
                              backgroundColor: `${tag.color}20`,
                              color: tag.color
                            }}
                          >
                            {tag.name}
                          </span>
                          <div className="flex items-center gap-1 ml-auto">
                            <button
                              type="button"
                              onClick={() => startEditing(tag)}
                              className="text-muted-foreground hover:text-foreground p-1"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteTag(tag.id)}
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
