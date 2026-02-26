import { useActiveInstanceDomain } from '@/features/app/hooks';
import { requestConfirmation } from '@/features/dialogs/actions';
import { useOwnUserId } from '@/features/server/users/hooks';
import { useDecryptedFileUrl } from '@/hooks/use-decrypted-file-url';
import {
  isLegacyHtml,
  TokenContentRenderer,
  isEmojiOnlyContent
} from '@/lib/converters/token-content-renderer';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import {
  audioExtensions,
  imageExtensions,
  videoExtensions,
  type TFile,
  type TJoinedMessage
} from '@pulse/shared';
import { Lock, Loader2 } from 'lucide-react';
import { fullDateTime } from '@/helpers/time-format';
import { format } from 'date-fns';
import DOMPurify from 'dompurify';
import parse from 'html-react-parser';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Tooltip } from '../../../ui/tooltip';
import { FileCard } from '../file-card';
import { MessageReactions } from '../message-reactions';
import { AudioPlayer } from '../overrides/audio-player';
import { ImageOverride } from '../overrides/image';
import { LinkPreview } from '../overrides/link-preview';
import { VideoPlayer } from '../overrides/video-player';
import { serializer } from './serializer';
import type { TFoundMedia } from './types';

type TMessageRendererProps = {
  message: TJoinedMessage;
};

/** Renders a single file attachment as media (image/video/audio), decrypting if E2EE. */
const MediaFile = memo(({
  file, fileIndex, messageId, isE2ee, instanceDomain
}: {
  file: TFile;
  fileIndex: number;
  messageId: number;
  isE2ee: boolean;
  instanceDomain?: string;
}) => {
  const { url, loading } = useDecryptedFileUrl(file, messageId, isE2ee, fileIndex, instanceDomain);

  if (loading) {
    return (
      <div className="flex items-center justify-center bg-muted rounded h-48 w-64 animate-pulse">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (imageExtensions.includes(file.extension)) {
    return <ImageOverride src={url} />;
  }
  if (videoExtensions.includes(file.extension)) {
    return <VideoPlayer src={url} name={file.originalName} />;
  }
  if (audioExtensions.includes(file.extension)) {
    return <AudioPlayer src={url} name={file.originalName} />;
  }
  return null;
});

/** Renders a non-media file card, decrypting the download URL if E2EE. */
const NonMediaFile = memo(({
  file, fileIndex, messageId, isE2ee, instanceDomain, onRemove
}: {
  file: TFile;
  fileIndex: number;
  messageId: number;
  isE2ee: boolean;
  instanceDomain?: string;
  onRemove?: () => void;
}) => {
  const { url, loading } = useDecryptedFileUrl(file, messageId, isE2ee, fileIndex, instanceDomain);

  return (
    <FileCard
      name={file.originalName}
      extension={file.extension}
      size={file.size}
      onRemove={onRemove}
      href={loading ? undefined : url}
    />
  );
});

const MessageRenderer = memo(({ message }: TMessageRendererProps) => {
  const ownUserId = useOwnUserId();
  const instanceDomain = useActiveInstanceDomain() ?? undefined;
  const isOwnMessage = useMemo(
    () => message.userId === ownUserId,
    [message.userId, ownUserId]
  );

  const content = message.content ?? '';
  const legacy = isLegacyHtml(content);
  const [tokenMedia, setTokenMedia] = useState<TFoundMedia[]>([]);

  // Legacy HTML rendering path
  const { foundMedia: htmlMedia, messageHtml, isEmojiOnly: htmlEmojiOnly } = useMemo(() => {
    if (!legacy) return { foundMedia: [] as TFoundMedia[], messageHtml: null, isEmojiOnly: false };

    const foundMedia: TFoundMedia[] = [];

    const sanitized = DOMPurify.sanitize(content, {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'u', 's', 'del', 'code', 'pre',
        'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'span', 'div',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'command', 'sup', 'sub'
      ],
      ALLOWED_ATTR: [
        'href', 'src', 'alt', 'class', 'target', 'rel',
        'data-type', 'data-mention-type', 'data-mention-id', 'data-mention-name',
        'data-emoji-name', 'data-emoji-id',
        'data-channel-id', 'data-channel-name'
      ],
      ALLOW_DATA_ATTR: false
    });

    let isEmojiOnly = false;
    if (message.files.length === 0) {
      const textOnly = sanitized.replace(/<[^>]*>/g, '').trim();
      const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
      const emojiMatches = textOnly.match(emojiRegex);
      const strippedOfEmoji = textOnly
        .replace(emojiRegex, '')
        .replace(/\u200D|\uFE0E|\uFE0F/g, '')
        .trim();

      const customEmojiCount = (sanitized.match(/data-emoji-name/g) || []).length;
      const totalEmojis = (emojiMatches?.length ?? 0) + customEmojiCount;

      if (strippedOfEmoji.length === 0 && totalEmojis >= 1 && totalEmojis <= 6) {
        isEmojiOnly = true;
      }
    }

    let messageHtml;
    try {
      messageHtml = parse(sanitized, {
        replace: (domNode) =>
          serializer(domNode, (found) => foundMedia.push(found))
      });
    } catch (err) {
      console.error('[MessageRenderer] serialization failed, rendering plain:', err);
      messageHtml = parse(sanitized);
    }

    return { messageHtml, foundMedia, isEmojiOnly };
  }, [content, legacy, message.files.length]);

  const tokenEmojiOnly = !legacy && isEmojiOnlyContent(content, message.files.length);
  const isEmojiOnly = legacy ? htmlEmojiOnly : tokenEmojiOnly;
  const foundMedia = legacy ? htmlMedia : tokenMedia;

  const handleTokenMedia = useCallback((media: TFoundMedia) => {
    setTokenMedia((prev) => {
      if (prev.some((m) => m.url === media.url)) return prev;
      return [...prev, media];
    });
  }, []);

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

  // Categorize message files into media vs non-media, preserving original index
  const { mediaFiles, nonMediaFiles } = useMemo(() => {
    const mediaFiles: { file: TFile; index: number }[] = [];
    const nonMediaFiles: { file: TFile; index: number }[] = [];

    message.files.forEach((file, index) => {
      if (
        imageExtensions.includes(file.extension) ||
        videoExtensions.includes(file.extension) ||
        audioExtensions.includes(file.extension)
      ) {
        mediaFiles.push({ file, index });
      } else {
        nonMediaFiles.push({ file, index });
      }
    });

    return { mediaFiles, nonMediaFiles };
  }, [message.files]);

  const isDecryptionFailure =
    message.e2ee && message.content === '[Unable to decrypt]';

  return (
    <div className="flex flex-col gap-1">
      {isDecryptionFailure ? (
        <div className="flex items-center gap-1.5 text-sm text-destructive/80 italic">
          <Lock className="h-3 w-3" />
          <span>Unable to decrypt this message</span>
        </div>
      ) : (
      <div className="flex items-start gap-1.5">
        {message.e2ee && (
          <Tooltip content="End-to-end encrypted">
            <Lock className="h-3 w-3 text-emerald-500 shrink-0 mt-[0.3rem] cursor-default" />
          </Tooltip>
        )}
      <div className={cn('max-w-full break-words msg-content min-w-0', isEmojiOnly && 'emoji-only')}>
        {legacy ? messageHtml : (
          <TokenContentRenderer
            content={content}
            fileCount={message.files.length}
            onFoundMedia={handleTokenMedia}
          />
        )}
        {message.edited && (
          <Tooltip content={message.updatedAt ? `Edited ${format(new Date(message.updatedAt), fullDateTime())}` : 'Edited'}>
            <span className="text-[10px] text-muted-foreground/50 ml-1 cursor-default">
              (edited)
            </span>
          </Tooltip>
        )}
      </div>
      </div>
      )}

      {/* Inline media from message HTML (links, embeds) */}
      {foundMedia.map((media, index) => {
        if (media.type === 'image') {
          return <ImageOverride src={media.url} key={`inline-${index}`} />;
        }
        if (media.type === 'video') {
          return <VideoPlayer src={media.url} name={media.name} key={`inline-${index}`} />;
        }
        if (media.type === 'audio') {
          return <AudioPlayer src={media.url} name={media.name} key={`inline-${index}`} />;
        }
        return null;
      })}

      {/* Media file attachments (images, videos, audio) — each component handles E2EE decryption */}
      {mediaFiles.map(({ file, index }) => (
        <MediaFile
          key={file.id}
          file={file}
          fileIndex={index}
          messageId={message.id}
          isE2ee={message.e2ee}
          instanceDomain={instanceDomain}
        />
      ))}

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

      {nonMediaFiles.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {nonMediaFiles.map(({ file, index }) => (
            <NonMediaFile
              key={file.id}
              file={file}
              fileIndex={index}
              messageId={message.id}
              isE2ee={message.e2ee}
              instanceDomain={instanceDomain}
              onRemove={
                isOwnMessage ? () => onRemoveFileClick(file.id) : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
});

export { MessageRenderer };
