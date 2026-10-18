import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  startOfDay,
  startOfMonth,
  startOfWeek
} from 'date-fns';

/**
 * Calendar arithmetic for the planner, all in the viewer's local time
 * zone: a "day" on the grid is a local day, and the window sent to the
 * server (`events.list`, UTC epoch ms) is the epoch of those local
 * boundaries, so an event at 00:30 local lands on the right square
 * whatever the zone's offset. Weeks start on Monday.
 */

const WEEK_STARTS_ON = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type TGridDay = {
  /** Local midnight, epoch ms. */
  start: number;
  /** Local midnight of the next day, epoch ms (exclusive end). */
  end: number;
  inMonth: boolean;
  dayOfMonth: number;
};

export type TWindow = { from: number; to: number };

/** Local midnight of the month containing `ms`. */
export const monthStartOf = (ms: number): number =>
  startOfMonth(new Date(ms)).getTime();

export const shiftMonth = (monthStart: number, by: number): number =>
  startOfMonth(addMonths(new Date(monthStart), by)).getTime();

/** Local midnight of the day containing `ms`. */
export const dayStartOf = (ms: number): number =>
  startOfDay(new Date(ms)).getTime();

/**
 * The squares of a month grid: whole weeks from the one holding the 1st
 * to the one holding the last day, so the grid is 4 to 6 rows and every
 * row is a full week. Out-of-month squares are flagged, not dropped.
 */
export const monthGridDays = (monthStart: number): TGridDay[] => {
  const first = startOfMonth(new Date(monthStart));
  const month = first.getMonth();
  const gridStart = startOfWeek(first, { weekStartsOn: WEEK_STARTS_ON });
  const gridEnd = endOfWeek(endOfMonth(first), {
    weekStartsOn: WEEK_STARTS_ON
  });

  const days: TGridDay[] = [];
  for (
    let day = gridStart;
    day.getTime() <= gridEnd.getTime();
    day = addDays(day, 1)
  ) {
    days.push({
      start: day.getTime(),
      end: addDays(day, 1).getTime(),
      inMonth: day.getMonth() === month,
      dayOfMonth: day.getDate()
    });
  }
  return days;
};

/** The list window that covers every square of the month grid. */
export const windowForMonth = (monthStart: number): TWindow => {
  const days = monthGridDays(monthStart);
  return { from: days[0]!.start, to: days[days.length - 1]!.end - 1 };
};

/** The list window for one local day. */
export const windowForDay = (dayStart: number): TWindow => ({
  from: dayStart,
  to: addDays(new Date(dayStart), 1).getTime() - 1
});

/** The agenda's default range: from today's local midnight, 31 days. */
export const windowForAgenda = (now: number): TWindow => {
  const from = dayStartOf(now);
  return { from, to: addDays(new Date(from), 31).getTime() - 1 };
};

/** True when the event touches the local day `[start, end)`. */
export const eventTouchesDay = (
  event: { startsAt: number; endsAt: number },
  day: { start: number; end: number }
): boolean => event.startsAt < day.end && event.endsAt > day.start;

/**
 * Events grouped by the local day they START on, in start order. An
 * event spanning midnight is listed once, under its first day; the
 * month grid uses `eventTouchesDay` to also mark the days it runs into.
 */
export const groupByStartDay = <T extends { startsAt: number; id: number }>(
  events: T[]
): { dayStart: number; events: T[] }[] => {
  const groups = new Map<number, T[]>();
  for (const event of [...events].sort(
    (a, b) => a.startsAt - b.startsAt || a.id - b.id
  )) {
    const key = dayStartOf(event.startsAt);
    const list = groups.get(key);
    if (list) list.push(event);
    else groups.set(key, [event]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dayStart, list]) => ({ dayStart, events: list }));
};

/**
 * Short relative distance to a moment: "in 2 h", "in 35 min", "3 d
 * ago". Minutes below an hour, hours below two days, days beyond.
 */
export const relativeTime = (target: number, now: number): string => {
  const diff = target - now;
  const abs = Math.abs(diff);
  const future = diff >= 0;
  let text: string;
  if (abs < 60_000) text = 'now';
  else if (abs < HOUR_MS) text = `${Math.round(abs / 60_000)} min`;
  else if (abs < 2 * DAY_MS) {
    const hours = abs / HOUR_MS;
    text =
      hours < 10 && hours % 1 >= 0.25 && hours % 1 < 0.75
        ? `${Math.floor(hours)}.5 h`
        : `${Math.round(hours)} h`;
  } else text = `${Math.round(abs / DAY_MS)} d`;
  if (text === 'now') return 'now';
  return future ? `in ${text}` : `${text} ago`;
};

/** Combines a local day (midnight ms) with "HH:mm" into an epoch ms. */
export const combineDayAndTime = (dayStart: number, time: string): number => {
  const [h, m] = time.split(':').map((part) => Number(part));
  const date = new Date(dayStart);
  date.setHours(h || 0, m || 0, 0, 0);
  return date.getTime();
};

/** "HH:mm" (24 h) of a moment in local time, for `<input type="time">`. */
export const timeInputValue = (ms: number): string => {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export { DAY_MS, HOUR_MS };
