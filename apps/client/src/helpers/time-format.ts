import { getTimeFormat } from '@/hooks/use-appearance-settings';
import { format, isSameDay, subDays } from 'date-fns';

const is24h = () => getTimeFormat() === '24h';

/** Time only: "3:45 PM" / "15:45" */
export const timeOnly = () => (is24h() ? 'HH:mm' : 'h:mm a');

/** Date + time: "01/15/2025 3:45 PM" / "01/15/2025 15:45" */
export const dateTime = () =>
  is24h() ? 'MM/dd/yyyy HH:mm' : 'MM/dd/yyyy h:mm a';

/** Long date + time: "Jan 15, 2025 3:45 PM" / "Jan 15, 2025 15:45" */
export const longDateTime = () =>
  is24h() ? 'MMM d, yyyy HH:mm' : 'MMM d, yyyy h:mm a';

/** Full date + time (tooltips): "January 15, 2025, 3:45 PM" / "January 15, 2025 15:45" */
export const fullDateTime = () => (is24h() ? 'PPP HH:mm' : 'PPpp');

/** Date + time (tables): "January 15, 2025 3:45 PM" / "January 15, 2025 15:45" */
export const datePlusTime = () => (is24h() ? 'PPP HH:mm' : 'PPP p');

/**
 * Message-group header timestamp: "Today at 3:45 PM" / "Yesterday at
 * …" / "01/15/2025 3:45 PM". Shared verbatim by the channel and DM
 * group headers.
 */
export const groupTimestamp = (date: Date, now: Date = new Date()): string => {
  // Inside the last hour the age reads better than the clock; the
  // tooltip keeps the full date. `now` is injectable so rows can share
  // one minute tick (hooks/use-now) and tests stay fixed.
  const ageMs = now.getTime() - date.getTime();
  if (ageMs >= 0 && ageMs < 60 * 60_000) {
    const mins = Math.floor(ageMs / 60_000);
    return mins < 1 ? 'just now' : `${mins} min ago`;
  }
  return isSameDay(date, now)
    ? `Today at ${format(date, timeOnly())}`
    : isSameDay(date, subDays(now, 1))
      ? `Yesterday at ${format(date, timeOnly())}`
      : format(date, dateTime());
};
