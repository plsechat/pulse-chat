import { FileCard } from '@/components/channel-view/text/file-card';
import { FormattingHints } from '@/components/channel-view/text/formatting-hints';
import {
  ComposerExpandToggle,
  ComposerResizer,
  MIN_COMPOSER_HEIGHT
} from '@/components/channel-view/text/composer-expand';
import { DateDivider } from '@/components/chat-primitives/date-divider';
import { MessageActions } from '@/components/chat-primitives/message-actions';
import { PopoverPanelShell } from '@/components/chat-primitives/popover-panel-shell';
import { ReplyPreview } from '@/components/chat-primitives/reply-preview';
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
import { isGiphyEnabled } from '@/helpers/giphy';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useDecryptedFileUrl } from '@/hooks/use-decrypted-file-url';
import { useUploadFiles } from '@/hooks/use-upload-files';
import { getTRPCClient } from '@/lib/trpc';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import type { TFile, TJoinedDmMessage } from '@pulse/shared';
import {
  audioExtensions,
  imageExtensions,
  TYPING_MS,
  videoExtensions
} from '@pulse/shared';
import { AudioPlayer } from '@/components/channel-view/text/overrides/audio-player';
import { ImageOverride } from '@/components/channel-view/text/overrides/image';
import { ImageContextMenu } from '@/components/channel-view/text/image-context-menu';
import { LinkPreview } from '@/components/channel-view/text/overrides/link-preview';
import { VideoPlayer } from '@/components/channel-view/text/overrides/video-player';
import { isHtmlEmpty } from '@/helpers/is-html-empty';
import { ReplyContentPreview } from '@/components/channel-view/text/reply-content-preview';
import { stripToPlainText } from '@/helpers/strip-to-plain-text';
import { isTokenContentEmpty } from '@/helpers/strip-to-plain-text';
import { tiptapHtmlToTokens } from '@/lib/converters/tiptap-to-tokens';
import {
  isLegacyHtml,
  TokenContentRenderer
} from '@/lib/converters/token-content-renderer';
import { tokensToTiptapHtml } from '@/lib/converters/tokens-to-tiptap';
import { useTokenToTiptapContext } from '@/lib/converters/use-token-context';
import { serializer } from '@/components/channel-view/text/renderer/serializer';
import type { TFoundMedia } from '@/components/channel-view/text/renderer/types';
import parse from 'html-react-parser';
import { fullDateTime, longDateTime } from '@/helpers/time-format';
import { format, formatDistance, subDays } from 'date-fns';
import { filesize } from 'filesize';
import { throttle } from 'lodash-es';
import { Copy, Loader2, Lock, PanelRight, PanelRightClose, Pencil, Phone, PhoneOff, Pin, PinOff, Plus, Reply, Search, Send, Smile, Trash, X } from 'lucide-react';
import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { DmCallBanner } from '@/components/dm-call/call-banner';
import { DmVoicePanel } from '@/components/dm-call/dm-voice-panel';
import { DmPinBanner } from './dm-pin-banner';
import { useDmCall, useOwnDmCallChannelId } from '@/features/dms/hooks';
import { joinDmVoiceCall, leaveDmVoiceCall } from '@/features/dms/actions';
import { useVoice } from '@/features/server/voice/hooks';
import { SystemMessage } from '@/components/channel-view/text/system-message';
import { DmSearchPopover } from './dm-search-popover';

type TDmConversationProps = {
  dmChannelId: number;
  isProfilePanelOpen?: boolean;
  profilePanelAvailable?: boolean;
  onToggleProfilePanel?: () => void;
};

const DmConversation = memo(
  ({
    dmChannelId,
    isProfilePanelOpen,
    profilePanelAvailable,
    onToggleProfilePanel
  }: TDmConversationProps) => {
  const { messages, loading, fetching, hasMore, loadMore, groupedMessages } =
    useDmMessages(dmChannelId);
  const [newMessage, setNewMessage] = useState('');
  const [replyingTo, setReplyingTo] = useState<TJoinedDmMessage | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ownDmCallChannelId = useOwnDmCallChannelId();
  const isInThisCall = ownDmCallChannelId === dmChannelId;
  const dmChannels = useDmChannels();
  const ownUserId = useOwnUserId();
  const dmMembers = useMemo(() => {
    const channel = dmChannels.find((c) => c.id === dmChannelId);
    return channel?.members.map((m) => ({ id: m.id, name: m.name, avatar: m.avatar, _identity: m._identity })) ?? [];
  }, [dmChannels, dmChannelId]);

  const isE2ee = useMemo(() => {
    const channel = dmChannels.find((c) => c.id === dmChannelId);
    return channel?.e2ee ?? false;
  }, [dmChannels, dmChannelId]);

  const dmPlaceholder = useMemo(() => {
    const channel = dmChannels.find((c) => c.id === dmChannelId);
    if (!channel) return 'Message...';
    const otherMembers = channel.members.filter((m) => m.id !== ownUserId);
    if (channel.isGroup && channel.name) return `Message ${channel.name}`;
    if (channel.isGroup) {
      const names = otherMembers.map((m) => m.name).join(', ') || 'Group DM';
      return `Message ${names}`;
    }
    return `Message @${otherMembers[0]?.name ?? 'Unknown'}`;
  }, [dmChannels, dmChannelId, ownUserId]);

  const inputAreaRef = useRef<HTMLDivElement>(null);
  const [multilineMode, setMultilineMode] = useState(false);
  const [composerHeight, setComposerHeight] = useState(MIN_COMPOSER_HEIGHT * 1.4);

  const focusEditor = useCallback(() => {
    requestAnimationFrame(() => {
      inputAreaRef.current?.querySelector<HTMLElement>('.ProseMirror')?.focus();
    });
  }, []);

  const { files, removeFile, clearFiles, uploading, uploadingSize, handleUploadFiles, fileKeyMapRef } =
    useUploadFiles(false, isE2ee, focusEditor);

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
        if (!trpc) return;
        try {
          await trpc.dms.signalTyping.mutate({ dmChannelId });
        } catch {
          // ignore
        }
      }, TYPING_MS),
    [dmChannelId]
  );

  const hasInitialScroll = useRef(false);
  const isNearBottom = useRef(true);

  // Restore saved scroll position or scroll to bottom on initial load
  useEffect(() => {
    if (!containerRef.current || loading || messages.length === 0) return;
    if (hasInitialScroll.current) return;

    const positions =
      getLocalStorageItemAsJSON<Record<number, number>>(
        LocalStorageKey.DM_SCROLL_POSITIONS
      ) ?? {};
    const saved = positions[dmChannelId];

    const perform = () => {
      const c = containerRef.current;
      if (!c) return;
      if (saved !== undefined) {
        c.scrollTop = saved;
        const atBottom =
          c.scrollTop + c.clientHeight >= c.scrollHeight * 0.9;
        isNearBottom.current = atBottom;
      } else {
        c.scrollTop = c.scrollHeight;
        isNearBottom.current = true;
      }
      hasInitialScroll.current = true;
    };

    perform();
    requestAnimationFrame(perform);
    setTimeout(perform, 50);
    setTimeout(perform, 200);
  }, [loading, messages.length, dmChannelId]);

  // Auto-scroll on new messages only when user is near bottom
  useEffect(() => {
    if (!containerRef.current || !hasInitialScroll.current || messages.length === 0) return;
    if (isNearBottom.current) {
      setTimeout(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
      }, 10);
    }
  }, [messages.length]);

  // Save scroll position on unmount
  useEffect(() => {
    const c = containerRef.current;
    return () => {
      if (c) {
        const positions =
          getLocalStorageItemAsJSON<Record<number, number>>(
            LocalStorageKey.DM_SCROLL_POSITIONS
          ) ?? {};
        positions[dmChannelId] = c.scrollTop;
        setLocalStorageItemAsJSON(LocalStorageKey.DM_SCROLL_POSITIONS, positions);
      }
    };
  }, [dmChannelId]);

  const onScroll = useCallback(() => {
    if (!containerRef.current) return;

    // Track whether user is near bottom
    const c = containerRef.current;
    isNearBottom.current =
      c.scrollTop + c.clientHeight >= c.scrollHeight * 0.9;

    if (!fetching && hasMore && c.scrollTop < 100) {
      loadMore();
    }
  }, [fetching, hasMore, loadMore]);

  const onSendMessage = useCallback(async () => {
    if (isHtmlEmpty(newMessage) && !files.length) return;

    sendTypingSignal.cancel();

    try {
      // Build fileKeys from encrypted upload key material
      const fileKeys = isE2ee && files.length > 0
        ? files.map((f) => {
          const keyInfo = fileKeyMapRef.current.get(f.id);
          return keyInfo
            ? { fileId: f.id, key: keyInfo.key, nonce: keyInfo.nonce, mimeType: keyInfo.mimeType }
            : null;
        }).filter((k): k is NonNullable<typeof k> => k !== null)
        : undefined;

      await sendDmMessage(
        dmChannelId,
        tiptapHtmlToTokens(newMessage),
        files.length > 0 ? files.map((f) => f.id) : undefined,
        replyingTo?.id,
        fileKeys
      );
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to send message'));
      return;
    }

    setNewMessage('');
    setReplyingTo(null);
    clearFiles();
  }, [newMessage, dmChannelId, files, clearFiles, replyingTo, sendTypingSignal, isE2ee, fileKeyMapRef]);

  const onGifSelect = useCallback(
    async (gifUrl: string) => {
      try {
        await sendDmMessage(
          dmChannelId,
          gifUrl
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
      <DmHeader
        dmChannelId={dmChannelId}
        isProfilePanelOpen={isProfilePanelOpen}
        profilePanelAvailable={profilePanelAvailable}
        onToggleProfilePanel={onToggleProfilePanel}
      />
      <DmPinBanner dmChannelId={dmChannelId} />
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
          {groupedMessages.map((group, index) => {
            // Day-divider logic mirrors the channel view exactly —
            // see channel-view/text/index.tsx for the same shape.
            const currentDay = new Date(group[0].createdAt).toDateString();
            const prevDay =
              index > 0
                ? new Date(groupedMessages[index - 1][0].createdAt).toDateString()
                : null;
            const showDateDivider = prevDay !== null && currentDay !== prevDay;

            return (
              <div key={index}>
                {showDateDivider && (
                  <DateDivider timestamp={group[0].createdAt} />
                )}
                {group[0].type === 'system' ? (
                  <SystemMessage message={group[0]} />
                ) : (
                  <DmMessagesGroup group={group} onReply={handleReply} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <DmUsersTyping dmChannelId={dmChannelId} />

      {/* Outer wrapper now matches the channel composer exactly:
          `flex flex-col gap-1 px-4 pb-3 md:pb-6 pt-0` — same padding
          shape, no border-top (the messages area's spacing handles
          visual separation). Without this, the DM input box's
          horizontal position differed from the channel's by ~8px,
          making it look misaligned with the user-control box below
          the sidebar. */}
      <div className="flex flex-col gap-1 px-4 pb-3 md:pb-6 pt-0">
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
          // Mirrors the channel composer wrapper exactly (muted bg,
          // hairline border, scoped transition for focus glow, instant
          // height during drag-resize). Without this, the DM input
          // rendered as a bare inline row that didn't match the rest
          // of the chat surface.
          className="flex items-start gap-2 rounded-lg bg-muted border border-border/50 shadow-sm px-4 py-2 transition-[border-color,box-shadow] duration-150 cursor-text overflow-hidden focus-within:border-primary/50 focus-within:shadow-[0_0_0_2px_oklch(from_var(--primary)_l_c_h/0.15)]"
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
            placeholder={dmPlaceholder}
            onChange={setNewMessage}
            onSubmit={onSendMessage}
            onTyping={sendTypingSignal}
            disabled={uploading}
            dmMembers={dmMembers}
            multilineMode={multilineMode}
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
            disabled={uploading || (isHtmlEmpty(newMessage) && !files.length)}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </>
  );
  }
);

const DmUsersTyping = memo(({ dmChannelId }: { dmChannelId: number }) => {
  const typingUserIds = useDmTypingUsers(dmChannelId);

  if (typingUserIds.length === 0) {
    return <div className="h-6" />;
  }

  return (
    <div className="flex h-6 items-center gap-2 px-4 text-xs text-muted-foreground">
      <TypingDots />
      <DmTypingNames userIds={typingUserIds} />
    </div>
  );
});

const DmTypingNames = memo(({ userIds }: { userIds: number[] }) => {
  const user0 = useUserById(userIds[0]);
  const user1 = useUserById(userIds[1] ?? 0);

  if (userIds.length === 1) {
    return (
      <span>
        <strong>{user0?.name ?? 'Someone'}</strong> is typing...
      </span>
    );
  }

  if (userIds.length === 2) {
    return (
      <span>
        <strong>{user0?.name ?? 'Someone'}</strong> and{' '}
        <strong>{user1?.name ?? 'someone'}</strong> are typing...
      </span>
    );
  }

  return (
    <span>
      <strong>{user0?.name ?? 'Someone'}</strong> and {userIds.length - 1}{' '}
      others are typing...
    </span>
  );
});

const DmHeader = memo(({
  dmChannelId,
  isProfilePanelOpen,
  profilePanelAvailable,
  onToggleProfilePanel
}: {
  dmChannelId: number;
  isProfilePanelOpen?: boolean;
  profilePanelAvailable?: boolean;
  onToggleProfilePanel?: () => void;
}) => {
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
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to start call'));
    }
  }, [dmChannelId, init]);

  const handleEndCall = useCallback(async () => {
    try {
      await leaveDmVoiceCall();
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to leave call'));
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
      <span className="flex-1 font-semibold text-foreground flex items-center gap-1.5">
        {displayName}
        {channel?.e2ee && (
          <Tooltip content="End-to-end encrypted">
            <Lock className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
          </Tooltip>
        )}
      </span>
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
      {onToggleProfilePanel && (
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-8 w-8',
            !profilePanelAvailable && 'opacity-50 cursor-not-allowed'
          )}
          onClick={profilePanelAvailable ? onToggleProfilePanel : undefined}
          disabled={!profilePanelAvailable}
          title={
            !profilePanelAvailable
              ? 'Profile panel (unavailable — make the window wider)'
              : isProfilePanelOpen
                ? 'Close Profile Panel'
                : 'Open Profile Panel'
          }
        >
          {isProfilePanelOpen ? (
            <PanelRightClose className="h-4 w-4" />
          ) : (
            <PanelRight className="h-4 w-4" />
          )}
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
        if (!trpc) return;
        const messages = await trpc.dms.getPinned.query({ dmChannelId });
        setPinnedMessages(messages);
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to load pinned messages'));
      } finally {
        setLoading(false);
      }
    }, [dmChannelId]);

    useEffect(() => {
      fetchPinned();
    }, [fetchPinned]);

    // Refetch when DM message updates arrive (pin/unpin)
    useEffect(() => {
      const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (detail?.dmChannelId === dmChannelId) {
          fetchPinned();
        }
      };
      window.addEventListener('dm-pinned-messages-changed', handler);
      return () => window.removeEventListener('dm-pinned-messages-changed', handler);
    }, [dmChannelId, fetchPinned]);

    const onUnpin = useCallback(async (dmMessageId: number) => {
      const trpc = getTRPCClient();
      if (!trpc) return;

      try {
        await trpc.dms.unpinMessage.mutate({ dmMessageId });
        setPinnedMessages((prev) => prev.filter((m) => m.id !== dmMessageId));
        toast.success('Message unpinned');
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to unpin message'));
      }
    }, []);

    return (
      <PopoverPanelShell
        icon={Pin}
        title="Pinned Messages"
        onClose={onClose}
        loading={loading}
        empty={!loading && pinnedMessages.length === 0}
        emptyMessage="No pinned messages."
      >
        {pinnedMessages.map((message) => (
          <DmPinnedMessageItem
            key={message.id}
            message={message}
            onUnpin={onUnpin}
          />
        ))}
      </PopoverPanelShell>
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

    const content = message.content ?? '';
    const legacy = isLegacyHtml(content);

    const messageHtml = useMemo(() => {
      if (!legacy || !content) return null;
      return parse(content, {
        replace: (domNode) => serializer(domNode, () => {})
      });
    }, [content, legacy]);

    return (
      <div className="p-3 border-b border-border/30 last:border-b-0 hover:bg-secondary/30">
        <div className="flex items-center gap-2 mb-1">
          <UserAvatar userId={message.userId} className="h-5 w-5" />
          <span className="text-sm font-medium">
            {user?.name ?? 'Unknown'}
          </span>
          <span className="text-xs text-muted-foreground">
            {format(new Date(message.createdAt), longDateTime())}
          </span>
        </div>
        <div className="pl-7 text-sm msg-content">
          {content ? (legacy ? messageHtml : (
            <TokenContentRenderer content={content} fileCount={0} onFoundMedia={() => {}} />
          )) : null}
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
            <Tooltip content={format(date, fullDateTime())}>
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

// Reply jump for DMs uses local DOM ids since there's no centralized
// scroll controller. Same shape the old DmReplyPreview used; just
// hoisted out so it can pair with the shared <ReplyPreview>.
const scrollToDmMessage = (messageId: number) => {
  const el = document.getElementById(`dm-msg-${messageId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('animate-msg-highlight');
  setTimeout(() => el.classList.remove('animate-msg-highlight'), 2500);
};

const DmReplyBar = memo(
  ({
    message,
    onDismiss
  }: {
    message: TJoinedDmMessage;
    onDismiss: () => void;
  }) => {
    const user = useUserById(message.userId);

    const scrollToMessage = useCallback(() => {
      const el = document.getElementById(`dm-msg-${message.id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('animate-msg-highlight');
        setTimeout(() => el.classList.remove('animate-msg-highlight'), 2500);
      }
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
            {user?.name ?? 'Unknown'}
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
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to delete message'));
    }
  }, [message.id]);

  const handleEditSubmit = useCallback(
    async (newContent: string) => {
      try {
        const content = tiptapHtmlToTokens(newContent);

        if (isTokenContentEmpty(content)) {
          await deleteDmMessageAction(message.id);
          toast.success('Message deleted');
        } else {
          await editDmMessage(message.id, content);
        }
        setIsEditing(false);
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to edit message'));
      }
    },
    [message.id]
  );

  const handleToggleReaction = useCallback(
    async (emoji: string) => {
      const trpc = getTRPCClient();
      if (!trpc) return;

      try {
        await trpc.dms.toggleReaction.mutate({
          dmMessageId: message.id,
          emoji
        });
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to toggle reaction'));
      }
    },
    [message.id]
  );

  const handlePinToggle = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;

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
      if (!trpc) return;

      try {
        await trpc.dms.toggleReaction.mutate({
          dmMessageId: message.id,
          emoji: emoji.name
        });
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to add reaction'));
      }
    },
    [message.id]
  );

  const onCopyText = useCallback(() => {
    if (!message.content) return;
    const plainText = stripToPlainText(message.content);
    navigator.clipboard.writeText(plainText);
    toast.success('Copied to clipboard');
  }, [message.content]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <div id={`dm-msg-${message.id}`} className="min-w-0 flex-1 ml-1 relative hover:bg-secondary/50 rounded-md px-1 py-0.5 group">
      {message.replyTo && (
        <ReplyPreview replyTo={message.replyTo} onJumpTo={scrollToDmMessage} />
      )}
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
          <MessageActions
            pinned={message.pinned ?? false}
            editable
            canEdit={isOwnMessage}
            canDelete={isOwnMessage}
            canPin
            canReact
            canReply
            onEdit={() => setIsEditing(true)}
            onDelete={handleDelete}
            onReply={onReply}
            onTogglePin={handlePinToggle}
            onEmojiReact={onEmojiSelect}
          />
        </>
      ) : (
        <DmMessageEdit
          message={message}
          onSubmit={handleEditSubmit}
          onCancel={() => setIsEditing(false)}
        />
      )}
    </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={onReply}>
          <Reply className="h-4 w-4" />
          Reply
        </ContextMenuItem>
        {isOwnMessage && (
          <ContextMenuItem onClick={() => setIsEditing(true)}>
            <Pencil className="h-4 w-4" />
            Edit Message
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={handlePinToggle}>
          {message.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          {message.pinned ? 'Unpin' : 'Pin'}
        </ContextMenuItem>
        <EmojiPicker onEmojiSelect={onEmojiSelect}>
          <ContextMenuItem onSelect={(e) => e.preventDefault()}>
            <Smile className="h-4 w-4" />
            Add Reaction
          </ContextMenuItem>
        </EmojiPicker>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onCopyText} disabled={!message.content}>
          <Copy className="h-4 w-4" />
          Copy Text
        </ContextMenuItem>
        {isOwnMessage && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={handleDelete} variant="destructive">
              <Trash className="h-4 w-4" />
              Delete Message
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** Renders a single DM media file, decrypting if E2EE. */
const DmMediaFile = memo(({
  file, fileIndex, messageId, isE2ee
}: {
  file: TFile;
  fileIndex: number;
  messageId: number;
  isE2ee: boolean;
}) => {
  const { url, loading } = useDecryptedFileUrl(file, messageId, isE2ee, fileIndex);

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

/** Renders a non-media DM file link, decrypting if E2EE. */
const DmNonMediaFile = memo(({
  file, fileIndex, messageId, isE2ee
}: {
  file: TFile;
  fileIndex: number;
  messageId: number;
  isE2ee: boolean;
}) => {
  const { url, loading } = useDecryptedFileUrl(file, messageId, isE2ee, fileIndex);

  return (
    <a
      key={file.id}
      href={loading ? undefined : url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/50"
    >
      <span className="truncate">{file.originalName}</span>
      <span className="text-xs text-muted-foreground">
        ({filesize(file.size)})
      </span>
    </a>
  );
});

const DmMessageContent = memo(
  ({ message }: { message: TJoinedDmMessage }) => {
    const content = message.content ?? '';
    const legacy = isLegacyHtml(content);
    const [tokenMedia, setTokenMedia] = useState<TFoundMedia[]>([]);

    const { foundMedia: htmlMedia, messageHtml } = useMemo(() => {
      if (!legacy) return { foundMedia: [] as TFoundMedia[], messageHtml: null };
      const foundMedia: TFoundMedia[] = [];
      const messageHtml = parse(content, {
        replace: (domNode) =>
          serializer(domNode, (found) => foundMedia.push(found))
      });
      return { messageHtml, foundMedia };
    }, [content, legacy]);

    const foundMedia = legacy ? htmlMedia : tokenMedia;

    const handleTokenMedia = useCallback((media: TFoundMedia) => {
      setTokenMedia((prev) => {
        if (prev.some((m) => m.url === media.url)) return prev;
        return [...prev, media];
      });
    }, []);

    // Categorize files into media vs non-media, preserving original index
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
      (message.content === '[Unable to decrypt]' ||
        message.content === '[Encrypted message]');

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
            <div className="max-w-full break-words msg-content min-w-0">
              {legacy ? messageHtml : (
                <TokenContentRenderer content={content} fileCount={message.files.length} onFoundMedia={handleTokenMedia} />
              )}
            </div>
          </div>
        ) : null}

        {message.updatedAt && (
          <span className="text-[10px] text-muted-foreground">(edited)</span>
        )}

        {/* Inline media from message HTML */}
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

        {/* Media file attachments — each handles E2EE decryption */}
        {mediaFiles.map(({ file, index }) => (
          <DmMediaFile
            key={file.id}
            file={file}
            fileIndex={index}
            messageId={message.id}
            isE2ee={message.e2ee}
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

        {nonMediaFiles.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {nonMediaFiles.map(({ file, index }) => (
              <DmNonMediaFile
                key={file.id}
                file={file}
                fileIndex={index}
                messageId={message.id}
                isE2ee={message.e2ee}
              />
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
    const ctx = useTokenToTiptapContext();
    const initialContent = useMemo(() => {
      const raw = message.content ?? '';
      if (isLegacyHtml(raw) || !raw) return raw;
      return tokensToTiptapHtml(raw, ctx);
    }, [message.content, ctx]);
    const [editContent, setEditContent] = useState(initialContent);
    const dmChannels = useDmChannels();
    const editDmMembers = useMemo(() => {
      const channel = dmChannels.find((c) => c.id === message.dmChannelId);
      return channel?.members.map((m) => ({ id: m.id, name: m.name, avatar: m.avatar, _identity: m._identity })) ?? [];
    }, [dmChannels, message.dmChannelId]);

    const handleSubmit = useCallback(() => {
      onSubmit(editContent);
    }, [editContent, onSubmit]);

    return (
      <div className="flex flex-col gap-1">
        <TiptapInput
          value={editContent}
          onChange={setEditContent}
          onSubmit={handleSubmit}
          onCancel={onCancel}
          dmMembers={editDmMembers}
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
