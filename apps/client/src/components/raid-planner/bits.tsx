import { relativeTime } from '@/features/events/calendar';
import {
  fillOf,
  PHASE_LABELS,
  roleCountLabel,
  type TEventPhase
} from '@/features/events/roster';
import { timeOnly } from '@/helpers/time-format';
import { useNow } from '@/hooks/use-now';
import { useReadableRoleColor } from '@/hooks/use-readable-role-color';
import { cn } from '@/lib/utils';
import type {
  TEvent,
  TEventRole,
  TEventRosterCounts
} from '@pulse/server/types';
import { format, isSameDay } from 'date-fns';
import { memo } from 'react';

/**
 * Small pieces shared by the chips, the agenda, the sheet and the chat
 * card, so a role reads the same everywhere: its colour as a tint, its
 * label as text (never colour alone), and its count beside it.
 */

type TRolePillProps = {
  role: TEventRole;
  counts?: TEventRosterCounts;
  /** Render as a button (role picker). */
  onClick?: () => void;
  selected?: boolean;
  disabled?: boolean;
  /** Extra text after the count ("bench"). */
  hint?: string;
  className?: string;
  title?: string;
};

const RolePill = memo(
  ({
    role,
    counts,
    onClick,
    selected,
    disabled,
    hint,
    className,
    title
  }: TRolePillProps) => {
    const color = useReadableRoleColor(role.color ?? undefined);
    const tint = role.color ?? 'var(--community)';
    const style = {
      backgroundColor: `color-mix(in oklab, ${tint} 18%, transparent)`,
      color: color ?? 'var(--foreground)',
      boxShadow: selected
        ? `inset 0 0 0 1.5px ${color ?? 'var(--community)'}`
        : undefined
    };
    const content = (
      <>
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: color ?? tint }}
        />
        <span className="truncate">{role.label}</span>
        {counts && (
          <span className="tabular-nums opacity-80">
            {roleCountLabel(role, counts)}
          </span>
        )}
        {hint && <span className="opacity-70">· {hint}</span>}
      </>
    );
    const base =
      'inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4';

    if (onClick) {
      return (
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-pressed={selected}
          title={title}
          style={style}
          className={cn(
            base,
            'lift cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
            className
          )}
        >
          {content}
        </button>
      );
    }
    return (
      <span style={style} className={cn(base, className)} title={title}>
        {content}
      </span>
    );
  }
);

type TFillBarProps = {
  event: Pick<TEvent, 'roles' | 'maxParticipants'>;
  counts: TEventRosterCounts;
  className?: string;
  /** Show "3/20" text next to the bar. */
  withLabel?: boolean;
};

/** How full the roster is: confirmed over the cap, as a thin bar. */
const FillBar = memo(
  ({ event, counts, className, withLabel }: TFillBarProps) => {
    const fill = fillOf(event.roles, counts, event.maxParticipants);
    const label =
      fill.cap === null
        ? `${fill.confirmed} signed up`
        : `${fill.confirmed}/${fill.cap}`;

    return (
      <span className={cn('flex min-w-0 items-center gap-1.5', className)}>
        {fill.ratio !== null && (
          <span
            role="progressbar"
            aria-label={`Roster ${fill.confirmed} of ${fill.cap}`}
            aria-valuemin={0}
            aria-valuemax={fill.cap ?? undefined}
            aria-valuenow={fill.confirmed}
            className="h-1 min-w-6 flex-1 overflow-hidden rounded-full bg-foreground/10"
          >
            <span
              className="block h-full rounded-full transition-[width] duration-300"
              style={{
                width: `${Math.round(fill.ratio * 100)}%`,
                backgroundColor:
                  fill.ratio >= 1 ? 'var(--live)' : 'var(--community)'
              }}
            />
          </span>
        )}
        {(withLabel || fill.ratio === null) && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {label}
          </span>
        )}
      </span>
    );
  }
);

const PHASE_CLASSES: Record<TEventPhase, string> = {
  scheduled: 'bg-foreground/8 text-muted-foreground',
  live: 'bg-live/15 text-live',
  done: 'bg-foreground/8 text-muted-foreground',
  cancelled: 'bg-destructive/12 text-destructive'
};

const StatusPill = memo(
  ({ status, className }: { status: TEventPhase; className?: string }) => (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
        PHASE_CLASSES[status],
        className
      )}
    >
      {status === 'live' && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-live"
        />
      )}
      {PHASE_LABELS[status]}
    </span>
  )
);

/** "Tue 20 Oct · 20:00–23:00 · in 2 h" — the end's date only when it differs. */
const whenText = (
  event: Pick<TEvent, 'startsAt' | 'endsAt'>,
  withDate: boolean
): string => {
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  const time = isSameDay(start, end)
    ? `${format(start, timeOnly())}–${format(end, timeOnly())}`
    : `${format(start, timeOnly())} – ${format(end, `EEE d MMM ${timeOnly()}`)}`;
  const parts = [withDate ? format(start, 'EEE d MMM') : null, time];
  return parts.filter(Boolean).join(' · ');
};

type TEventWhenProps = {
  event: Pick<TEvent, 'startsAt' | 'endsAt' | 'status'>;
  withDate?: boolean;
  withRelative?: boolean;
  className?: string;
};

const EventWhen = memo(
  ({
    event,
    withDate = true,
    withRelative = true,
    className
  }: TEventWhenProps) => {
    const now = useNow();
    const relative =
      withRelative && event.status === 'scheduled'
        ? relativeTime(event.startsAt, now)
        : withRelative && event.status === 'live'
          ? `ends ${relativeTime(event.endsAt, now)}`
          : null;
    return (
      <span className={cn('tabular-nums', className)}>
        {whenText(event, withDate)}
        {relative && (
          <span className="text-muted-foreground"> · {relative}</span>
        )}
      </span>
    );
  }
);

const GameTag = memo(({ tag }: { tag: string | null }) =>
  tag ? (
    <span className="inline-flex items-center rounded-md bg-foreground/8 px-1.5 py-0.5 text-[11px] font-medium text-foreground/80">
      {tag}
    </span>
  ) : null
);

export { EventWhen, FillBar, GameTag, RolePill, StatusPill };
