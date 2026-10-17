import {
  useChannelById,
  useCurrentVoiceChannelId,
  useCurrentVoiceKind,
  useSelectedChannel
} from '@/features/server/channels/hooks';
import { useChannelCan, usePreviewMode } from '@/features/server/hooks';
import { leaveCurrentVoice } from '@/features/server/voice/actions';
import { useVoice } from '@/features/server/voice/hooks';
import { useHistoryOverlay } from '@/hooks/use-history-overlay';
import { cn } from '@/lib/utils';
import { ChannelPermission } from '@pulse/shared';
import {
  Bell,
  CalendarClock,
  Hash,
  Headphones,
  HeadphoneOff,
  LayoutList,
  List,
  Lock,
  Megaphone,
  Menu,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  MoreVertical,
  PhoneOff,
  Pin,
  Search,
  Users,
  Video,
  VideoOff,
  Volume2
} from 'lucide-react';
import { memo, useCallback, useState, type ReactNode } from 'react';
import { SearchPopover } from '../search/search-popover';
import { NotificationDropdown } from '../top-bar/notification-dropdown';
import { PinnedMessagesPanel } from '../top-bar/pinned-messages-panel';
import { ScheduledPostsPopover } from '../top-bar/scheduled-posts-popover';
import { ThreadListPopover } from '../top-bar/thread-list-popover';
import { VolumeController } from '../top-bar/volume-controller';
import { Button } from '../ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '../ui/sheet';

type TMobileHeaderProps = {
  onToggleLeftDrawer: () => void;
  onToggleRightDrawer?: () => void;
  title?: string;
};

type TMobileSheet = 'menu' | 'search' | 'pinned' | 'threads' | 'scheduled' | null;

const alwaysAllowed = () => true;

/** Screen capture does not exist on phones; the control would only toast. */
const canShareScreen = () =>
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices?.getDisplayMedia === 'function';

const STATUS_DOT: Record<string, string> = {
  connecting: 'bg-yellow-500 animate-pulse',
  connected: 'bg-green-500',
  failed: 'bg-red-500',
  disconnected: 'bg-red-500'
};

const VOICE_BTN = 'h-8 w-8 rounded-md';

/**
 * The in-call strip under the mobile header. On phones the voice
 * controls otherwise live only inside the closed channel drawer, so a
 * call had no visible state and no reachable mute/leave.
 */
const MobileVoiceBar = memo(() => {
  const voiceChannelId = useCurrentVoiceChannelId();
  const voiceKind = useCurrentVoiceKind();
  const voiceChannel = useChannelById(voiceChannelId ?? -1);
  // Channel permissions exist for server channels only; a DM call has
  // none (same rule as left-sidebar/voice-control).
  const channelCan = useChannelCan(
    voiceKind === 'channel' ? voiceChannelId : undefined
  );
  const can = voiceKind === 'dm' ? alwaysAllowed : channelCan;
  const {
    ownVoiceState,
    toggleMic,
    toggleSound,
    toggleWebcam,
    toggleScreenShare,
    connectionStatus
  } = useVoice();

  if (!voiceChannelId) return null;

  const label =
    voiceKind === 'dm' ? 'Voice call' : (voiceChannel?.name ?? 'Voice');

  return (
    <div
      className="flex h-10 items-center gap-1 border-t border-border/60 bg-secondary/30 px-2"
      data-testid="mobile-voice-bar"
    >
      <span
        className={cn(
          'ml-1 h-2 w-2 shrink-0 rounded-full',
          STATUS_DOT[connectionStatus] ?? STATUS_DOT.disconnected
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/80">
        {label}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className={cn(VOICE_BTN, ownVoiceState.micMuted && 'text-red-400')}
        onClick={toggleMic}
        disabled={!can(ChannelPermission.SPEAK)}
        title={ownVoiceState.micMuted ? 'Unmute microphone' : 'Mute microphone'}
      >
        {ownVoiceState.micMuted ? (
          <MicOff className="h-4 w-4" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={cn(VOICE_BTN, ownVoiceState.soundMuted && 'text-red-400')}
        onClick={toggleSound}
        title={ownVoiceState.soundMuted ? 'Undeafen' : 'Deafen'}
      >
        {ownVoiceState.soundMuted ? (
          <HeadphoneOff className="h-4 w-4" />
        ) : (
          <Headphones className="h-4 w-4" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={cn(VOICE_BTN, ownVoiceState.webcamEnabled && 'text-green-400')}
        onClick={toggleWebcam}
        disabled={!can(ChannelPermission.WEBCAM)}
        title={ownVoiceState.webcamEnabled ? 'Turn off camera' : 'Turn on camera'}
      >
        {ownVoiceState.webcamEnabled ? (
          <Video className="h-4 w-4" />
        ) : (
          <VideoOff className="h-4 w-4" />
        )}
      </Button>
      {canShareScreen() && (
        <Button
          variant="ghost"
          size="icon"
          className={cn(VOICE_BTN, ownVoiceState.sharingScreen && 'text-blue-400')}
          onClick={toggleScreenShare}
          disabled={!can(ChannelPermission.SHARE_SCREEN)}
          title={
            ownVoiceState.sharingScreen ? 'Stop screen share' : 'Start screen share'
          }
        >
          {ownVoiceState.sharingScreen ? (
            <Monitor className="h-4 w-4" />
          ) : (
            <MonitorOff className="h-4 w-4" />
          )}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className={cn(VOICE_BTN, 'text-red-400 hover:text-red-300')}
        onClick={() => void leaveCurrentVoice()}
        title="Disconnect"
      >
        <PhoneOff className="h-4 w-4" />
      </Button>
    </div>
  );
});

type TMenuRowProps = {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  trailing?: ReactNode;
};

const MenuRow = memo(({ icon, label, onClick, trailing }: TMenuRowProps) => (
  <div className="flex items-center gap-3 px-4">
    <button
      type="button"
      onClick={onClick}
      className="flex h-12 min-w-0 flex-1 items-center gap-3 text-left text-sm text-foreground"
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
    {trailing}
  </div>
));

/**
 * Host for the top-bar panels (Search, Pinned, Threads) inside a bottom
 * sheet. The panels position themselves as popovers (absolute, fixed
 * width, capped height); a child selector flattens that so the same
 * component fills the sheet instead — the panels are shared with the
 * desktop top bar and stay untouched.
 */
const PANEL_HOST =
  'flex min-h-0 flex-1 flex-col [&>div]:static [&>div]:mt-0 [&>div]:flex [&>div]:min-h-0 [&>div]:w-full [&>div]:max-w-full [&>div]:flex-1 [&>div]:animate-none [&>div]:rounded-none [&>div]:border-0 [&>div]:shadow-none [&>div]:max-h-none';

const MobileHeader = memo(
  ({ onToggleLeftDrawer, onToggleRightDrawer, title }: TMobileHeaderProps) => {
    const selectedChannel = useSelectedChannel();
    const previewMode = usePreviewMode();
    const currentVoiceChannelId = useCurrentVoiceChannelId();
    const [sheet, setSheet] = useState<TMobileSheet>(null);
    const closeSheet = useCallback(() => setSheet(null), []);
    useHistoryOverlay(sheet !== null, closeSheet);

    const channelName = title || selectedChannel?.name;
    const channelType = selectedChannel?.type;
    // The overflow menu carries the top bar's channel tools, so it
    // exists exactly where the top bar would show them: a text channel
    // in the server view (the Home header names no channel).
    const textChannel =
      !title && selectedChannel && channelType === 'TEXT'
        ? selectedChannel
        : undefined;

    return (
      <div className="md:hidden flex w-full flex-col border-b border-border bg-background">
        <div className="flex h-12 items-center gap-1 px-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 flex-shrink-0"
            title="Open channels"
            onClick={onToggleLeftDrawer}
          >
            <Menu className="h-5 w-5" />
          </Button>

          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            {!title && channelType === 'TEXT' && selectedChannel?.announcement && (
              <Megaphone
                className="h-4 w-4 text-muted-foreground/60 flex-shrink-0"
                aria-label="Announcement channel"
              />
            )}
            {!title && channelType === 'TEXT' && !selectedChannel?.announcement && (
              <Hash className="h-4 w-4 text-muted-foreground/60 flex-shrink-0" />
            )}
            {!title && channelType === 'VOICE' && (
              <Volume2 className="h-4 w-4 text-muted-foreground/60 flex-shrink-0" />
            )}
            {!title && channelType === 'FORUM' && (
              <LayoutList className="h-4 w-4 text-muted-foreground/60 flex-shrink-0" />
            )}
            {channelName && (
              <span className="text-sm font-semibold text-foreground truncate">
                {channelName}
              </span>
            )}
            {!title && selectedChannel?.e2ee && (
              <Lock
                className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0"
                aria-label="End-to-end encrypted"
              />
            )}
          </div>

          <div className="flex items-center gap-0.5">
            {onToggleRightDrawer && (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 flex-shrink-0"
                onClick={onToggleRightDrawer}
                title="Open members"
              >
                <Users className="h-5 w-5" />
              </Button>
            )}
            {textChannel && (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 flex-shrink-0"
                onClick={() => setSheet('menu')}
                title="More"
              >
                <MoreVertical className="h-5 w-5" />
              </Button>
            )}
          </div>
        </div>

        <MobileVoiceBar />

        {textChannel && (
          <>
            <Sheet
              open={sheet === 'menu'}
              onOpenChange={(open) => !open && closeSheet()}
            >
              <SheetContent
                side="bottom"
                close={closeSheet}
                className="rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
              >
                <SheetHeader className="pb-2">
                  <SheetTitle className="flex items-center gap-2 pr-8">
                    <Hash className="h-4 w-4 text-muted-foreground/60 flex-shrink-0" />
                    <span className="truncate">{textChannel.name}</span>
                  </SheetTitle>
                  {textChannel.topic ? (
                    <SheetDescription className="whitespace-pre-wrap break-words">
                      {textChannel.topic}
                    </SheetDescription>
                  ) : (
                    <SheetDescription className="sr-only">
                      Channel tools
                    </SheetDescription>
                  )}
                  {textChannel.e2ee && (
                    <div className="flex items-center gap-1.5 text-xs text-emerald-500">
                      <Lock className="h-3.5 w-3.5" />
                      End-to-end encrypted
                    </div>
                  )}
                </SheetHeader>
                <div className="flex flex-col pb-2">
                  <MenuRow
                    icon={<Search className="h-4 w-4" />}
                    label="Search messages"
                    onClick={() => setSheet('search')}
                  />
                  <MenuRow
                    icon={<Pin className="h-4 w-4" />}
                    label="Pinned messages"
                    onClick={() => setSheet('pinned')}
                  />
                  <MenuRow
                    icon={<List className="h-4 w-4" />}
                    label="Threads"
                    onClick={() => setSheet('threads')}
                  />
                  {!previewMode && !textChannel.e2ee && (
                    <MenuRow
                      icon={<CalendarClock className="h-4 w-4" />}
                      label="Scheduled messages"
                      onClick={() => setSheet('scheduled')}
                    />
                  )}
                  {/* Notification prefs are member-scoped — meaningless in preview */}
                  {!previewMode && (
                    <NotificationDropdown channelId={textChannel.id}>
                      <div className="px-4">
                        <button
                          type="button"
                          className="flex h-12 w-full items-center gap-3 text-left text-sm text-foreground"
                        >
                          <span className="text-muted-foreground">
                            <Bell className="h-4 w-4" />
                          </span>
                          Notification settings
                        </button>
                      </div>
                    </NotificationDropdown>
                  )}
                  {currentVoiceChannelId && (
                    <MenuRow
                      icon={<Volume2 className="h-4 w-4" />}
                      label="Volume controls"
                      trailing={
                        <VolumeController channelId={currentVoiceChannelId} />
                      }
                    />
                  )}
                </div>
              </SheetContent>
            </Sheet>

            {/* The panels bring their own header with a close button; the
                sheet's corner X is hidden so the two do not overlap. */}
            <Sheet
              open={
                sheet === 'search' ||
                sheet === 'pinned' ||
                sheet === 'threads' ||
                sheet === 'scheduled'
              }
              onOpenChange={(open) => !open && closeSheet()}
            >
              <SheetContent
                side="bottom"
                close={closeSheet}
                className="h-[85dvh] gap-0 rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)] [&>button:last-of-type]:hidden"
              >
                <SheetTitle className="sr-only">
                  {sheet === 'search'
                    ? 'Search messages'
                    : sheet === 'pinned'
                      ? 'Pinned messages'
                      : sheet === 'scheduled'
                        ? 'Scheduled messages'
                        : 'Threads'}
                </SheetTitle>
                <SheetDescription className="sr-only">
                  {textChannel.name}
                </SheetDescription>
                <div className={PANEL_HOST} data-testid="mobile-panel-host">
                  {sheet === 'search' && <SearchPopover onClose={closeSheet} />}
                  {sheet === 'pinned' && (
                    <PinnedMessagesPanel
                      channelId={textChannel.id}
                      onClose={closeSheet}
                    />
                  )}
                  {sheet === 'threads' && (
                    <ThreadListPopover
                      channelId={textChannel.id}
                      onClose={closeSheet}
                      sheet
                    />
                  )}
                  {sheet === 'scheduled' && (
                    <ScheduledPostsPopover
                      channelId={textChannel.id}
                      onClose={closeSheet}
                    />
                  )}
                </div>
              </SheetContent>
            </Sheet>
          </>
        )}
      </div>
    );
  }
);

export { MobileHeader };
