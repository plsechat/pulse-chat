import { requestConfirmation } from '@/features/dialogs/actions';
import { useOwnUserId } from '@/features/server/users/hooks';
import { getFileUrl } from '@/helpers/get-file-url';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { imageExtensions, type TJoinedMessage } from '@pulse/shared';
import { format } from 'date-fns';
import DOMPurify from 'dompurify';
import parse from 'html-react-parser';
import { memo, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { Tooltip } from '../../../ui/tooltip';
import { FileCard } from '../file-card';
import { MessageReactions } from '../message-reactions';
import { ImageOverride } from '../overrides/image';
import { LinkPreview } from '../overrides/link-preview';
import { serializer } from './serializer';
import type { TFoundMedia } from './types';

type TMessageRendererProps = {
  message: TJoinedMessage;
};

const MessageRenderer = memo(({ message }: TMessageRendererProps) => {
  const ownUserId = useOwnUserId();
  const isOwnMessage = useMemo(
    () => message.userId === ownUserId,
    [message.userId, ownUserId]
  );

  const { foundMedia, messageHtml, isEmojiOnly } = useMemo(() => {
    const foundMedia: TFoundMedia[] = [];

    const sanitized = DOMPurify.sanitize(message.content ?? '', {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'u', 's', 'del', 'code', 'pre',
        'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'span', 'div',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'command', 'sup', 'sub'
      ],
      ALLOWED_ATTR: [
        'href', 'src', 'alt', 'class', 'target', 'rel',
        'data-type', 'data-mention-type', 'data-mention-id', 'data-mention-name',
        'data-emoji-name', 'data-emoji-id'
      ],
      ALLOW_DATA_ATTR: true
    });

    // Detect emoji-only messages: strip tags, check if remaining text is only whitespace,
    // and verify there are emoji elements (1-6 emojis)
    let isEmojiOnly = false;
    if (message.files.length === 0) {
      const textOnly = sanitized.replace(/<[^>]*>/g, '').trim();
      const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
      const emojiMatches = textOnly.match(emojiRegex);
      const strippedOfEmoji = textOnly.replace(emojiRegex, '').trim();

      // Also count custom emoji img tags with data-emoji-name
      const customEmojiCount = (sanitized.match(/data-emoji-name/g) || []).length;
      const totalEmojis = (emojiMatches?.length ?? 0) + customEmojiCount;

      if (strippedOfEmoji.length === 0 && totalEmojis >= 1 && totalEmojis <= 6) {
        isEmojiOnly = true;
      }
    }

    const messageHtml = parse(sanitized, {
      replace: (domNode) =>
        serializer(domNode, (found) => foundMedia.push(found))
    });

    return { messageHtml, foundMedia, isEmojiOnly };
  }, [message.content, message.files.length]);

  const onRemoveFileClick = useCallback(async (fileId: number) => {
    if (!fileId) return;

    const choice = await requestConfirmation({
      title: 'Delete file',
      message: 'Are you sure you want to delete this file?',
      confirmLabel: 'Delete'
    });

    if (!choice) return;

    const trpc = getTRPCClient();

    try {
      await trpc.files.delete.mutate({
        fileId
      });

      toast.success('File deleted');
    } catch {
      toast.error('Failed to delete file');
    }
  }, []);

  const allMedia = useMemo(() => {
    const mediaFromFiles: TFoundMedia[] = message.files
      .filter((file) => imageExtensions.includes(file.extension))
      .map((file) => ({
        type: 'image',
        url: getFileUrl(file)
      }));

    return [...foundMedia, ...mediaFromFiles];
  }, [foundMedia, message.files]);

  return (
    <div className="flex flex-col gap-1">
      <div className={cn('max-w-full break-words msg-content', isEmojiOnly && 'emoji-only')}>
        {messageHtml}
        {message.edited && (
          <Tooltip content={message.updatedAt ? `Edited ${format(new Date(message.updatedAt), 'PPpp')}` : 'Edited'}>
            <span className="text-[10px] text-muted-foreground/50 ml-1 cursor-default">
              (edited)
            </span>
          </Tooltip>
        )}
      </div>

      {allMedia.map((media, index) => {
        if (media.type === 'image') {
          return <ImageOverride src={media.url} key={`media-image-${index}`} />;
        }

        return null;
      })}

      {message.metadata && message.metadata.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {message.metadata
            .filter((meta) => meta.mediaType !== 'webhook')
            .map((meta, index) => (
              <LinkPreview key={`preview-${index}`} metadata={meta} />
            ))}
        </div>
      )}

      <MessageReactions reactions={message.reactions} messageId={message.id} />

      {message.files.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {message.files
            .filter((file) => !imageExtensions.includes(file.extension))
            .map((file) => (
              <FileCard
                key={file.id}
                name={file.originalName}
                extension={file.extension}
                size={file.size}
                onRemove={
                  isOwnMessage ? () => onRemoveFileClick(file.id) : undefined
                }
                href={getFileUrl(file)}
              />
            ))}
        </div>
      )}
    </div>
  );
});

export { MessageRenderer };
