import { GifPicker } from '@/components/gif-picker';
import { TiptapInput } from '@/components/tiptap-input';
import Spinner from '@/components/ui/spinner';
import { useCan, useChannelCan } from '@/features/server/hooks';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { useSelectedChannel } from '@/features/server/channels/hooks';
import { useMessages } from '@/features/server/messages/hooks';
import { useFlatPluginCommands } from '@/features/server/plugins/hooks';
import { playSound } from '@/features/server/sounds/actions';
import { SoundType } from '@/features/server/types';
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
import { ArrowDown, Clock, Plus, Send, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { preprocessMarkdown } from './renderer/markdown-preprocessor';
import { isHtmlEmpty } from '@/helpers/is-html-empty';
import { toast } from 'sonner';
import { Button } from '../../ui/button';
import { FileCard } from './file-card';
import { MessagesGroup } from './messages-group';
import { SystemMessage } from './system-message';
import { TextSkeleton } from './text-skeleton';
import { useScrollController } from './use-scroll-controller';
import { UsersTyping } from './users-typing';

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

    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-t-lg text-sm">
        <span className="text-muted-foreground">Replying to</span>
        <span className="font-semibold">{user?.name ?? 'Unknown'}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
);

const TextChannel = memo(({ channelId }: TChannelProps) => {
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
  const canSendMessages = useMemo(() => {
    return (
      can(Permission.SEND_MESSAGES) &&
      channelCan(ChannelPermission.SEND_MESSAGES)
    );
  }, [can, channelCan]);

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
          if (group[0].type === 'system') {
            return <SystemMessage key={index} message={group[0]} />;
          }
          return <MessagesGroup key={index} group={group} onReply={handleReply} />;
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
