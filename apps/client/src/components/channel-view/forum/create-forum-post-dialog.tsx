import { Button } from '@/components/ui/button';
import { getTRPCClient } from '@/lib/trpc';
import { setActiveThreadId } from '@/features/server/channels/actions';
import { uploadFiles } from '@/helpers/upload-file';
import { Image, Plus, X } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

type TCreateForumPostDialogProps = {
  channelId: number;
  onClose: () => void;
};

type TTag = {
  id: number;
  name: string;
  color: string;
};

type TUploadedFile = {
  tempId: string;
  originalName: string;
  previewUrl: string | null;
  isImage: boolean;
};

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico'
]);

const CreateForumPostDialog = memo(
  ({ channelId, onClose }: TCreateForumPostDialogProps) => {
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [tags, setTags] = useState<TTag[]>([]);
    const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [uploadedFiles, setUploadedFiles] = useState<TUploadedFile[]>([]);
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      const fetchTags = async () => {
        const trpc = getTRPCClient();

        try {
          const result = await trpc.threads.getForumTags.query({ channelId });
          setTags(result);
        } catch {
          // ignore
        }
      };

      fetchTags();
    }, [channelId]);

    const toggleTag = useCallback((tagId: number) => {
      setSelectedTagIds((prev) =>
        prev.includes(tagId)
          ? prev.filter((id) => id !== tagId)
          : [...prev, tagId]
      );
    }, []);

    const onFileInputChange = useCallback(
      async (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFiles = Array.from(e.target.files ?? []);
        if (selectedFiles.length === 0) return;

        setUploading(true);

        try {
          const uploaded = await uploadFiles(selectedFiles);
          const newFiles: TUploadedFile[] = uploaded.map((tempFile, i) => {
            const isImage = IMAGE_EXTENSIONS.has(
              tempFile.extension.toLowerCase()
            );
            const originalFile = selectedFiles[i];
            const previewUrl =
              isImage && originalFile
                ? URL.createObjectURL(originalFile)
                : null;

            return {
              tempId: tempFile.id,
              originalName: tempFile.originalName,
              previewUrl,
              isImage
            };
          });
          setUploadedFiles((prev) => [...prev, ...newFiles]);
        } catch {
          toast.error('Failed to upload file');
        } finally {
          setUploading(false);
          e.target.value = '';
        }
      },
      []
    );

    const removeFile = useCallback((id: string) => {
      setUploadedFiles((prev) => {
        const file = prev.find((f) => f.tempId === id);
        if (file?.previewUrl) URL.revokeObjectURL(file.previewUrl);
        return prev.filter((f) => f.tempId !== id);
      });
    }, []);

    const onSubmit = useCallback(async () => {
      if (!title.trim() || !content.trim() || submitting) return;

      setSubmitting(true);

      const trpc = getTRPCClient();

      try {
        const result = await trpc.threads.createForumPost.mutate({
          channelId,
          title: title.trim(),
          content: content.trim(),
          tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
          files:
            uploadedFiles.length > 0
              ? uploadedFiles.map((f) => f.tempId)
              : undefined
        });

        setActiveThreadId(result.threadId);
        toast.success('Post created');
        onClose();
      } catch {
        toast.error('Failed to create post');
      } finally {
        setSubmitting(false);
      }
    }, [
      title,
      content,
      channelId,
      selectedTagIds,
      uploadedFiles,
      submitting,
      onClose
    ]);

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-popover border border-border rounded-lg shadow-xl w-full max-w-lg mx-4">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
            <h2 className="text-sm font-semibold">New Post</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4 space-y-3">
            <div>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Post title"
                className="w-full px-3 py-2 text-sm bg-muted/30 border border-border/50 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30"
                maxLength={200}
                autoFocus
              />
            </div>

            <div>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Write your post..."
                className="w-full px-3 py-2 text-sm bg-muted/30 border border-border/50 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/30 min-h-[120px] resize-y"
                rows={5}
              />
            </div>

            {/* Uploaded files preview */}
            {uploadedFiles.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {uploadedFiles.map((file) => (
                  <div
                    key={file.tempId}
                    className="relative group rounded-md overflow-hidden border border-border/50"
                  >
                    {file.isImage && file.previewUrl ? (
                      <img
                        src={file.previewUrl}
                        alt={file.originalName}
                        className="h-16 w-16 object-cover"
                      />
                    ) : (
                      <div className="h-16 w-16 flex items-center justify-center bg-muted/30 text-xs text-muted-foreground p-1 text-center">
                        {file.originalName}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => removeFile(file.tempId)}
                      className="absolute top-0.5 right-0.5 bg-black/60 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-3 h-3 text-white" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {tags.length > 0 && (
              <div className="flex gap-1 flex-wrap">
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

          <div className="flex items-center gap-2 px-4 py-3 border-t border-border/50">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*"
              onChange={onFileInputChange}
              className="hidden"
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="gap-1"
            >
              <Image className="w-4 h-4" />
              {uploading ? 'Uploading...' : 'Add Image'}
            </Button>

            <div className="flex gap-2 ml-auto">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={onSubmit}
                disabled={
                  !title.trim() || !content.trim() || submitting || uploading
                }
              >
                <Plus className="w-4 h-4 mr-1" />
                Create Post
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

export { CreateForumPostDialog };
