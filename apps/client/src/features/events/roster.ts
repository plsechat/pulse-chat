import type {
  TEvent,
  TEventListItem,
  TEventRole,
  TEventRosterCounts,
  TEventSignup
} from '@pulse/server/types';

/**
 * Roster arithmetic shared by the chips, the cards and the sheet. Pure
 * functions over the server's types so the numbers on a month chip and
 * in the sheet can never disagree.
 */

const HOUR_MS = 60 * 60 * 1000;

export type TFill = {
  confirmed: number;
  /** Null when the roster is open-ended (an uncapped role and no participant cap). */
  cap: number | null;
  /** 0..1, or null when there is no cap to fill. */
  ratio: number | null;
};

/**
 * How full an event is. The ceiling is the sum of the role caps,
 * lowered to `maxParticipants` when that is tighter; one uncapped role
 * makes the sum open-ended, and then only the participant cap counts.
 */
export const fillOf = (
  roles: TEventRole[],
  counts: Pick<TEventRosterCounts, 'confirmed'>,
  maxParticipants: number | null
): TFill => {
  const uncapped = roles.some((role) => role.cap === null);
  const roleSum = uncapped
    ? null
    : roles.reduce((sum, role) => sum + (role.cap ?? 0), 0);
  let cap: number | null = roleSum;
  if (maxParticipants !== null) {
    cap = cap === null ? maxParticipants : Math.min(cap, maxParticipants);
  }
  return {
    confirmed: counts.confirmed,
    cap,
    ratio:
      cap === null || cap === 0 ? null : Math.min(1, counts.confirmed / cap)
  };
};

/** "3/6" or "3" for an uncapped role. */
export const roleCountLabel = (
  role: TEventRole,
  counts: TEventRosterCounts
): string => {
  const confirmed = counts.byRole[role.key]?.confirmed ?? 0;
  return role.cap === null ? String(confirmed) : `${confirmed}/${role.cap}`;
};

export const roleIsFull = (
  role: TEventRole,
  counts: TEventRosterCounts
): boolean =>
  role.cap !== null && (counts.byRole[role.key]?.confirmed ?? 0) >= role.cap;

/** The roles in the order the event declares them; the roster grid follows it. */
export const roleOrder = (roles: TEventRole[]): TEventRole[] => [...roles];

/** Bench order = promotion order: position first, then the older signup. */
export const orderBench = (bench: TEventSignup[]): TEventSignup[] =>
  [...bench].sort(
    (a, b) =>
      a.position - b.position || a.createdAt - b.createdAt || a.id - b.id
  );

/** Confirmed rows of one role in the order they were placed. */
export const orderConfirmed = (signups: TEventSignup[]): TEventSignup[] =>
  [...signups].sort(
    (a, b) =>
      a.position - b.position || a.createdAt - b.createdAt || a.id - b.id
  );

export const roleByKey = (
  roles: TEventRole[],
  key: string
): TEventRole | undefined => roles.find((role) => role.key === key);

/** A readable label for a signup's role even after the role was removed. */
export const roleLabel = (roles: TEventRole[], key: string): string =>
  roleByKey(roles, key)?.label ?? key;

export type TEventPhase = TEvent['status'];

export const PHASE_LABELS: Record<TEventPhase, string> = {
  scheduled: 'Scheduled',
  live: 'Live',
  done: 'Done',
  cancelled: 'Cancelled'
};

/** Signups and edits are only accepted while the event is open. */
export const eventIsOpen = (event: Pick<TEvent, 'status'>): boolean =>
  event.status === 'scheduled' || event.status === 'live';

/** Signed up = holding a confirmed or bench slot. */
export const isSignedUp = (ownSignup: TEventListItem['ownSignup']): boolean =>
  ownSignup?.status === 'confirmed' || ownSignup?.status === 'bench';

/**
 * The Apps row's dot: an event the viewer signed up for is live or
 * starts within the hour.
 */
export const eventNeedsAttention = (
  item: TEventListItem,
  now: number
): boolean => {
  if (!isSignedUp(item.ownSignup)) return false;
  if (item.status === 'live') return true;
  if (item.status !== 'scheduled') return false;
  const untilStart = item.startsAt - now;
  return untilStart <= HOUR_MS && item.endsAt > now;
};

/**
 * The subscription link: absolute from the server when it knows its
 * public origin, else the path, which belongs on this client's origin
 * (the API origin).
 */
export const resolveCalendarUrl = (
  result: { path: string; url: string },
  origin: string
): string =>
  result.url === result.path ? `${origin}${result.path}` : result.url;

const REMINDER_PHRASES: Record<1 | 2 | 3, string> = {
  1: 'starts in 24 hours',
  2: 'starts in 1 hour',
  3: 'is starting now'
};

export const reminderText = (title: string, stage: 1 | 2 | 3): string =>
  `${title} ${REMINDER_PHRASES[stage] ?? 'is coming up'}`;

export const reminderKey = (payload: {
  serverId: number;
  eventId: number;
  stage: number;
}): string => `${payload.serverId}:${payload.eventId}:${payload.stage}`;
