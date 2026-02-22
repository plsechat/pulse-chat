import { GifPicker } from '@/components/gif-picker';
import { TiptapInput } from '@/components/tiptap-input';
import Spinner from '@/components/ui/spinner';
import { useCan, useChannelCan } from '@/features/server/hooks';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { useLastReadMessageId, useSelectedChannel } from '@/features/server/channels/hooks';
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
import { setHighlightedMessageId } from '@/features/server/channels/actions';
import { ArrowDown, Clock, Plus, Reply, Send, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { preprocessMarkdown } from './renderer/markdown-preprocessor';
import { isHtmlEmpty } from '@/helpers/is-html-empty';
import { toast } from 'sonner';
import { Button } from '../../ui/button';
import { FileCard } from './file-card';
import { MessagesGroup } from './messages-group';
import { SystemMessage } from './system-message';
import { TextSkeleton } from './text-skeleton';
import { SelectionActionBar } from './selection-action-bar';
import { SelectionProvider, useSelection } from './selection-context';
import { useScrollController } from './use-scroll-controller';
import { UsersTyping } from './users-typing';

const NewMessagesDivider = memo(() => (
  <div className="flex items-center gap-2 px-4 py-1" id="new-messages-divider">
    <div className="flex-1 h-px bg-destructive/50" />
    <span className="text-xs font-semibold text-destructive/80 shrink-0 uppercase">
      New messages
    </span>
    <div className="flex-1 h-px bg-destructive/50" />
  </div>
));

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
    const contentPreview = useMemo(() => {
      if (!message.content) return 'Message deleted';
      return message.content.replace(/<[^>]*>/g, '').slice(0, 80) || 'Attachment';
    }, [message.content]);

    const scrollToMessage = useCallback(() => {
      setHighlightedMessageId(message.id);
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${message.id}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      setTimeout(() => setHighlightedMessageId(undefined), 2500);
    }, [message.id]);

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
          <span className="truncate text-muted-foreground">{contentPreview}</span>
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

  const { files, removeFile, clearFiles, uploading, uploadingSize, handleUploadFiles } =
    useUploadFiles(!canSendMessages);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);

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

    try {
      const content = preprocessMarkdown(newMessage);

      if (isE2ee && ownUserId) {
        // Ensure we have a sender key and distribute to members
        await ensureChannelSenderKey(channelId, ownUserId);

        const encryptedContent = await encryptChannelMessage(
          channelId,
          ownUserId,
          { content }
        );

        await trpc.messages.send.mutate({
          encryptedContent,
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
      const content = `<p><a href="${gifUrl}">${gifUrl}</a></p>`;

      try {
        if (isE2ee && ownUserId) {
          await ensureChannelSenderKey(channelId, ownUserId);

          const encryptedContent = await encryptChannelMessage(
            channelId,
            ownUserId,
            { content }
          );
          await trpc.messages.send.mutate({
            encryptedContent,
            e2ee: true,
            channelId
          });
        } else {
          await trpc.messages.send.mutate({ content, channelId });
        }
        playSound(SoundType.MESSAGE_SENT);
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to send GIF'));
      }
    },
    [channelId, isE2ee, ownUserId]
  );

  const onRemoveFileClick = useCallback(
    async (fileId: string) => {
      removeFile(fileId);

      const trpc = getTRPCClient();

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

          return (
            <div key={index}>
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
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-10">
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
        <div
          ref={inputAreaRef}
          className="flex items-center gap-2 rounded-lg bg-muted px-4 py-2 transition-all duration-200 cursor-text"
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
            placeholder={`Message #${selectedChannel?.name ?? 'channel'}`}
            onChange={setNewMessage}
            onSubmit={onSendMessage}
            onTyping={sendTypingSignal}
            disabled={uploading || !canSendMessages || slowModeRemaining > 0}
            commands={pluginCommands}
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
