import { GifPicker } from '@/components/gif-picker';
import { TiptapInput } from '@/components/tiptap-input';
import Spinner from '@/components/ui/spinner';
import { useCan, useChannelCan } from '@/features/server/hooks';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { useChannelById, useLastReadMessageId, useSelectedChannel } from '@/features/server/channels/hooks';
import { useMessages } from '@/features/server/messages/hooks';
import { useFlatPluginCommands } from '@/features/server/plugins/hooks';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
import { getDisplayName } from '@/helpers/get-display-name';
import { isGiphyEnabled } from '@/helpers/giphy';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useUploadFiles } from '@/hooks/use-upload-files';
import { encryptChannelMessage, ensureChannelSenderKey } from '@/lib/e2ee';
import { getTRPCClient } from '@/lib/trpc';
import {
  ChannelPermission,
  Permission,
  TYPING_MS,
  type TJoinedMessage
} from '@pulse/shared';
import { filesize } from 'filesize';
import { throttle } from 'lodash-es';
import { useScrollToMessage } from '@/hooks/use-scroll-to-message';
import { DateDivider } from '@/components/chat-primitives/date-divider';
import { NewMessagesDivider } from '@/components/chat-primitives/new-messages-divider';
import { ArrowDown, Clock, Plus, Reply, Send, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tiptapHtmlToTokens } from '@/lib/converters/tiptap-to-tokens';
import { ReplyContentPreview } from './reply-content-preview';
import { FormattingHints } from './formatting-hints';
import {
  ComposerExpandToggle,
  ComposerResizer,
  MIN_COMPOSER_HEIGHT
} from './composer-expand';
import { isHtmlEmpty } from '@/helpers/is-html-empty';
import { toast } from 'sonner';
import { Button } from '../../ui/button';
import { cn } from '@/lib/utils';
import { FileCard } from './file-card';
import { MessagesGroup } from './messages-group';
import { SystemMessage } from './system-message';
import { TextSkeleton } from './text-skeleton';
import { SelectionActionBar } from './selection-action-bar';
import { SelectionProvider, useSelection } from './selection-context';
import { useScrollController } from './use-scroll-controller';
import { UsersTyping } from './users-typing';

// Date and new-messages dividers live in chat-primitives so the DM
// view paints them identically — see imports above.

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
      <div className="flex items-center gap-2 rounded-t-lg text-sm border-l-3 border-l-primary bg-primary/5 overflow-hidden">
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
  const { messages, hasMore, loadMore, loading, fetching, groupedMessages } =
    useMessages(channelId);
  const [newMessage, setNewMessage] = useState('');
  const [replyingTo, setReplyingTo] = useState<TJoinedMessage | null>(null);
  const [slowModeRemaining, setSlowModeRemaining] = useState(0);
  const slowModeTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const selectedChannel = useSelectedChannel();
  const currentChannel = useChannelById(channelId);
  const slowMode = selectedChannel?.slowMode ?? 0;
  const isE2ee = selectedChannel?.e2ee ?? false;
  const ownUserId = useOwnUserId();
  const lastReadMessageId = useLastReadMessageId(channelId);
  const allPluginCommands = useFlatPluginCommands();
  const { containerRef, onScroll, scrollToBottom, isAtBottom } = useScrollController({
    channelId,
    messages,
    fetching,
    hasMore,
    loadMore
  });
  const can = useCan();
  const channelCan = useChannelCan(channelId);
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const [multilineMode, setMultilineMode] = useState(false);
  const [composerHeight, setComposerHeight] = useState(MIN_COMPOSER_HEIGHT * 1.4);

  const focusEditor = useCallback(() => {
    requestAnimationFrame(() => {
      inputAreaRef.current?.querySelector<HTMLElement>('.ProseMirror')?.focus();
    });
  }, []);

  const { files, removeFile, clearFiles, uploading, uploadingSize, handleUploadFiles, fileKeyMapRef } =
    useUploadFiles(!canSendMessages, isE2ee, focusEditor);

  const handleReply = useCallback((message: TJoinedMessage) => {
    setReplyingTo(message);
    requestAnimationFrame(() => {
      inputAreaRef.current?.querySelector<HTMLElement>('.ProseMirror')?.focus();
      if (containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    });
  }, [containerRef]);

  const sendTypingSignal = useMemo(
    () =>
      throttle(async () => {
        const trpc = getTRPCClient();
        if (!trpc) return;

        try {
          await trpc.messages.signalTyping.mutate({ channelId });
        } catch {
          // ignore
        }
      }, TYPING_MS),
    [channelId]
  );

  const onSendMessage = useCallback(async () => {
    if ((isHtmlEmpty(newMessage) && !files.length) || !canSendMessages) return;

    sendTypingSignal.cancel();

    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      const content = tiptapHtmlToTokens(newMessage);

      if (isE2ee && ownUserId) {
        // Ensure we have a sender key and distribute to members
        await ensureChannelSenderKey(channelId, ownUserId);

        // Build fileKeys from encrypted upload key material. Includes
        // the real originalName + extension so the recipient can render
        // them — the server stores only placeholders.
        const fileKeys = files.length > 0
          ? files.map((f) => {
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
          }).filter((k): k is NonNullable<typeof k> => k !== null)
          : undefined;

        const encryptedContent = await encryptChannelMessage(
          channelId,
          ownUserId,
          { content, fileKeys }
        );

        await trpc.messages.send.mutate({
          content: encryptedContent,
          e2ee: true,
          channelId,
          files: files.map((f) => f.id),
          replyToId: replyingTo?.id
        });
      } else {
        await trpc.messages.send.mutate({
          content,
          channelId,
          files: files.map((f) => f.id),
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
    ownUserId
  ]);

  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(e.target.files ?? []);
      if (selectedFiles.length > 0) {
        handleUploadFiles(selectedFiles);
      }
      e.target.value = '';
    },
    [handleUploadFiles]
  );

  const onGifSelect = useCallback(
    async (gifUrl: string) => {
      const trpc = getTRPCClient();
      if (!trpc) return;
      const content = gifUrl;
      // Thread reply context — picking a GIF while replying should
      // attach to the parent message, not start a new top-level msg.
      const replyToId = replyingTo?.id;

      try {
        if (isE2ee && ownUserId) {
          await ensureChannelSenderKey(channelId, ownUserId);

          const encryptedContent = await encryptChannelMessage(
            channelId,
            ownUserId,
            { content }
          );
          await trpc.messages.send.mutate({
            content: encryptedContent,
            e2ee: true,
            channelId,
            replyToId
          });
        } else {
          await trpc.messages.send.mutate({ content, channelId, replyToId });
        }
        playSound(SoundType.MESSAGE_SENT);
        setReplyingTo(null);
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to send GIF'));
      }
    },
    [channelId, isE2ee, ownUserId, replyingTo]
  );

  const onRemoveFileClick = useCallback(
    async (fileId: string) => {
      removeFile(fileId);

      const trpc = getTRPCClient();
      if (!trpc) return;

      try {
        trpc.files.deleteTemporary.mutate({ fileId });
      } catch {
        // ignore error
      }
    },
    [removeFile]
  );

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
        className="flex-1 overflow-y-auto overflow-x-hidden pb-4 animate-in fade-in duration-500"
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
          const prevDay = index > 0
            ? new Date(groupedMessages[index - 1][0].createdAt).toDateString()
            : null;
          const showDateDivider = prevDay !== null && currentDay !== prevDay;

          return (
            <div key={index}>
              {showDateDivider && <DateDivider timestamp={group[0].createdAt} />}
              {showDivider && <NewMessagesDivider />}
              {group[0].type === 'system' ? (
                <SystemMessage message={group[0]} />
              ) : (
                <MessagesGroup group={group} onReply={handleReply} />
              )}
            </div>
          );
        })}
      </div>

      {!isAtBottom && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-10 animate-in fade-in-0 slide-in-from-bottom-4 duration-300">
          <button
            type="button"
            onClick={scrollToBottom}
            className="flex items-center gap-1.5 bg-background/80 backdrop-blur-sm border border-border rounded-full px-4 py-2 shadow-lg text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowDown className="h-4 w-4" />
            Jump to Present
          </button>
        </div>
      )}

      {selectionMode && <SelectionActionBar />}

      <div className="flex flex-col gap-1 px-4 pb-3 md:pb-6 pt-0">
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
            'flex gap-2 rounded-lg bg-muted border border-border/50 shadow-sm px-4 py-2 transition-[border-color,box-shadow] duration-150 cursor-text overflow-hidden focus-within:border-primary/50 focus-within:shadow-[0_0_0_2px_oklch(from_var(--primary)_l_c_h/0.15)]',
            // Single-line: vertically center icons relative to the
            // input baseline. Multiline: anchor icons to the bottom
            // so they stay aligned with the send-action edge as the
            // input grows upward via the resize handle.
            multilineMode ? 'items-end' : 'items-center'
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
            >
              <Plus className="h-5 w-5" />
            </Button>
          )}
          <TiptapInput
            value={newMessage}
            placeholder={`Message #${currentChannel?.name ?? selectedChannel?.name ?? 'channel'}`}
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
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-primary"
            onClick={onSendMessage}
            disabled={uploading || isHtmlEmpty(newMessage) || !canSendMessages || slowModeRemaining > 0}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
  );
});

export { TextChannel };
