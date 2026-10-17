import { Protect } from '@/components/protect';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import {
  fetchCalendarUrl,
  fetchEventsWindow,
  openEventEditor,
  setPlannerMonthStart,
  setPlannerView
} from '@/features/events/actions';
import {
  dayStartOf,
  monthStartOf,
  shiftMonth,
  windowForAgenda,
  windowForDay,
  windowForMonth
} from '@/features/events/calendar';
import {
  useCalendarUrl,
  useEventItems,
  usePlannerFocusDay,
  usePlannerMonthStart,
  usePlannerView
} from '@/features/events/hooks';
import { useCan, useConnectedServerPublicId } from '@/features/server/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useNow } from '@/hooks/use-now';
import { cn } from '@/lib/utils';
import { Permission } from '@pulse/shared';
import { format } from 'date-fns';
import {
  CalendarDays,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Link2
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Agenda } from './agenda';
import { MonthGrid } from './month-grid';

const VIEWS = [
  { id: 'month', label: 'Month' },
  { id: 'agenda', label: 'Agenda' }
] as const;

/** Copies the viewer's personal calendar feed link. */
const SubscribeButton = memo(() => {
  const cached = useCalendarUrl();
  const [busy, setBusy] = useState(false);

  const onClick = useCallback(async () => {
    setBusy(true);
    try {
      const url = cached ?? (await fetchCalendarUrl());
      if (!url) return;
      await navigator.clipboard.writeText(url);
      toast.success('Calendar link copied — add it to your calendar app');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to copy the calendar link'));
    } finally {
      setBusy(false);
    }
  }, [cached]);

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onClick}
      disabled={busy}
      title="Copy a calendar feed link for this server's events"
    >
      <Link2 className="h-4 w-4" />
      <span className="hidden sm:inline">Subscribe</span>
    </Button>
  );
});

/**
 * The Raid Planner app: a month grid or an agenda over the server's
 * events, with the event sheet and editor mounted by the content
 * wrapper so they also open from a chat card.
 */
const RaidPlanner = memo(() => {
  const isMobile = useIsMobile();
  const chosenView = usePlannerView();
  const view = chosenView ?? (isMobile ? 'agenda' : 'month');
  const now = useNow();
  const thisMonth = monthStartOf(now);
  const monthStart = usePlannerMonthStart() ?? thisMonth;
  const focusDay = usePlannerFocusDay();
  const items = useEventItems();
  const serverKey = useConnectedServerPublicId();
  const can = useCan();
  const canManage = can(Permission.MANAGE_EVENTS);

  // `now` ticks every minute; the agenda's range only moves at midnight.
  const today = dayStartOf(now);
  const range = useMemo(() => {
    if (view === 'month') return windowForMonth(monthStart);
    if (focusDay !== undefined) return windowForDay(focusDay);
    return windowForAgenda(today);
  }, [view, monthStart, focusDay, today]);

  useEffect(() => {
    if (!serverKey) return;
    void fetchEventsWindow(range.from, range.to);
  }, [serverKey, range.from, range.to]);

  const monthItems = useMemo(
    () =>
      items.filter(
        (item) => item.startsAt <= range.to && item.endsAt >= range.from
      ),
    [items, range.from, range.to]
  );

  const onNewEvent = useCallback(() => {
    const start = new Date(Math.max(now, focusDay ?? 0));
    if (focusDay !== undefined && focusDay > now) start.setHours(20, 0, 0, 0);
    else {
      // Next full hour, so the default is never in the past.
      start.setMinutes(0, 0, 0);
      start.setHours(start.getHours() + 1);
    }
    openEventEditor({ mode: 'create', startsAt: start.getTime() });
  }, [now, focusDay]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 md:px-4">
        <span className="channel-tile flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
          <CalendarDays className="h-4 w-4" />
        </span>
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          Raid Planner
        </h2>

        {view === 'month' && (
          <div className="ml-1 flex items-center gap-0.5">
            <IconButton
              variant="ghost"
              size="sm"
              icon={ChevronLeft}
              aria-label="Previous month"
              onClick={() => setPlannerMonthStart(shiftMonth(monthStart, -1))}
              className="h-7 w-7 rounded-md hover:bg-accent"
            />
            <span className="min-w-[8.5rem] text-center text-sm font-medium tabular-nums text-foreground">
              {format(monthStart, 'LLLL yyyy')}
            </span>
            <IconButton
              variant="ghost"
              size="sm"
              icon={ChevronRight}
              aria-label="Next month"
              onClick={() => setPlannerMonthStart(shiftMonth(monthStart, 1))}
              className="h-7 w-7 rounded-md hover:bg-accent"
            />
          </div>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          // Back to this month and, in the agenda, to everything upcoming.
          onClick={() => setPlannerMonthStart(undefined)}
          disabled={monthStart === thisMonth && focusDay === undefined}
        >
          Today
        </Button>

        <div
          role="group"
          aria-label="View"
          className="ml-auto inline-flex h-8 items-center rounded-lg bg-muted p-[3px] text-muted-foreground"
        >
          {VIEWS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={view === option.id}
              onClick={() => setPlannerView(option.id)}
              className={cn(
                'h-full rounded-md px-2.5 text-xs font-medium transition-colors',
                view === option.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'hover:text-foreground'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <SubscribeButton />
        <Protect permission={Permission.MANAGE_EVENTS}>
          <Button type="button" size="sm" onClick={onNewEvent}>
            <CalendarPlus className="h-4 w-4" />
            New event
          </Button>
        </Protect>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
        {view === 'month' ? (
          <MonthGrid
            monthStart={monthStart}
            items={monthItems}
            now={now}
            compact={isMobile}
            canCreate={canManage}
          />
        ) : (
          <Agenda items={items} focusDay={focusDay} now={now} />
        )}
      </div>
    </div>
  );
});

export { RaidPlanner };
