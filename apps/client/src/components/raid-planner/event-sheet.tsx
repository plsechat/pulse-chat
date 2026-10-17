import { LazyFallback } from '@/components/lazy-fallback';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { UserAvatar } from '@/components/user-avatar';
import { requestConfirmation } from '@/features/dialogs/actions';
import {
  cancelEvent,
  closeEvent,
  declineEvent,
  fetchEventDetail,
  openEventEditor,
  setSignupStatus,
  signupForEvent,
  withdrawFromEvent
} from '@/features/events/actions';
import {
  useCanManageEvent,
  useEventDetail,
  useEventItem,
  useOpenEventId
} from '@/features/events/hooks';
import {
  eventIsOpen,
  isSignedUp,
  orderBench,
  orderConfirmed,
  roleByKey,
  roleIsFull,
  roleLabel
} from '@/features/events/roster';
import { setSelectedChannelId } from '@/features/server/channels/actions';
import {
  useChannelById,
  useCurrentVoiceChannelPublicId
} from '@/features/server/channels/hooks';
import { useCan, useChannelCan } from '@/features/server/hooks';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { joinVoice } from '@/features/server/voice/actions';
import { useVoice } from '@/features/server/voice/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useLayoutMode } from '@/hooks/use-appearance-settings';
import { useHistoryOverlay } from '@/hooks/use-history-overlay';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { emitAppEvent } from '@/lib/events';
import { cn } from '@/lib/utils';
import type {
  TEventDetail,
  TEventRole,
  TEventSignup
} from '@pulse/server/types';
import { ChannelPermission, Permission } from '@pulse/shared';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Pencil,
  Volume2,
  X,
  XCircle
} from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { OwnStatusChip } from './agenda';
import { EventWhen, GameTag, RolePill, StatusPill } from './bits';

const useBusy = () => {
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (task: () => Promise<unknown>, fallback: string) => {
      setBusy(true);
      try {
        await task();
      } catch (err) {
        toast.error(getTrpcError(err, fallback));
      } finally {
        setBusy(false);
      }
    },
    []
  );
  return { busy, run };
};

/** Takes the viewer into the event's voice room the way the channel row does. */
const JoinRoomButton = memo(({ channelId }: { channelId: number }) => {
  const channel = useChannelById(channelId);
  const channelCan = useChannelCan(channelId);
  const can = useCan();
  const currentVoicePublicId = useCurrentVoiceChannelPublicId();
  const { init } = useVoice();
  const { busy, run } = useBusy();

  if (!channel) return null;
  const inRoom =
    !!channel.publicId && currentVoicePublicId === channel.publicId;
  const allowed =
    channelCan(ChannelPermission.JOIN) && can(Permission.JOIN_VOICE_CHANNELS);

  const onClick = () =>
    run(async () => {
      setSelectedChannelId(channelId);
      emitAppEvent('channel-selected', { channelId });
      closeEvent();
      if (inRoom) return;
      const response = await joinVoice(channelId);
      if (!response) {
        // joinVoice has already told the user why.
        setSelectedChannelId(undefined);
        return;
      }
      await init(response, channelId);
    }, 'Failed to join the voice room');

  return (
    <Button
      type="button"
      size="sm"
      onClick={onClick}
      disabled={busy || !allowed}
      title={allowed ? undefined : 'You cannot join this room'}
      className="bg-live text-background hover:bg-live/90"
    >
      <Volume2 className="h-4 w-4" />
      {inRoom ? 'Back to voice room' : 'Join voice room'}
    </Button>
  );
});

type TRosterRowProps = {
  signup: TEventSignup;
  roles: TEventRole[];
  canManage: boolean;
  closed: boolean;
  /** Bench rows show their promotion order. */
  index?: number;
};

const RosterRow = memo(
  ({ signup, roles, canManage, closed, index }: TRosterRowProps) => {
    const user = useUserById(signup.userId);
    const ownUserId = useOwnUserId();
    const name = getDisplayName(user);
    const { busy, run } = useBusy();
    const benched = signup.status === 'bench';
    const roleStillExists = roleByKey(roles, signup.roleKey) !== undefined;

    return (
      <li
        className={cn(
          'flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm',
          signup.userId === ownUserId && 'bg-[color:var(--community)]/10'
        )}
      >
        {index !== undefined && (
          <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
            {index + 1}
          </span>
        )}
        <UserAvatar
          userId={signup.userId}
          className="h-6 w-6"
          showStatusBadge={false}
          noDecoration
        />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {benched && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {roleLabel(roles, signup.roleKey)}
          </span>
        )}
        {canManage && !closed && (
          <IconButton
            variant="ghost"
            size="sm"
            icon={benched ? ArrowUpFromLine : ArrowDownToLine}
            aria-label={benched ? `Promote ${name}` : `Bench ${name}`}
            title={
              benched
                ? roleStillExists
                  ? `Promote ${name} to ${roleLabel(roles, signup.roleKey)}`
                  : `${name}'s role no longer exists — edit the event first`
                : `Bench ${name}`
            }
            disabled={busy || (benched && !roleStillExists)}
            onClick={() =>
              run(
                () =>
                  setSignupStatus(
                    signup.eventId,
                    signup.userId,
                    benched ? 'confirmed' : 'bench'
                  ),
                benched ? 'Failed to promote' : 'Failed to bench'
              )
            }
          />
        )}
      </li>
    );
  }
);

const YourSpot = memo(({ detail }: { detail: TEventDetail }) => {
  const item = useEventItem(detail.event.id);
  const own = item?.ownSignup ?? null;
  const { busy, run } = useBusy();
  const [picked, setPicked] = useState<string | undefined>(own?.roleKey);
  const closed = !eventIsOpen(detail.event);
  const signedUp = isSignedUp(own);

  useEffect(() => {
    if (own?.roleKey) setPicked(own.roleKey);
  }, [own?.roleKey]);

  if (closed) return null;

  const eventId = detail.event.id;
  const pickedRole = picked ? roleByKey(detail.event.roles, picked) : undefined;
  const changing = signedUp && picked !== own?.roleKey;

  return (
    <section className="flex flex-col gap-2 rounded-xl bg-foreground/[0.04] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Your spot
        </h3>
        {item && <OwnStatusChip item={item} />}
      </div>
      <div
        role="radiogroup"
        aria-label="Role"
        className="flex flex-wrap gap-1.5"
      >
        {detail.event.roles.map((role) => {
          const full = roleIsFull(role, detail.counts);
          return (
            <RolePill
              key={role.key}
              role={role}
              counts={detail.counts}
              selected={picked === role.key}
              onClick={() => setPicked(role.key)}
              hint={full && own?.roleKey !== role.key ? 'bench' : undefined}
              title={
                full
                  ? `${role.label} is full — you would join the bench`
                  : `Sign up as ${role.label}`
              }
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || !pickedRole || (signedUp && !changing)}
          onClick={() =>
            pickedRole &&
            run(
              () => signupForEvent(eventId, pickedRole.key),
              'Failed to sign up'
            )
          }
        >
          {signedUp
            ? changing
              ? `Change to ${pickedRole?.label ?? 'role'}`
              : 'Signed up'
            : `Sign up${pickedRole ? ` as ${pickedRole.label}` : ''}`}
        </Button>
        {signedUp && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(() => withdrawFromEvent(eventId), 'Failed to withdraw')
            }
          >
            Withdraw
          </Button>
        )}
        {own?.status !== 'declined' && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              run(() => declineEvent(eventId), 'Failed to decline')
            }
          >
            Decline
          </Button>
        )}
      </div>
    </section>
  );
});

const HostControls = memo(({ detail }: { detail: TEventDetail }) => {
  const { busy, run } = useBusy();
  const closed = !eventIsOpen(detail.event);
  if (closed) return null;

  const onCancel = async () => {
    const confirmed = await requestConfirmation({
      title: 'Cancel event',
      message: `Cancel "${detail.event.title}"? Everyone signed up will see it as cancelled and its voice room goes away.`,
      confirmLabel: 'Cancel event',
      cancelLabel: 'Keep it',
      variant: 'danger'
    });
    if (!confirmed) return;
    await run(async () => {
      await cancelEvent(detail.event.id);
      toast.success('Event cancelled');
    }, 'Failed to cancel the event');
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          openEventEditor({ mode: 'edit', eventId: detail.event.id })
        }
      >
        <Pencil className="h-4 w-4" />
        Edit
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={onCancel}
        className="text-destructive hover:text-destructive"
      >
        <XCircle className="h-4 w-4" />
        Cancel
      </Button>
    </div>
  );
});

const Host = memo(({ detail }: { detail: TEventDetail }) => {
  const user = useUserById(detail.host?.id ?? -1);
  if (!detail.host) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <UserAvatar
        userId={detail.host.id}
        className="h-5 w-5"
        showStatusBadge={false}
        noDecoration
      />
      <span>Hosted by {user ? getDisplayName(user) : detail.host.name}</span>
    </span>
  );
});

const EventSheetBody = memo(({ eventId }: { eventId: number }) => {
  const detail = useEventDetail(eventId);
  const canManage = useCanManageEvent(detail?.event);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    setSettled(false);
    void fetchEventDetail(eventId).finally(() => setSettled(true));
  }, [eventId]);

  if (!detail) {
    return settled ? (
      <div className="p-6 text-center text-sm text-muted-foreground">
        This event is no longer available.
      </div>
    ) : (
      <LazyFallback />
    );
  }

  const { event, roster, counts } = detail;
  const closed = !eventIsOpen(event);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={event.status} />
          <GameTag tag={event.gameTag} />
        </div>
        <h2 className="text-xl font-semibold leading-tight tracking-tight text-foreground">
          {event.title}
        </h2>
        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          <EventWhen event={event} className="text-foreground" />
          <Host detail={detail} />
        </div>
        {event.description && (
          <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">
            {event.description}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {event.voiceChannelId !== null && (
            <JoinRoomButton channelId={event.voiceChannelId} />
          )}
          {canManage && <HostControls detail={detail} />}
        </div>
      </div>

      <YourSpot detail={detail} />

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Roster
        </h3>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
          {roster.confirmed.map(({ role, signups }) => (
            <div
              key={role.key}
              className="flex min-w-0 flex-col gap-1 rounded-xl bg-foreground/[0.03] p-2"
              aria-label={`${role.label}, ${signups.length} confirmed`}
            >
              <RolePill role={role} counts={counts} className="self-start" />
              {signups.length === 0 ? (
                <span className="px-1.5 py-1 text-xs text-muted-foreground">
                  Open
                </span>
              ) : (
                <ul className="flex flex-col">
                  {orderConfirmed(signups).map((signup) => (
                    <RosterRow
                      key={signup.id}
                      signup={signup}
                      roles={event.roles}
                      canManage={canManage}
                      closed={closed}
                    />
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Bench
          <span className="font-normal normal-case tracking-normal">
            {roster.bench.length === 0
              ? 'empty'
              : `${roster.bench.length} waiting · first in line is promoted when a slot frees`}
          </span>
        </h3>
        {roster.bench.length > 0 && (
          <ul className="flex flex-col">
            {orderBench(roster.bench).map((signup, index) => (
              <RosterRow
                key={signup.id}
                signup={signup}
                roles={event.roles}
                canManage={canManage}
                closed={closed}
                index={index}
              />
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          {roster.declined === 0
            ? 'Nobody declined.'
            : `${roster.declined} declined.`}
        </p>
      </section>
    </div>
  );
});

/**
 * Where the sheet lives: a panel beside the content in the deck
 * layout, a dialog in the classic one, full-screen on phones. The host
 * is mounted by the content wrapper so a chat card can open it while
 * the planner is not on screen.
 */
const EventSheetHost = memo(() => {
  const eventId = useOpenEventId();
  const isMobile = useIsMobile();
  const deck = useLayoutMode() === 'deck';

  useHistoryOverlay(isMobile && eventId !== undefined, closeEvent);

  if (eventId === undefined) return null;

  if (!isMobile && !deck) {
    return (
      <Dialog open onOpenChange={(open) => !open && closeEvent()}>
        <DialogContent
          close={closeEvent}
          // The confirm dialog (Cancel event) is portalled outside this
          // sheet; a click on it must not count as leaving the sheet.
          onInteractOutside={(e) => {
            const target = e.target as HTMLElement | null;
            if (target?.closest?.('[role="alertdialog"]')) {
              e.preventDefault();
              return;
            }
            closeEvent();
          }}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-0 sm:max-w-2xl"
        >
          <DialogTitle className="sr-only">Event</DialogTitle>
          <EventSheetBody eventId={eventId} />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <aside
      aria-label="Event"
      className={cn(
        'flex flex-col bg-background',
        isMobile
          ? 'fixed inset-0 z-30 w-full'
          : 'panel-enter w-80 shrink-0 border-l border-border lg:w-96'
      )}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="flex-1 text-sm font-medium text-foreground">
          Event
        </span>
        <IconButton
          variant="ghost"
          size="sm"
          icon={X}
          aria-label="Close event"
          onClick={closeEvent}
          className="h-7 w-7 rounded-md hover:bg-accent"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EventSheetBody eventId={eventId} />
      </div>
    </aside>
  );
});

export { EventSheetHost };
