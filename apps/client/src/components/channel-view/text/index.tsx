import {
  ComposerExpandToggle,
  ComposerResizer,
  MIN_COMPOSER_HEIGHT
} from '@/components/chat-primitives/composer-expand';
import { DateDivider } from '@/components/chat-primitives/date-divider';
import { FileCard } from '@/components/chat-primitives/file-card';
import { FormattingHints } from '@/components/chat-primitives/formatting-hints';
import { NewMessagesDivider } from '@/components/chat-primitives/new-messages-divider';
import { ReplyContentPreview } from '@/components/chat-primitives/reply-content-preview';
import { SystemMessage } from '@/components/chat-primitives/system-message';
import {
  useComposerHelpers,
  useTypingSignal
} from '@/components/chat-primitives/use-composer-helpers';
import { GifPicker } from '@/components/gif-picker';
import { TiptapInput } from '@/components/tiptap-input';
import Spinner from '@/components/ui/spinner';
import {
  useChannelById,
  useLastReadMessageId,
  useSelectedChannel
} from '@/features/server/channels/hooks';
import {
  useCan,
  useChannelCan,
  usePreviewMeta,
  usePreviewMode
} from '@/features/server/hooks';
import { useMessages } from '@/features/server/messages/hooks';
import { useFlatPluginCommands } from '@/features/server/plugins/hooks';
import { joinPreviewedServer } from '@/features/server/preview/actions';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { isSystemLikeMessage } from '@/helpers/automod-alert';
import { getDisplayName } from '@/helpers/get-display-name';
import { isGiphyEnabled } from '@/helpers/giphy';
import { isHtmlEmpty } from '@/helpers/is-html-empty';
import {
  messageHasCodeBlock,
  uploadOversizedMessage,
  type TOversizedUpload
} from '@/helpers/oversized-message';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useScrollToMessage } from '@/hooks/use-scroll-to-message';
import { tiptapHtmlToTokens } from '@/lib/converters/tiptap-to-tokens';
import {
  encryptChannelMessage,
  ensureActiveChannelSenderKey
} from '@/lib/e2ee';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TJoinedMessage } from '@pulse/server/types';
import {
  ChannelPermission,
  MAX_MESSAGE_CONTENT_LENGTH,
  Permission,
  TYPING_MS
} from '@pulse/shared';
import { filesize } from 'filesize';
import { ArrowDown, Clock, Plus, Reply, Send, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../ui/button';
import { MessagesGroup } from './messages-group';
import { SelectionActionBar } from './selection-action-bar';
import { SelectionProvider, useSelection } from './selection-context';
import { TextSkeleton } from './text-skeleton';
import { useScrollController } from './use-scroll-controller';
import { UsersTyping } from './users-typing';

// Date and new-messages dividers live in chat-primitives so the DM
// view paints them identically — see imports above.

// Upper bound on the entry fade (500ms keyframes + slack) — see the
// scroll container below.
const ENTER_FADE_FALLBACK_MS = 700;

type TChannelProps = {
  channelId: number;
};

const ReplyBar = memo(
  ({
    message,
    onDismiss
  }: {
    message: TJoinedMessage;
    onDismiss: () => void;
  }) => {
    const user = useUserById(message.userId);

    const scrollToTarget = useScrollToMessage();
    const scrollToMessage = useCallback(
      () => scrollToTarget(message.id),
      [scrollToTarget, message.id]
    );

    return (
      <div className="flex items-center gap-2 rounded-lg text-sm border-l-3 border-l-primary bg-primary/5 overflow-hidden">
        <button
          type="button"
          onClick={scrollToMessage}
          className="flex items-center gap-2 flex-1 min-w-0 px-3 py-1.5 hover:bg-primary/10 transition-colors cursor-pointer"
        >
          <Reply className="h-3.5 w-3.5 shrink-0 text-primary rotate-180" />
          <span className="font-semibold text-primary shrink-0">
            {getDisplayName(user)}
          </span>
          <span className="truncate text-muted-foreground">
            {message.content ? (
              <ReplyContentPreview content={message.content} />
            ) : message.files.length > 0 ? (
              'Attachment'
            ) : (
              'Message deleted'
            )}
          </span>
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Cancel reply"
          className="shrink-0 mr-2 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
);

const TextChannel = memo(({ channelId }: TChannelProps) => (
  <SelectionProvider>
    <TextChannelInner channelId={channelId} />
  </SelectionProvider>
));

const TextChannelInner = memo(({ channelId }: TChannelProps) => {
  const {
    messages,
    hasMore,
    loadMore,
    loadNewer,
    reattach,
    detached,
    loading,
    fetching,
    groupedMessages
  } = useMessages(channelId);
  const [newMessage, setNewMessage] = useState('');
  const [replyingTo, setReplyingTo] = useState<TJoinedMessage | null>(null);
  const [slowModeRemaining, setSlowModeRemaining] = useState(0);
  const slowModeTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined
  );
  const selectedChannel = useSelectedChannel();
  const currentChannel = useChannelById(channelId);
  const slowMode = selectedChannel?.slowMode ?? 0;
  const isE2ee = selectedChannel?.e2ee ?? false;
  const ownUserId = useOwnUserId();
  const lastReadMessageId = useLastReadMessageId(channelId);
  const allPluginCommands = useFlatPluginCommands();
  const { containerRef, onScroll, scrollToBottom, isAtBottom } =
    useScrollController({
      channelId,
      messages,
      fetching,
      hasMore,
      loadMore,
      detached,
      loadNewer
    });
  const can = useCan();
  const channelCan = useChannelCan(channelId);
  const previewMode = usePreviewMode();
  const previewMeta = usePreviewMeta();
  const { selectionMode, setMessageIds } = useSelection();
  const canSendMessages = useMemo(() => {
    return (
      can(Permission.SEND_MESSAGES) &&
      channelCan(ChannelPermission.SEND_MESSAGES)
    );
  }, [can, channelCan]);

  useEffect(() => {
    setMessageIds(messages.map((m) => m.id));
  }, [messages, setMessageIds]);

  const startSlowModeCooldown = useCallback(() => {
    if (slowMode <= 0) return;

    setSlowModeRemaining(slowMode);

    if (slowModeTimerRef.current) {
      clearInterval(slowModeTimerRef.current);
    }

    slowModeTimerRef.current = setInterval(() => {
      setSlowModeRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(slowModeTimerRef.current);
          return 0;
        }

        return prev - 1;
      });
    }, 1000);
  }, [slowMode]);

  useEffect(() => {
    return () => {
      if (slowModeTimerRef.current) {
        clearInterval(slowModeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setSlowModeRemaining(0);

    if (slowModeTimerRef.current) {
      clearInterval(slowModeTimerRef.current);
    }
  }, [channelId]);

  const pluginCommands = useMemo(
    () =>
      can(Permission.EXECUTE_PLUGIN_COMMANDS) ? allPluginCommands : undefined,
    [can, allPluginCommands]
  );

  const [multilineMode, setMultilineMode] = useState(false);
  const [composerHeight, setComposerHeight] = useState(
    MIN_COMPOSER_HEIGHT * 1.4
  );

  const sendGif = useCallback(
    async (gifUrl: string) => {
      const trpc = getTRPCClient();
      if (!trpc) return;
      // Thread reply context — picking a GIF while replying should
      // attach to the parent message, not start a new top-level msg.
      const replyToId = replyingTo?.id;

      if (isE2ee && ownUserId) {
        await ensureActiveChannelSenderKey(channelId);

        const encryptedContent = await encryptChannelMessage(
          channelId,
          ownUserId,
          { content: gifUrl }
        );
        await trpc.messages.send.mutate({
          content: encryptedContent,
          e2ee: true,
          channelId,
          replyToId
        });
      } else {
        await trpc.messages.send.mutate({
          content: gifUrl,
          channelId,
          replyToId
        });
      }
      playSound(SoundType.MESSAGE_SENT);
    },
    [channelId, isE2ee, ownUserId, replyingTo]
  );

  // Shared composer plumbing (see chat-primitives/use-composer-helpers):
  // the editor focus, hidden file input, staged-upload removal and the
  // GIF-send envelope are identical to the DM composer's.
  const {
    inputAreaRef,
    fileInputRef,
    focusEditorAtBottom,
    files,
    clearFiles,
    uploading,
    uploadingSize,
    fileKeyMapRef,
    onFileInputChange,
    onRemoveFileClick,
    onGifSelect
  } = useComposerHelpers({
    uploadDisabled: !canSendMessages,
    isE2ee,
    sendGif,
    onGifSent: () => setReplyingTo(null),
    deleteTemporaryFile: (fileId) =>
      getTRPCClient()?.files.deleteTemporary.mutate({ fileId }) ??
      Promise.resolve(),
    detached,
    reattach,
    scrollToBottom
  });

  const handleReply = useCallback(
    (message: TJoinedMessage) => {
      setReplyingTo(message);
      focusEditorAtBottom();
    },
    [focusEditorAtBottom]
  );

  const signalTyping = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      await trpc.messages.signalTyping.mutate({ channelId });
    } catch {
      // ignore
    }
  }, [channelId]);
  const sendTypingSignal = useTypingSignal(signalTyping, TYPING_MS);

  // Entry fade for the skeleton → content handoff, made ONE-SHOT. The
  // container used to carry `animate-in fade-in duration-500` for its
  // whole life; an entry animation that was interrupted (tab hidden,
  // re-layout mid-keyframe) could leave the keyframe's partial opacity
  // on the element, which read as "every message greyed out" until the
  // channel was reopened (Danny, 2026-10-15). Now the class is removed
  // on `animationend`, with a timer as the fallback when that event
  // never arrives — so once the fallback has elapsed the list cannot be
  // anything but fully opaque. The component is keyed per channel
  // (content-wrapper), so a channel switch starts fresh.
  const [entered, setEntered] = useState(false);
  const finishEntering = useCallback(() => setEntered(true), []);
  useEffect(() => {
    if (entered || loading) return;
    const timer = setTimeout(finishEntering, ENTER_FADE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [entered, loading, finishEntering]);

  const onSendMessage = useCallback(async () => {
    if ((isHtmlEmpty(newMessage) && !files.length) || !canSendMessages) return;

    sendTypingSignal.cancel();

    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      const content = tiptapHtmlToTokens(newMessage);

      // Check plaintext length BEFORE encryption — the server's wire cap
      // is sized for the encrypted envelope, so this is the real budget.
      // Over-length code blocks are shipped as a message.txt attachment
      // instead of being rejected.
      let sendContent = content;
      let txtUpload: TOversizedUpload | null = null;
      if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
        if (!messageHasCodeBlock(newMessage, content)) {
          toast.error(
            `Message is too long (${content.length.toLocaleString()} of ${MAX_MESSAGE_CONTENT_LENGTH.toLocaleString()} characters). Try attaching it as a file instead.`
          );
          return;
        }

        txtUpload = await uploadOversizedMessage(content, isE2ee);
        if (!txtUpload) return;

        sendContent = '';
        toast.info('Message was over the length limit — sent as message.txt');
      }

      const fileIds = [
        ...files.map((f) => f.id),
        ...(txtUpload ? [txtUpload.tempFile.id] : [])
      ];

      if (isE2ee && ownUserId) {
        // Ensure we have a sender key and distribute to members
        await ensureActiveChannelSenderKey(channelId);

        // Build fileKeys from encrypted upload key material. Includes
        // the real originalName + extension so the recipient can render
        // them — the server stores only placeholders.
        const fileKeyEntries = files
          .map((f) => {
            const keyInfo = fileKeyMapRef.current.get(f.id);
            return keyInfo
              ? {
                  fileId: f.id,
                  key: keyInfo.key,
                  nonce: keyInfo.nonce,
                  mimeType: keyInfo.mimeType,
                  originalName: keyInfo.originalName,
                  extension: keyInfo.extension
                }
              : null;
          })
          .filter((k): k is NonNullable<typeof k> => k !== null);

        if (txtUpload?.keyInfo) {
          fileKeyEntries.push({
            fileId: txtUpload.tempFile.id,
            key: txtUpload.keyInfo.key,
            nonce: txtUpload.keyInfo.nonce,
            mimeType: txtUpload.keyInfo.mimeType,
            originalName: txtUpload.keyInfo.originalName,
            extension: txtUpload.keyInfo.extension
          });
        }

        const fileKeys = fileKeyEntries.length > 0 ? fileKeyEntries : undefined;

        const encryptedContent = await encryptChannelMessage(
          channelId,
          ownUserId,
          { content: sendContent, fileKeys }
        );

        await trpc.messages.send.mutate({
          content: encryptedContent,
          e2ee: true,
          channelId,
          files: fileIds,
          replyToId: replyingTo?.id
        });
      } else {
        await trpc.messages.send.mutate({
          content: sendContent,
          channelId,
          files: fileIds,
          replyToId: replyingTo?.id
        });
      }

      playSound(SoundType.MESSAGE_SENT);
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to send message'));
      return;
    }

    setNewMessage('');
    setReplyingTo(null);
    clearFiles();
    startSlowModeCooldown();

    if (detached) {
      // Sent from deep in history: the echo lands beyond the detached
      // window and is not stored there, so rejoin the live tail to
      // show it.
      await reattach();
      requestAnimationFrame(scrollToBottom);
    }
  }, [
    newMessage,
    channelId,
    files,
    clearFiles,
    sendTypingSignal,
    canSendMessages,
    replyingTo,
    startSlowModeCooldown,
    isE2ee,
    ownUserId,
    fileKeyMapRef,
    detached,
    reattach,
    scrollToBottom
  ]);

  if (!channelCan(ChannelPermission.VIEW_CHANNEL) || loading) {
    return <TextSkeleton />;
  }

  return (
    <>
      {fetching && (
        <div className="absolute top-0 left-0 right-0 h-12 z-10 flex items-center justify-center">
          <div className="flex items-center gap-2 bg-background/80 backdrop-blur-sm border border-border rounded-full px-4 py-2 shadow-lg">
            <Spinner size="xs" />
            <span className="text-sm text-muted-foreground">
              Fetching older messages...
            </span>
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        onScroll={onScroll}
        data-testid="message-scroll"
        onAnimationEnd={(e) => {
          // Children animate too (message highlight, spinners) — only
          // the container's own entry animation ends the fade.
          if (e.target === e.currentTarget) finishEntering();
        }}
        className={cn(
          'flex-1 overflow-y-auto overflow-x-hidden pb-4',
          !entered && 'animate-in fade-in duration-500'
        )}
      >
        {groupedMessages.map((group, index) => {
          const showDivider =
            lastReadMessageId != null &&
            group.some((msg) => msg.id > lastReadMessageId) &&
            (index === 0 ||
              !groupedMessages[index - 1].some(
                (msg) => msg.id > lastReadMessageId
              ));

          const currentDay = new Date(group[0].createdAt).toDateString();
          const prevDay =
            index > 0
              ? new Date(groupedMessages[index - 1][0].createdAt).toDateString()
              : null;
          const showDateDivider = prevDay !== null && currentDay !== prevDay;

          return (
            <div key={index} className="message-group-window">
              {showDateDivider && (
                <DateDivider timestamp={group[0].createdAt} />
              )}
              {showDivider && <NewMessagesDivider />}
              {isSystemLikeMessage(group[0]) ? (
                <SystemMessage message={group[0]} />
              ) : (
                <MessagesGroup group={group} onReply={handleReply} />
              )}
            </div>
          );
        })}
      </div>

      {(!isAtBottom || detached) && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-10 animate-in fade-in-0 slide-in-from-bottom-4 duration-300">
          <button
            type="button"
            onClick={async () => {
              if (detached) {
                // The loaded window is mid-history — rejoin the live
                // tail first, then land at the bottom of it.
                await reattach();
                requestAnimationFrame(scrollToBottom);
              } else {
                scrollToBottom();
              }
            }}
            className="flex items-center gap-1.5 bg-background/80 backdrop-blur-sm border border-border rounded-full px-4 py-2 shadow-lg text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowDown className="h-4 w-4" />
            Jump to Present
          </button>
        </div>
      )}

      {selectionMode && <SelectionActionBar />}

      {previewMode ? (
        // Read-only preview: the composer is replaced by a join prompt
        <div className="mx-4 mb-3 md:mb-6 flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary px-4 py-2.5">
          <span className="truncate text-sm text-muted-foreground">
            Join {previewMeta?.serverName ?? 'this server'} to send messages
          </span>
          <Button size="sm" onClick={() => void joinPreviewedServer()}>
            Join
          </Button>
        </div>
      ) : (
        <div className="group/composer flex flex-col gap-1 px-4 pb-3 md:pb-6 pt-0">
          {replyingTo && (
            <ReplyBar
              message={replyingTo}
              onDismiss={() => setReplyingTo(null)}
            />
          )}
          {uploading && (
            <div className="flex items-center gap-2">
              <div className="text-xs text-muted-foreground mb-1">
                Uploading files ({filesize(uploadingSize)})
              </div>
              <Spinner size="xxs" />
            </div>
          )}
          {files.length > 0 && (
            <div className="flex gap-1 flex-wrap">
              {files.map((file) => (
                <FileCard
                  key={file.id}
                  name={file.originalName}
                  extension={file.extension}
                  size={file.size}
                  onRemove={() => onRemoveFileClick(file.id)}
                />
              ))}
            </div>
          )}
          <UsersTyping channelId={channelId} />
          {slowModeRemaining > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="w-3 h-3" />
              <span>Slow mode: {slowModeRemaining}s remaining</span>
            </div>
          )}
          <FormattingHints />
          {multilineMode && (
            <ComposerResizer
              height={composerHeight}
              onHeightChange={setComposerHeight}
            />
          )}
          <ComposerExpandToggle
            expanded={multilineMode}
            onToggle={() => setMultilineMode((m) => !m)}
          />
          <div
            ref={inputAreaRef}
            // `transition-[border-color,box-shadow]` rather than
            // `transition-all`: the multiline mode binds `height` to a
            // drag handle, and `transition-all` would animate every
            // frame of the drag (200ms behind the cursor) — extremely
            // laggy. Scoping the transition to focus-affordances keeps
            // height instant while the focus glow still fades smoothly.
            className={cn(
              'composer-box flex gap-2 rounded-2xl bg-card border border-border/70 px-3 py-2 transition-[border-color,box-shadow] duration-150 cursor-text overflow-hidden shadow-[0_10px_30px_-24px_rgb(0_0_0/0.8)]',
              // Single-line: vertically center icons relative to the
              // input baseline. Multiline: anchor icons to the TOP so
              // they line up with the first line of typed text and the
              // emoji button rendered inside TiptapInput (which sits
              // at the top of the editor area). Anchoring to the
              // bottom would split the icons across the composer
              // height and look disconnected.
              multilineMode ? 'items-start' : 'items-center'
            )}
            style={multilineMode ? { height: composerHeight } : undefined}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('button')) return;
              const pm = e.currentTarget.querySelector('.ProseMirror');
              if (pm instanceof HTMLElement) pm.focus();
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={onFileInputChange}
            />
            {can(Permission.UPLOAD_FILES) && (
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-primary"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || !canSendMessages}
                aria-label="Attach files"
              >
                <Plus className="h-5 w-5" />
              </Button>
            )}
            <TiptapInput
              toolbar
              value={newMessage}
              placeholder={`Write to #${currentChannel?.name ?? selectedChannel?.name ?? 'channel'}`}
              onChange={setNewMessage}
              onSubmit={onSendMessage}
              onTyping={sendTypingSignal}
              disabled={uploading || !canSendMessages || slowModeRemaining > 0}
              commands={pluginCommands}
              multilineMode={multilineMode}
            />
            {isGiphyEnabled() && (
              <GifPicker onSelect={onGifSelect}>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-primary"
                  disabled={!canSendMessages}
                >
                  <span className="text-[10px] font-bold">GIF</span>
                </Button>
              </GifPicker>
            )}
            <Button
              size="icon"
              variant="ghost"
              className={cn(
                'h-8 w-8 shrink-0 transition-colors',
                isHtmlEmpty(newMessage) || !canSendMessages
                  ? 'text-muted-foreground'
                  : 'text-primary hover:text-primary/80'
              )}
              onClick={onSendMessage}
              disabled={
                uploading ||
                isHtmlEmpty(newMessage) ||
                !canSendMessages ||
                slowModeRemaining > 0
              }
              aria-label="Send message"
            >
              <Send className="h-5 w-5" />
            </Button>
          </div>
        </div>
      )}
    </>
  );
});

export { TextChannel };
