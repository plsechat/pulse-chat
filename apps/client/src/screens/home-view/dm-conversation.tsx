import { FileCard } from '@/components/channel-view/text/file-card';
import { EmojiPicker } from '@/components/emoji-picker';
import { MessageReactions } from '@/components/channel-view/text/message-reactions';
import { GifPicker } from '@/components/gif-picker';
import { TiptapInput } from '@/components/tiptap-input';
import type { TEmojiItem } from '@/components/tiptap-input/types';
import { TypingDots } from '@/components/typing-dots';
import Spinner from '@/components/ui/spinner';
import { UserAvatar } from '@/components/user-avatar';
import {
  deleteDmMessageAction,
  editDmMessage,
  sendDmMessage
} from '@/features/dms/actions';
import { useDmChannels, useDmTypingUsers } from '@/features/dms/hooks';
import { useDmMessages } from '@/features/dms/use-dm-messages';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { requestConfirmation } from '@/features/dialogs/actions';
import { getFileUrl } from '@/helpers/get-file-url';
import { isGiphyEnabled } from '@/helpers/giphy';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useUploadFiles } from '@/hooks/use-upload-files';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TJoinedDmMessage } from '@pulse/shared';
import { imageExtensions, TYPING_MS } from '@pulse/shared';
import { ImageOverride } from '@/components/channel-view/text/overrides/image';
import { LinkPreview } from '@/components/channel-view/text/overrides/link-preview';
import { preprocessMarkdown } from '@/components/channel-view/text/renderer/markdown-preprocessor';
import { serializer } from '@/components/channel-view/text/renderer/serializer';
import type { TFoundMedia } from '@/components/channel-view/text/renderer/types';
import parse from 'html-react-parser';
import { format, formatDistance, subDays } from 'date-fns';
import { filesize } from 'filesize';
import { throttle } from 'lodash-es';
import { Pencil, Phone, PhoneOff, Pin, PinOff, Plus, Reply, Search, Send, Smile, Trash, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { DmCallBanner } from '@/components/dm-call/call-banner';
import { DmVoicePanel } from '@/components/dm-call/dm-voice-panel';
import { useDmCall, useOwnDmCallChannelId } from '@/features/dms/hooks';
import { joinDmVoiceCall, leaveDmVoiceCall } from '@/features/dms/actions';
import { useVoice } from '@/features/server/voice/hooks';
import { DmSearchPopover } from './dm-search-popover';

type TDmConversationProps = {
  dmChannelId: number;
};

const DmConversation = memo(({ dmChannelId }: TDmConversationProps) => {
  const { messages, loading, fetching, hasMore, loadMore, groupedMessages } =
    useDmMessages(dmChannelId);
  const [newMessage, setNewMessage] = useState('');
  const [replyingTo, setReplyingTo] = useState<TJoinedDmMessage | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ownDmCallChannelId = useOwnDmCallChannelId();
  const isInThisCall = ownDmCallChannelId === dmChannelId;

  const inputAreaRef = useRef<HTMLDivElement>(null);

  const { files, removeFile, clearFiles, uploading, uploadingSize, handleUploadFiles } =
    useUploadFiles(false);

  const handleReply = useCallback((message: TJoinedDmMessage) => {
    setReplyingTo(message);
    requestAnimationFrame(() => {
      inputAreaRef.current?.querySelector<HTMLElement>('.ProseMirror')?.focus();
      if (containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    });
  }, []);

  const sendTypingSignal = useMemo(
    () =>
      throttle(async () => {
        const trpc = getTRPCClient();
        try {
          await trpc.dms.signalTyping.mutate({ dmChannelId });
        } catch {
          // ignore
        }
      }, TYPING_MS),
    [dmChannelId]
  );

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages.length]);

  const onScroll = useCallback(() => {
    if (!containerRef.current || fetching || !hasMore) return;

    if (containerRef.current.scrollTop < 100) {
      loadMore();
    }
  }, [fetching, hasMore, loadMore]);

  const onSendMessage = useCallback(async () => {
    if (!newMessage.trim() && !files.length) return;

    sendTypingSignal.cancel();

    try {
      await sendDmMessage(
        dmChannelId,
        preprocessMarkdown(newMessage),
        files.length > 0 ? files.map((f) => f.id) : undefined,
        replyingTo?.id
      );
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to send message'));
      return;
    }

    setNewMessage('');
    setReplyingTo(null);
    clearFiles();
  }, [newMessage, dmChannelId, files, clearFiles, replyingTo, sendTypingSignal]);

  const onGifSelect = useCallback(
    async (gifUrl: string) => {
      try {
        await sendDmMessage(
          dmChannelId,
          `<p><a href="${gifUrl}">${gifUrl}</a></p>`
        );
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to send GIF'));
      }
    },
    [dmChannelId]
  );

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

  const onRemoveFileClick = useCallback(
    (fileId: string) => {
      removeFile(fileId);
    },
    [removeFile]
  );

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <>
      <DmHeader dmChannelId={dmChannelId} />
      {isInThisCall ? (
        <DmVoicePanel dmChannelId={dmChannelId} />
      ) : (
        <DmCallBanner dmChannelId={dmChannelId} />
      )}

      {fetching && (
        <div className="flex items-center justify-center py-2">
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
        className="flex-1 overflow-y-auto overflow-x-hidden p-2"
      >
        <div className="space-y-4">
          {groupedMessages.map((group, index) => (
            <DmMessagesGroup key={index} group={group} onReply={handleReply} />
          ))}
        </div>
      </div>

      <DmUsersTyping dmChannelId={dmChannelId} />

      <div className="flex flex-col gap-2 border-t border-border p-2">
        {replyingTo && (
          <DmReplyBar
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
        <div ref={inputAreaRef} className="flex items-center gap-2 rounded-lg">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onFileInputChange}
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            <Plus className="h-5 w-5" />
          </Button>
          <TiptapInput
            value={newMessage}
            onChange={setNewMessage}
            onSubmit={onSendMessage}
            onTyping={sendTypingSignal}
            disabled={uploading}
          />
          {isGiphyEnabled() && (
            <GifPicker onSelect={onGifSelect}>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-primary"
              >
                <span className="text-[10px] font-bold">GIF</span>
              </Button>
            </GifPicker>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={onSendMessage}
            disabled={uploading || (!newMessage.trim() && !files.length)}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
  );
});

const DmUsersTyping = memo(({ dmChannelId }: { dmChannelId: number }) => {
  const typingUserIds = useDmTypingUsers(dmChannelId);

  if (typingUserIds.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground px-3 py-0.5">
      <TypingDots className="[&>div]:w-0.5 [&>div]:h-0.5" />
      <DmTypingNames userIds={typingUserIds} />
    </div>
  );
});

const DmTypingNames = memo(({ userIds }: { userIds: number[] }) => {
  const user0 = useUserById(userIds[0]);
  const user1 = useUserById(userIds[1] ?? 0);

  if (userIds.length === 1) {
    return <span>{user0?.name ?? 'Someone'} is typing...</span>;
  }

  if (userIds.length === 2) {
    return (
      <span>
        {user0?.name ?? 'Someone'} and {user1?.name ?? 'someone'} are typing...
      </span>
    );
  }

  return (
    <span>
      {user0?.name ?? 'Someone'} and {userIds.length - 1} others are typing...
    </span>
  );
});

const DmHeader = memo(({ dmChannelId }: { dmChannelId: number }) => {
  const channels = useDmChannels();
  const ownUserId = useOwnUserId();
  const call = useDmCall(dmChannelId);
  const ownDmCallChannelId = useOwnDmCallChannelId();
  const isInThisCall = ownDmCallChannelId === dmChannelId;
  const hasActiveCall = call && Object.keys(call.users).length > 0;
  const { init } = useVoice();
  const [showPinned, setShowPinned] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  const channel = useMemo(
    () => channels.find((c) => c.id === dmChannelId),
    [channels, dmChannelId]
  );

  const otherMembers = useMemo(
    () => channel?.members.filter((m) => m.id !== ownUserId) ?? [],
    [channel, ownUserId]
  );

  const displayName = useMemo(() => {
    if (channel?.isGroup && channel.name) return channel.name;
    if (channel?.isGroup) {
      return otherMembers.map((m) => m.name).join(', ') || 'Group DM';
    }
    return otherMembers[0]?.name ?? 'Unknown';
  }, [channel, otherMembers]);

  const handleStartCall = useCallback(async () => {
    try {
      const result = await joinDmVoiceCall(dmChannelId);
      if (result) {
        await init(result.routerRtpCapabilities, dmChannelId);
      }
    } catch {
      toast.error('Failed to start call');
    }
  }, [dmChannelId, init]);

  const handleEndCall = useCallback(async () => {
    try {
      await leaveDmVoiceCall();
    } catch {
      toast.error('Failed to leave call');
    }
  }, []);

  if (otherMembers.length === 0) return null;

  return (
    <div className="relative flex h-12 items-center gap-3 border-b border-border px-4">
      {channel?.isGroup ? (
        <div className="relative h-7 w-7 flex-shrink-0">
          {otherMembers.slice(0, 2).map((m, i) => (
            <UserAvatar
              key={m.id}
              userId={m.id}
              className={cn(
                'h-5 w-5 absolute border-2 border-background',
                i === 0 ? 'top-0 left-0' : 'bottom-0 right-0'
              )}
              showUserPopover={false}
            />
          ))}
        </div>
      ) : (
        <UserAvatar
          userId={otherMembers[0].id}
          className="h-7 w-7"
          showUserPopover
        />
      )}
      <span className="flex-1 font-semibold text-foreground">{displayName}</span>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => { setShowSearch(!showSearch); setShowPinned(false); }}
        title="Search Messages"
      >
        <Search className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => { setShowPinned(!showPinned); setShowSearch(false); }}
        title="Pinned Messages"
      >
        <Pin className="h-4 w-4" />
      </Button>
      {isInThisCall ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive hover:text-destructive"
          onClick={handleEndCall}
          title="Leave Call"
        >
          <PhoneOff className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleStartCall}
          disabled={!!ownDmCallChannelId}
          title={hasActiveCall ? 'Join Call' : 'Start Call'}
        >
          <Phone className="h-4 w-4" />
        </Button>
      )}
      {showPinned && (
        <DmPinnedMessagesPanel
          dmChannelId={dmChannelId}
          onClose={() => setShowPinned(false)}
        />
      )}
      {showSearch && (
        <DmSearchPopover
          dmChannelId={dmChannelId}
          onClose={() => setShowSearch(false)}
        />
      )}
    </div>
  );
});

const DmPinnedMessagesPanel = memo(
  ({
    dmChannelId,
    onClose
  }: {
    dmChannelId: number;
    onClose: () => void;
  }) => {
    const [pinnedMessages, setPinnedMessages] = useState<TJoinedDmMessage[]>(
      []
    );
    const [loading, setLoading] = useState(true);

    const fetchPinned = useCallback(async () => {
      setLoading(true);

      try {
        const trpc = getTRPCClient();
        const messages = await trpc.dms.getPinned.query({ dmChannelId });
        setPinnedMessages(messages);
      } catch {
        toast.error('Failed to load pinned messages');
      } finally {
        setLoading(false);
      }
    }, [dmChannelId]);

    useEffect(() => {
      fetchPinned();
    }, [fetchPinned]);

    const onUnpin = useCallback(async (dmMessageId: number) => {
      const trpc = getTRPCClient();

      try {
        await trpc.dms.unpinMessage.mutate({ dmMessageId });
        setPinnedMessages((prev) => prev.filter((m) => m.id !== dmMessageId));
        toast.success('Message unpinned');
      } catch {
        toast.error('Failed to unpin message');
      }
    }, []);

    return (
      <div className="absolute right-0 top-full mt-1 z-50 w-96 max-h-96 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg">
        <div className="flex items-center justify-between p-3 border-b border-border/30 sticky top-0 bg-popover z-10">
          <div className="flex items-center gap-2">
            <Pin className="w-4 h-4" />
            <span className="text-sm font-medium">Pinned Messages</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={onClose}
          >
            <X className="w-3 h-3" />
          </Button>
        </div>
        {loading ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            Loading...
          </div>
        ) : pinnedMessages.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            No pinned messages.
          </div>
        ) : (
          pinnedMessages.map((message) => (
            <DmPinnedMessageItem
              key={message.id}
              message={message}
              onUnpin={onUnpin}
            />
          ))
        )}
      </div>
    );
  }
);

const DmPinnedMessageItem = memo(
  ({
    message,
    onUnpin
  }: {
    message: TJoinedDmMessage;
    onUnpin: (dmMessageId: number) => void;
  }) => {
    const user = useUserById(message.userId);

    const messageHtml = useMemo(() => {
      return parse(message.content ?? '', {
        replace: (domNode) => serializer(domNode, () => {})
      });
    }, [message.content]);

    return (
      <div className="p-3 border-b border-border/30 last:border-b-0 hover:bg-secondary/30">
        <div className="flex items-center gap-2 mb-1">
          <UserAvatar userId={message.userId} className="h-5 w-5" />
          <span className="text-sm font-medium">
            {user?.name ?? 'Unknown'}
          </span>
          <span className="text-xs text-muted-foreground">
            {format(new Date(message.createdAt), 'MMM d, yyyy h:mm a')}
          </span>
        </div>
        <div className="pl-7 text-sm msg-content">
          {message.content ? messageHtml : null}
        </div>
        <div className="flex justify-end mt-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => onUnpin(message.id)}
          >
            <PinOff className="w-3 h-3 mr-1" />
            Unpin
          </Button>
        </div>
      </div>
    );
  }
);

const DmMessagesGroup = memo(
  ({ group, onReply }: { group: TJoinedDmMessage[]; onReply: (message: TJoinedDmMessage) => void }) => {
    const firstMessage = group[0];
    const user = useUserById(firstMessage.userId);
    const date = new Date(firstMessage.createdAt);
    const ownUserId = useOwnUserId();
    const isOwnUser = firstMessage.userId === ownUserId;

    if (!user) return null;

    return (
      <div className="flex min-w-0 gap-1 pl-2 pt-2 pr-2">
        <UserAvatar userId={user.id} className="h-10 w-10" showUserPopover />
        <div className="flex min-w-0 flex-col w-full">
          <div className="flex gap-2 items-baseline pl-1 select-none">
            <span className={cn(isOwnUser && 'font-bold')}>{user.name}</span>
            <Tooltip content={format(date, 'PPpp')}>
              <span className="text-primary/60 text-xs">
                {formatDistance(subDays(date, 0), new Date(), {
                  addSuffix: true
                })}
              </span>
            </Tooltip>
          </div>
          <div className="flex min-w-0 flex-col">
            {group.map((message) => (
              <DmMessage key={message.id} message={message} onReply={() => onReply(message)} />
            ))}
          </div>
        </div>
      </div>
    );
  }
);

const DmReplyPreview = memo(
  ({ replyTo }: { replyTo: { userId: number; content: string | null } }) => {
    const user = useUserById(replyTo.userId);
    const truncated = replyTo.content
      ? replyTo.content.replace(/<[^>]*>/g, '').slice(0, 100)
      : 'Message deleted';

    return (
      <div className="flex items-center gap-1 text-xs text-muted-foreground mb-0.5 pl-1">
        <Reply className="h-3 w-3 rotate-180" />
        <span className="font-semibold">{user?.name ?? 'Unknown'}</span>
        <span className="truncate max-w-[300px]">{truncated}</span>
      </div>
    );
  }
);

const DmReplyBar = memo(
  ({
    message,
    onDismiss
  }: {
    message: TJoinedDmMessage;
    onDismiss: () => void;
  }) => {
    const user = useUserById(message.userId);

    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/30 border border-border/50 rounded-t-lg text-sm">
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

const DmMessage = memo(({ message, onReply }: { message: TJoinedDmMessage; onReply: () => void }) => {
  const [isEditing, setIsEditing] = useState(false);
  const ownUserId = useOwnUserId();
  const isOwnMessage = message.userId === ownUserId;

  const handleDelete = useCallback(async () => {
    const confirmed = await requestConfirmation({
      title: 'Delete Message',
      message:
        'Are you sure you want to delete this message? This action is irreversible.',
      confirmLabel: 'Delete'
    });

    if (!confirmed) return;

    try {
      await deleteDmMessageAction(message.id);
      toast.success('Message deleted');
    } catch {
      toast.error('Failed to delete message');
    }
  }, [message.id]);

  const handleEditSubmit = useCallback(
    async (newContent: string) => {
      try {
        await editDmMessage(message.id, preprocessMarkdown(newContent));
        setIsEditing(false);
      } catch {
        toast.error('Failed to edit message');
      }
    },
    [message.id]
  );

  const handleToggleReaction = useCallback(
    async (emoji: string) => {
      const trpc = getTRPCClient();

      try {
        await trpc.dms.toggleReaction.mutate({
          dmMessageId: message.id,
          emoji
        });
      } catch {
        toast.error('Failed to toggle reaction');
      }
    },
    [message.id]
  );

  const handlePinToggle = useCallback(async () => {
    const trpc = getTRPCClient();

    try {
      if (message.pinned) {
        await trpc.dms.unpinMessage.mutate({ dmMessageId: message.id });
        toast.success('Message unpinned');
      } else {
        await trpc.dms.pinMessage.mutate({ dmMessageId: message.id });
        toast.success('Message pinned');
      }
    } catch {
      toast.error(
        message.pinned ? 'Failed to unpin message' : 'Failed to pin message'
      );
    }
  }, [message.id, message.pinned]);

  const onEmojiSelect = useCallback(
    async (emoji: TEmojiItem) => {
      const trpc = getTRPCClient();

      try {
        await trpc.dms.toggleReaction.mutate({
          dmMessageId: message.id,
          emoji: emoji.name
        });
      } catch {
        toast.error('Failed to add reaction');
      }
    },
    [message.id]
  );

  return (
    <div className="min-w-0 flex-1 ml-1 relative hover:bg-secondary/50 rounded-md px-1 py-0.5 group">
      {message.replyTo && <DmReplyPreview replyTo={message.replyTo} />}
      {!isEditing ? (
        <>
          <DmMessageContent message={message} />
          {message.reactions && message.reactions.length > 0 && (
            <MessageReactions
              messageId={message.id}
              reactions={message.reactions}
              onToggle={handleToggleReaction}
            />
          )}
          <div className="gap-2 absolute right-0 -top-6 z-10 hidden group-hover:flex [&:has([data-state=open])]:flex items-center space-x-1 rounded-lg shadow-lg border border-border p-1 transition-all h-8">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onReply}
              title="Reply"
            >
              <Reply className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handlePinToggle}
              title={message.pinned ? 'Unpin Message' : 'Pin Message'}
            >
              {message.pinned ? (
                <PinOff className="h-3 w-3" />
              ) : (
                <Pin className="h-3 w-3" />
              )}
            </Button>
            <EmojiPicker onEmojiSelect={onEmojiSelect}>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                title="Add Reaction"
              >
                <Smile className="h-3 w-3" />
              </Button>
            </EmojiPicker>
            {isOwnMessage && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => setIsEditing(true)}
                  title="Edit Message"
                >
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={handleDelete}
                  title="Delete Message"
                >
                  <Trash className="h-3 w-3" />
                </Button>
              </>
            )}
          </div>
        </>
      ) : (
        <DmMessageEdit
          message={message}
          onSubmit={handleEditSubmit}
          onCancel={() => setIsEditing(false)}
        />
      )}
    </div>
  );
});

const DmMessageContent = memo(
  ({ message }: { message: TJoinedDmMessage }) => {
    const { foundMedia, messageHtml } = useMemo(() => {
      const foundMedia: TFoundMedia[] = [];
      const messageHtml = parse(message.content ?? '', {
        replace: (domNode) =>
          serializer(domNode, (found) => foundMedia.push(found))
      });
      return { messageHtml, foundMedia };
    }, [message.content]);

    const allMedia = useMemo(() => {
      const mediaFromFiles: TFoundMedia[] = message.files
        .filter((file) => imageExtensions.includes(file.extension))
        .map((file) => ({
          type: 'image' as const,
          url: getFileUrl(file)
        }));
      return [...foundMedia, ...mediaFromFiles];
    }, [foundMedia, message.files]);

    const otherFiles = useMemo(
      () =>
        message.files.filter((f) => !imageExtensions.includes(f.extension)),
      [message.files]
    );

    return (
      <div className="flex flex-col gap-1">
        {message.content && (
          <div className="max-w-full break-words msg-content">
            {messageHtml}
          </div>
        )}

        {message.updatedAt && (
          <span className="text-[10px] text-muted-foreground">(edited)</span>
        )}

        {allMedia.map((media, index) =>
          media.type === 'image' ? (
            <ImageOverride src={media.url} key={`media-image-${index}`} />
          ) : null
        )}

        {message.metadata && message.metadata.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {message.metadata
              .filter((meta) => meta.mediaType !== 'webhook')
              .map((meta, index) => (
                <LinkPreview key={`preview-${index}`} metadata={meta} />
              ))}
          </div>
        )}

        {otherFiles.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {otherFiles.map((file) => (
              <a
                key={file.id}
                href={getFileUrl(file)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/50"
              >
                <span className="truncate">{file.originalName}</span>
                <span className="text-xs text-muted-foreground">
                  ({filesize(file.size)})
                </span>
              </a>
            ))}
          </div>
        )}
      </div>
    );
  }
);

const DmMessageEdit = memo(
  ({
    message,
    onSubmit,
    onCancel
  }: {
    message: TJoinedDmMessage;
    onSubmit: (content: string) => void;
    onCancel: () => void;
  }) => {
    const [editContent, setEditContent] = useState(message.content ?? '');

    const handleSubmit = useCallback(() => {
      if (!editContent.trim()) return;
      onSubmit(editContent);
    }, [editContent, onSubmit]);

    return (
      <div className="flex flex-col gap-1">
        <TiptapInput
          value={editContent}
          onChange={setEditContent}
          onSubmit={handleSubmit}
          onCancel={onCancel}
        />
        <div className="flex gap-2 text-xs text-muted-foreground">
          <span>
            Press <kbd className="rounded bg-muted px-1">Enter</kbd> to save
          </span>
          <span>
            Press <kbd className="rounded bg-muted px-1">Escape</kbd> to cancel
          </span>
        </div>
      </div>
    );
  }
);

export { DmConversation };
