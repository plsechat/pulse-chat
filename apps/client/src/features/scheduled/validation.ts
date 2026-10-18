/**
 * The schedule picker's rules, mirrored from the server
 * (scheduled.create): a post goes out no sooner than 2 minutes and no
 * later than 30 days from now. The dialog validates before the call so
 * the message reads next to the field, not in a toast.
 */
export const MIN_SEND_LEAD_MS = 2 * 60 * 1000;
export const MAX_SEND_LEAD_MS = 30 * 24 * 60 * 60 * 1000;

export const validateSendAt = (sendAt: number | null, now: number): string | null => {
  if (sendAt === null || !Number.isFinite(sendAt)) return 'Pick a date and time';
  if (sendAt < now + MIN_SEND_LEAD_MS) return 'Pick a time at least 2 minutes from now';
  if (sendAt > now + MAX_SEND_LEAD_MS) return 'Pick a time within the next 30 days';
  return null;
};

/** The picker's starting value: the next full quarter hour at least 5 minutes out. */
export const defaultSendAt = (now: number): number => {
  const quarter = 15 * 60 * 1000;
  return Math.ceil((now + 5 * 60 * 1000) / quarter) * quarter;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** A timestamp as `<input type="datetime-local">` wants it, in local time. */
export const toLocalInputValue = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The input's value back to a timestamp; null when it is not a full date-time. */
export const fromLocalInputValue = (value: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
};
