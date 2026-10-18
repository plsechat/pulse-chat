import {
  EventWhen,
  FillBar,
  GameTag,
  RolePill,
  StatusPill
} from '@/components/raid-planner/bits';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { UserAvatar } from '@/components/user-avatar';
import {
  ensureEventDetail,
  openEvent,
  signupForEvent,
  withdrawFromEvent
} from '@/features/events/actions';
import { useEventItem } from '@/features/events/hooks';
import {
  eventIsOpen,
  isSignedUp,
  roleIsFull,
  roleLabel
} from '@/features/events/roster';
import type { TEventSystemRow } from '@/features/events/system-rows';
import { usePlannerEnabled } from '@/features/server/hooks';
import { useUserById } from '@/features/server/users/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { fullDateTime } from '@/helpers/time-format';
import { cn } from '@/lib/utils';
import type { TEventListItem } from '@pulse/server/types';
import { format } from 'date-fns';
import { CalendarCheck2, CalendarDays } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

const HostLine = memo(({ hostId }: { hostId: number | null }) => {
  const host = useUserById(hostId ?? -1);
  if (hostId === null) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <UserAvatar
        userId={hostId}
        className="h-4 w-4"
        showStatusBadge={false}
        noDecoration
      />
      {getDisplayName(host)}
    </span>
  );
});

/** Role pills that sign the viewer up on click; their own role is marked. */
const CardRsvp = memo(({ item }: { item: TEventListItem }) => {
  const [busy, setBusy] = useState(false);
  const own = item.ownSignup;
  const signedUp = isSignedUp(own);
  const open = eventIsOpen(item);

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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {item.roles.map((role) => {
          const mine = signedUp && own?.roleKey === role.key;
          const full = roleIsFull(role, item.counts);
          return (
            <RolePill
              key={role.key}
              role={role}
              counts={item.counts}
              selected={mine}
              disabled={busy || !open}
              hint={
                mine
                  ? own?.status === 'bench'
                    ? 'you, benched'
                    : 'you'
                  : undefined
              }
              title={
                !open
                  ? undefined
                  : mine
                    ? 'Your role'
                    : full
                      ? `${role.label} is full — sign up for the bench`
                      : `Sign up as ${role.label}`
              }
              onClick={
                open
                  ? () =>
                      run(
                        () => signupForEvent(item.id, role.key),
                        'Failed to sign up'
                      )
                  : undefined
              }
            />
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {open && signedUp && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(() => withdrawFromEvent(item.id), 'Failed to withdraw')
            }
          >
            Withdraw
          </Button>
        )}
        {own?.status === 'declined' && open && (
          <span className="text-xs text-muted-foreground">You declined.</span>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => openEvent(item.id)}
          className="ml-auto"
        >
          Details
        </Button>
      </div>
    </div>
  );
});

type TEventCardProps = { row: TEventSystemRow; date: Date };

/**
 * The planner's rows in a channel: the RSVP card posted when an event
 * is announced, and the one-line summary posted when it ended. The row
 * only carries the id; the card loads the event through the slice and
 * stays live through the same subscriptions as the planner.
 */
const EventCard = memo(({ row, date }: TEventCardProps) => {
  const item = useEventItem(row.eventId);
  // Planner off: the card stays in the channel but is read-only — no
  // RSVP, no detail fetch (the route refuses), no sheet.
  const plannerEnabled = usePlannerEnabled();
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (item || !plannerEnabled) return;
    setSettled(false);
    ensureEventDetail(row.eventId);
    // A row that never resolves is a cancelled/removed event: show the
    // fallback after the fetch had a fair chance.
    const timer = setTimeout(() => setSettled(true), 4000);
    return () => clearTimeout(timer);
  }, [row.eventId, item, plannerEnabled]);

  const timestamp = format(date, fullDateTime());

  if (row.kind === 'event-summary') {
    return (
      <div className="flex justify-center px-4 py-2">
        <Tooltip content={timestamp}>
          <div className="flex max-w-lg items-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground shadow-sm select-none">
            <CalendarCheck2 className="h-4 w-4 shrink-0 text-primary" />
            <span>
              <strong>{item?.title ?? 'The event'}</strong> ended ·{' '}
              {row.attended} attended
              {plannerEnabled && (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="underline underline-offset-2 hover:text-foreground"
                    onClick={() => openEvent(row.eventId)}
                  >
                    View event
                  </button>
                </>
              )}
            </span>
          </div>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="px-4 py-2">
      <div
        className={cn(
          'surface-soft mx-auto flex w-full max-w-xl flex-col gap-3 rounded-2xl bg-card p-4 ring-1 ring-white/[0.05]',
          item?.status === 'cancelled' && 'opacity-75'
        )}
      >
        <div className="flex items-start gap-3">
          <span className="channel-tile flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
            <CalendarDays className="h-5 w-5" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Tooltip content={timestamp}>
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Event
                </span>
              </Tooltip>
              {item && <StatusPill status={item.status} />}
              {item && <GameTag tag={item.gameTag} />}
            </div>
            {item ? (
              <>
                <button
                  type="button"
                  onClick={() => openEvent(item.id)}
                  disabled={!plannerEnabled}
                  className="text-left text-base font-semibold leading-tight text-foreground enabled:hover:underline disabled:cursor-default"
                >
                  {item.title}
                </button>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <EventWhen event={item} />
                  <HostLine hostId={item.hostId} />
                </div>
                <FillBar
                  event={item}
                  counts={item.counts}
                  withLabel
                  className="max-w-48"
                />
              </>
            ) : (
              <span className="text-sm text-muted-foreground">
                {!plannerEnabled
                  ? 'The Planner is turned off in this community.'
                  : settled
                    ? 'This event is no longer available.'
                    : 'Loading event…'}
              </span>
            )}
          </div>
        </div>
        {item && plannerEnabled && <CardRsvp item={item} />}
        {item && !plannerEnabled && (
          <span className="text-xs text-muted-foreground">
            The Planner is turned off in this community; signups are paused.
          </span>
        )}
        {item && isSignedUp(item.ownSignup) && item.ownSignup && (
          <span className="sr-only">
            You are signed up as {roleLabel(item.roles, item.ownSignup.roleKey)}
          </span>
        )}
      </div>
    </div>
  );
});

export { EventCard };
