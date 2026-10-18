import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { UserAvatar } from '@/components/user-avatar';
import { openEvent, setPlannerFocusDay } from '@/features/events/actions';
import {
  eventTouchesDay,
  groupByStartDay,
  windowForDay
} from '@/features/events/calendar';
import { roleLabel } from '@/features/events/roster';
import { useUserById } from '@/features/server/users/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { cn } from '@/lib/utils';
import type { TEventListItem } from '@pulse/server/types';
import { format, isSameDay } from 'date-fns';
import { CalendarDays, ChevronLeft } from 'lucide-react';
import { memo, useMemo } from 'react';
import { EventWhen, GameTag, RolePill, StatusPill } from './bits';
import { QuickSignup } from './quick-signup';

const HostLine = memo(({ hostId }: { hostId: number | null }) => {
  const host = useUserById(hostId ?? -1);
  if (hostId === null) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <UserAvatar
        userId={hostId}
        className="h-4 w-4"
        showStatusBadge={false}
        noDecoration
      />
      <span className="truncate">Hosted by {getDisplayName(host)}</span>
    </span>
  );
});

const OwnStatusChip = memo(({ item }: { item: TEventListItem }) => {
  const own = item.ownSignup;
  if (!own) return null;
  const text =
    own.status === 'confirmed'
      ? `You're in · ${roleLabel(item.roles, own.roleKey)}`
      : own.status === 'bench'
        ? `Benched · ${roleLabel(item.roles, own.roleKey)}`
        : 'Declined';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        own.status === 'confirmed' && 'bg-chart-2/15 text-chart-2',
        own.status === 'bench' && 'bg-live/15 text-live',
        own.status === 'declined' && 'bg-foreground/8 text-muted-foreground'
      )}
    >
      {text}
    </span>
  );
});

const AgendaCard = memo(({ item }: { item: TEventListItem }) => (
  <div
    className={cn(
      'surface-soft flex flex-col gap-2 rounded-xl bg-card p-3 ring-1 ring-white/[0.04]',
      item.status === 'cancelled' && 'opacity-70'
    )}
  >
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={() => openEvent(item.id)}
        className="min-w-0 flex-1 text-left text-[15px] font-semibold leading-5 text-foreground hover:underline"
      >
        {item.title}
      </button>
      <StatusPill status={item.status} />
    </div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <EventWhen event={item} withDate={false} />
      <GameTag tag={item.gameTag} />
      <HostLine hostId={item.hostId} />
    </div>
    <div className="flex flex-wrap items-center gap-1.5">
      {item.roles.map((role) => (
        <RolePill key={role.key} role={role} counts={item.counts} />
      ))}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <OwnStatusChip item={item} />
      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => openEvent(item.id)}
        >
          Details
        </Button>
        <QuickSignup item={item} />
      </div>
    </div>
  </div>
));

type TAgendaProps = {
  items: TEventListItem[];
  /** Local midnight of the day in focus; undefined = upcoming. */
  focusDay: number | undefined;
  now: number;
};

const Agenda = memo(({ items, focusDay, now }: TAgendaProps) => {
  const visible = useMemo(() => {
    if (focusDay !== undefined) {
      const day = windowForDay(focusDay);
      return items.filter((item) =>
        eventTouchesDay(item, { start: day.from, end: day.to + 1 })
      );
    }
    return items.filter((item) => item.endsAt >= now);
  }, [items, focusDay, now]);
  const groups = useMemo(() => groupByStartDay(visible), [visible]);

  return (
    <div className="view-enter flex flex-col gap-4">
      {focusDay !== undefined && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setPlannerFocusDay(undefined)}
          >
            <ChevronLeft className="h-4 w-4" />
            All upcoming
          </Button>
        </div>
      )}
      {groups.length === 0 && (
        <EmptyState
          icon={CalendarDays}
          title={
            focusDay !== undefined
              ? `Nothing on ${format(focusDay, 'EEEE d MMMM')}`
              : 'Nothing scheduled'
          }
          description={
            focusDay !== undefined
              ? 'Pick another day, or go back to everything upcoming.'
              : 'Upcoming events for the next month show up here.'
          }
        />
      )}
      {groups.map((group) => (
        <section key={group.dayStart} className="flex flex-col gap-2">
          <h3 className="flex items-baseline gap-2 px-1 text-sm font-semibold text-foreground">
            {isSameDay(group.dayStart, now)
              ? 'Today'
              : format(group.dayStart, 'EEEE')}
            <span className="text-xs font-normal text-muted-foreground">
              {format(group.dayStart, 'd MMM')}
            </span>
          </h3>
          {group.events.map((item) => (
            <AgendaCard key={item.id} item={item} />
          ))}
        </section>
      ))}
    </div>
  );
});

export { Agenda, OwnStatusChip };
