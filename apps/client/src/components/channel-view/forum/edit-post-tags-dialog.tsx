import { Button } from '@/components/ui/button';
import { getTRPCClient } from '@/lib/trpc';
import { X } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type TTag = {
  id: number;
  name: string;
  color: string;
};

type TEditPostTagsDialogProps = {
  threadId: number;
  channelId: number;
  currentTagIds: number[];
  onClose: () => void;
};

const EditPostTagsDialog = memo(
  ({ threadId, channelId, currentTagIds, onClose }: TEditPostTagsDialogProps) => {
    const [tags, setTags] = useState<TTag[]>([]);
    const [selectedTagIds, setSelectedTagIds] = useState<number[]>(currentTagIds);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
      const trpc = getTRPCClient();
      trpc.threads.getForumTags
        .query({ channelId })
        .then(setTags)
        .catch(() => {});
    }, [channelId]);

    const toggleTag = useCallback((tagId: number) => {
      setSelectedTagIds((prev) =>
        prev.includes(tagId)
          ? prev.filter((id) => id !== tagId)
          : [...prev, tagId]
      );
    }, []);

    const onSave = useCallback(async () => {
      setSaving(true);
      const trpc = getTRPCClient();

      try {
        await trpc.threads.updatePostTags.mutate({
          threadId,
          tagIds: selectedTagIds
        });
        toast.success('Tags updated');
        onClose();
      } catch {
        toast.error('Failed to update tags');
      } finally {
        setSaving(false);
      }
    }, [threadId, selectedTagIds, onClose]);

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-background border border-border rounded-lg shadow-lg w-full max-w-sm">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
            <h3 className="text-sm font-semibold">Edit Tags</h3>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4">
            {tags.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No tags available. Create tags in the forum settings.
              </p>
            ) : (
              <div className="flex gap-1.5 flex-wrap">
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    className="px-2 py-1 rounded text-xs font-medium border transition-colors"
                    style={{
                      backgroundColor: selectedTagIds.includes(tag.id)
                        ? `${tag.color}30`
                        : 'transparent',
                      borderColor: selectedTagIds.includes(tag.id)
                        ? tag.color
                        : 'var(--border)',
                      color: selectedTagIds.includes(tag.id)
                        ? tag.color
                        : 'inherit'
                    }}
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 px-4 py-3 border-t border-border/50">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={onSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    );
  }
);

export { EditPostTagsDialog };
