import {
  openEvent,
  openEventEditor,
  setPlannerFocusDay
} from '@/features/events/actions';
import {
  dayStartOf,
  eventTouchesDay,
  monthGridDays,
  type TGridDay
} from '@/features/events/calendar';
import { timeOnly } from '@/helpers/time-format';
import { cn } from '@/lib/utils';
import type { TEventListItem } from '@pulse/server/types';
import { format, isSameDay } from 'date-fns';
import { memo, useMemo } from 'react';
import { FillBar } from './bits';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CHIPS_PER_CELL = 3;
/** A new event from an empty square starts at 20:00 local — raid o'clock. */
const DEFAULT_START_HOUR = 20;

type TChipProps = { item: TEventListItem };

const EventChip = memo(({ item }: TChipProps) => {
  const tint = item.roles[0]?.color ?? 'var(--community)';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openEvent(item.id);
      }}
      className={cn(
        'lift flex w-full min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1 text-left text-[11px] leading-tight text-foreground',
        item.status === 'cancelled' && 'line-through opacity-60'
      )}
      style={{
        backgroundColor: `color-mix(in oklab, ${tint} 16%, transparent)`,
        boxShadow: `inset 2px 0 0 0 ${tint}`
      }}
    >
      <span className="flex min-w-0 items-baseline gap-1">
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {format(item.startsAt, timeOnly())}
        </span>
        <span className="truncate font-medium">{item.title}</span>
      </span>
      {item.status !== 'cancelled' && (
        <FillBar event={item} counts={item.counts} />
      )}
    </button>
  );
});

type TDayCellProps = {
  day: TGridDay;
  events: TEventListItem[];
  isToday: boolean;
  /** Before today: nothing new can start here (the server refuses a past start). */
  isPast: boolean;
  compact: boolean;
  canCreate: boolean;
};

const DayCell = memo(
  ({ day, events, isToday, isPast, compact, canCreate }: TDayCellProps) => {
    const label = `${format(day.start, 'EEEE d MMMM')}, ${
      events.length === 0
        ? 'no events'
        : `${events.length} event${events.length === 1 ? '' : 's'}`
    }`;
    const creatable = events.length === 0 && canCreate && !isPast;

    const onPick = () => {
      if (events.length > 0) {
        setPlannerFocusDay(day.start);
      } else if (creatable) {
        const start = new Date(day.start);
        start.setHours(DEFAULT_START_HOUR, 0, 0, 0);
        openEventEditor({ mode: 'create', startsAt: start.getTime() });
      }
    };

    return (
      <div
        role="gridcell"
        className={cn(
          'flex min-h-16 flex-col gap-1 rounded-lg p-1 transition-colors md:min-h-24',
          day.inMonth ? 'bg-foreground/[0.03]' : 'opacity-45',
          isToday && 'ring-1 ring-inset ring-[color:var(--community)]'
        )}
      >
        <button
          type="button"
          onClick={onPick}
          aria-label={label}
          aria-disabled={events.length === 0 && !creatable ? true : undefined}
          title={creatable ? 'New event on this day' : undefined}
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center self-start rounded-full text-xs tabular-nums',
            (events.length > 0 || creatable) && 'hover:bg-accent',
            events.length === 0 && !creatable && 'cursor-default',
            isToday
              ? 'bg-[color:var(--community)] font-semibold text-background'
              : 'text-muted-foreground'
          )}
        >
          {day.dayOfMonth}
        </button>
        {compact ? (
          events.length > 0 && (
            <button
              type="button"
              onClick={onPick}
              aria-label={`Show ${events.length} event${events.length === 1 ? '' : 's'}`}
              className="flex flex-wrap gap-0.5 px-0.5"
            >
              {events.slice(0, 4).map((item) => (
                <span
                  key={item.id}
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    backgroundColor: item.roles[0]?.color ?? 'var(--community)'
                  }}
                />
              ))}
            </button>
          )
        ) : (
          <>
            {events.slice(0, CHIPS_PER_CELL).map((item) => (
              <EventChip key={item.id} item={item} />
            ))}
            {events.length > CHIPS_PER_CELL && (
              <button
                type="button"
                onClick={onPick}
                className="px-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
              >
                +{events.length - CHIPS_PER_CELL} more
              </button>
            )}
          </>
        )}
      </div>
    );
  }
);

type TMonthGridProps = {
  monthStart: number;
  items: TEventListItem[];
  now: number;
  /** Phones: dots instead of chips so seven columns fit in 360 px. */
  compact: boolean;
  canCreate: boolean;
};

const MonthGrid = memo(
  ({ monthStart, items, now, compact, canCreate }: TMonthGridProps) => {
    const days = useMemo(() => monthGridDays(monthStart), [monthStart]);
    const today = dayStartOf(now);
    const byDay = useMemo(
      () =>
        days.map((day) =>
          items
            .filter((item) => eventTouchesDay(item, day))
            .sort((a, b) => a.startsAt - b.startsAt)
        ),
      [days, items]
    );
    const weeks = useMemo(() => {
      const rows: number[][] = [];
      for (let i = 0; i < days.length; i += 7) {
        rows.push(days.slice(i, i + 7).map((_, j) => i + j));
      }
      return rows;
    }, [days]);

    return (
      <div
        role="grid"
        aria-label={format(monthStart, 'LLLL yyyy')}
        className="view-enter flex flex-col gap-1"
      >
        <div role="row" className="grid grid-cols-7 gap-1 px-1">
          {WEEKDAYS.map((name) => (
            <div
              key={name}
              role="columnheader"
              className="text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              {name}
            </div>
          ))}
        </div>
        {weeks.map((row, r) => (
          <div key={r} role="row" className="grid grid-cols-7 gap-1">
            {row.map((index) => {
              const day = days[index]!;
              return (
                <DayCell
                  key={day.start}
                  day={day}
                  events={byDay[index]!}
                  isToday={isSameDay(day.start, now)}
                  isPast={day.start < today}
                  compact={compact}
                  canCreate={canCreate}
                />
              );
            })}
          </div>
        ))}
      </div>
    );
  }
);

export { MonthGrid };
