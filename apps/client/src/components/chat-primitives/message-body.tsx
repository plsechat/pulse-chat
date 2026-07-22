import { fullDateTime } from '@/helpers/time-format';
import { useDecryptedFileUrl } from '@/hooks/use-decrypted-file-url';
import {
  isEmojiOnlyContent,
  isLegacyHtml,
  TokenContentRenderer
} from '@/lib/converters/token-content-renderer';
import { cn } from '@/lib/utils';
import {
  audioExtensions,
  imageExtensions,
  videoExtensions,
  type TFile,
  type TMessageMetadata
} from '@pulse/shared';
import { format } from 'date-fns';
import DOMPurify from 'dompurify';
import parse from 'html-react-parser';
import { Loader2, Lock } from 'lucide-react';
import {
  memo,
  useCallback,
  useMemo,
  useState,
  type ComponentProps
} from 'react';
import { Tooltip } from '@/components/ui/tooltip';
import { FileCard } from './file-card';
import { ImageContextMenu } from './image-context-menu';
import { MessageReactions } from './message-reactions';
import { AudioPlayer } from './overrides/audio-player';
import { ImageOverride } from './overrides/image';
import { LinkPreview } from './overrides/link-preview';
import { VideoPlayer } from './overrides/video-player';
import { serializer } from './serializer';
import type { TFoundMedia } from './types';

/**
 * The shared message body — content, attachments, link previews,
 * reactions — used by BOTH the channel and DM stacks (deduplicated
 * from channel renderer/index.tsx and DmMessageContent).
 *
 * Adapter contract: no trpc client and no ambient data hook in here.
 * The caller supplies the id-space (`homeScope`, DM surfaces), the
 * federated file domain (`instanceDomain`, channel surfaces — DMs are
 * always home-hosted and pass nothing), and mutations as callbacks
 * (`onToggleReaction`, `onRemoveFile`).
 *
 * Deliberate unifications (previously divergent):
 * - Legacy HTML is ALWAYS DOMPurify-sanitized (the DM copy parsed raw).
 * - Emoji-only sizing applies on both surfaces.
 * - The edited tag keys on the `edited` flag (the DM copy keyed on
 *   updatedAt, which also flips on pin/unpin) with the timestamp
 *   tooltip.
 * - Non-media attachments render as FileCard (with the blob: download
 *   name fix) instead of the DM's bare link.
 */

type TBodyMessage = {
  id: number;
  content: string | null;
  e2ee: boolean;
  edited: boolean;
  updatedAt: number | null;
  files: TFile[];
  metadata: TMessageMetadata[] | null;
  reactions: ComponentProps<typeof MessageReactions>['reactions'];
};

type TMessageBodyProps = {
  message: TBodyMessage;
  instanceDomain?: string;
  homeScope?: boolean;
  onToggleReaction?: (emoji: string) => void;
  /** Own-message attachment delete (channel surfaces only today). */
  onRemoveFile?: (fileId: number) => void;
};

/** E2EE placeholders the decrypt pipeline leaves when it can't produce plaintext. */
const DECRYPTION_SENTINELS = ['[Unable to decrypt]', '[Encrypted message]'];

/** Renders a single attachment as media (image/video/audio), decrypting if E2EE. */
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
    return (
      <ImageContextMenu src={url} filename={file.originalName}>
        <ImageOverride src={url} />
      </ImageContextMenu>
    );
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

const ChatMessageBody = memo(({
  message,
  instanceDomain,
  homeScope,
  onToggleReaction,
  onRemoveFile
}: TMessageBodyProps) => {
  const content = message.content ?? '';
  const legacy = isLegacyHtml(content);
  const [tokenMedia, setTokenMedia] = useState<TFoundMedia[]>([]);

  // Legacy HTML rendering path — ALWAYS sanitized.
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
      console.error('[ChatMessageBody] serialization failed, rendering plain:', err);
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

  // Categorize attachments into media vs non-media, preserving the
  // ORIGINAL index — E2EE file keys are positional.
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
    message.e2ee &&
    message.content !== null &&
    DECRYPTION_SENTINELS.includes(message.content);

  return (
    <div className="flex flex-col gap-1">
      {isDecryptionFailure ? (
        <div className="flex items-center gap-1.5 text-sm text-destructive/80 italic">
          <Lock className="h-3 w-3" />
          <span>Unable to decrypt this message</span>
        </div>
      ) : content ? (
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
                <span className="edited-tag text-[10px] text-muted-foreground/50 ml-1 cursor-default">
                  (edited)
                </span>
              </Tooltip>
            )}
          </div>
        </div>
      ) : null}

      {/* Inline media found in message content (links, embeds) */}
      {foundMedia.map((media, index) => {
        if (media.type === 'image') {
          return (
            <ImageContextMenu src={media.url} key={`inline-${index}`}>
              <ImageOverride src={media.url} />
            </ImageContextMenu>
          );
        }
        if (media.type === 'video') {
          return <VideoPlayer src={media.url} name={media.name} key={`inline-${index}`} />;
        }
        if (media.type === 'audio') {
          return <AudioPlayer src={media.url} name={media.name} key={`inline-${index}`} />;
        }
        return null;
      })}

      {/* Media attachments — each component handles E2EE decryption */}
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

      <MessageReactions
        reactions={message.reactions}
        messageId={message.id}
        onToggle={onToggleReaction}
        homeScope={homeScope}
      />

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
                onRemoveFile ? () => onRemoveFile(file.id) : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
});

export { ChatMessageBody };
