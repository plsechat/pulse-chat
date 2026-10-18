import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { UserAvatar } from '@/components/user-avatar';
import {
  mergePollUpdate,
  pollBars,
  pollDeadlineLabel,
  voterPreview
} from '@/features/polls/math';
import { useCan, usePreviewMode } from '@/features/server/hooks';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useNow } from '@/hooks/use-now';
import { onAppEvent } from '@/lib/events';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TPollOptionView, TPollView } from '@pulse/server/types';
import { Permission } from '@pulse/shared';
import { BarChart3, Check, Lock } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

type TPollCardProps = {
  messageId: number;
  /** The poll's question — the message content, shown before the view loads. */
  question: string | null;
};

const VoterName = memo(({ userId }: { userId: number }) => {
  const user = useUserById(userId);
  return <>{getDisplayName(user)}</>;
});

/** The small avatar stack on a bar; the full list on hover. */
const Voters = memo(({ option }: { option: TPollOptionView }) => {
  const { shown, more } = voterPreview(option);
  if (shown.length === 0) return null;

  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-0.5">
          {shown.map((id) => (
            <VoterName key={id} userId={id} />
          ))}
          {more > 0 && <span>and {more} more</span>}
        </span>
      }
    >
      <span className="flex items-center -space-x-1.5" aria-hidden="true">
        {shown.map((id) => (
          <UserAvatar key={id} userId={id} className="h-4 w-4 ring-1 ring-card" showStatusBadge={false} noDecoration />
        ))}
        {more > 0 && (
          <span className="ml-2 text-[10px] text-muted-foreground">+{more}</span>
        )}
      </span>
    </Tooltip>
  );
});

/**
 * A poll message: the question, one bar per option (vote by clicking
 * it), counts that follow POLL_UPDATE live, and the close control for
 * the author or a moderator. Single choice renders as radios, multiple
 * as checkboxes, so the keyboard and screen readers get the real
 * semantics of the choice.
 */
const PollCard = memo(({ messageId, question }: TPollCardProps) => {
  const [poll, setPoll] = useState<TPollView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ownUserId = useOwnUserId();
  const can = useCan();
  const previewMode = usePreviewMode();
  const now = useNow();

  useEffect(() => {
    let cancelled = false;
    const trpc = getTRPCClient();
    if (!trpc) return;
    trpc.polls.get
      .query({ messageId })
      .then((view) => {
        if (!cancelled) setPoll(view);
      })
      .catch((err) => {
        if (!cancelled) setError(getTrpcError(err, 'Could not load the poll'));
      });
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  useEffect(
    () =>
      onAppEvent('poll-updated', (update) => {
        if (update.messageId !== messageId) return;
        setPoll((current) => (current ? mergePollUpdate(current, update) : current));
      }),
    [messageId]
  );

  const closed = poll !== null && poll.closedAt !== null;
  const canVote = poll !== null && !closed && !previewMode;
  const canClose =
    poll !== null &&
    !closed &&
    !previewMode &&
    (poll.createdBy === ownUserId || can(Permission.MANAGE_MESSAGES));

  const toggle = useCallback(
    async (optionKey: string) => {
      if (!poll || !canVote || busy) return;
      const trpc = getTRPCClient();
      if (!trpc) return;
      const voted = poll.ownVotes.includes(optionKey);
      setBusy(true);
      try {
        const next = voted
          ? await trpc.polls.unvote.mutate({ pollId: poll.id, optionKey })
          : await trpc.polls.vote.mutate({ pollId: poll.id, optionKey });
        setPoll(next);
      } catch (err) {
        toast.error(getTrpcError(err, 'Could not record your vote'));
      } finally {
        setBusy(false);
      }
    },
    [poll, canVote, busy]
  );

  const closePoll = useCallback(async () => {
    if (!poll) return;
    const trpc = getTRPCClient();
    if (!trpc) return;
    setBusy(true);
    try {
      setPoll(await trpc.polls.close.mutate({ pollId: poll.id }));
    } catch (err) {
      toast.error(getTrpcError(err, 'Could not close the poll'));
    } finally {
      setBusy(false);
    }
  }, [poll]);

  const title = poll?.question ?? question ?? 'Poll';
  const bars = poll ? pollBars(poll) : [];
  const deadline = poll ? pollDeadlineLabel(poll.closesAt, poll.closedAt, now) : null;
  const role = poll?.multiple ? 'checkbox' : 'radio';

  return (
    <div
      className="poll-card mt-1 max-w-xl rounded-xl border border-border/70 bg-card/60 p-3"
      role="group"
      aria-label={`Poll: ${title}`}
      data-testid="poll-card"
    >
      <div className="flex items-start gap-2">
        <BarChart3 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug break-words">{title}</p>
          {poll && (
            <p className="text-xs text-muted-foreground">
              {poll.multiple ? 'Pick any' : 'Pick one'}
              {poll.anonymous ? ' · anonymous' : ''}
            </p>
          )}
        </div>
      </div>

      {error && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {poll && (
        <div
          className="mt-3 flex flex-col gap-1.5"
          role={poll.multiple ? 'group' : 'radiogroup'}
          aria-label="Options"
        >
          {bars.map((bar) => {
            const option = poll.options.find((o) => o.key === bar.key)!;
            const mine = poll.ownVotes.includes(bar.key);
            return (
              <button
                key={bar.key}
                type="button"
                role={role}
                aria-checked={mine}
                aria-disabled={!canVote}
                disabled={!canVote || busy}
                onClick={() => void toggle(bar.key)}
                className={cn(
                  'relative w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  mine ? 'border-primary/60' : 'border-border/60',
                  canVote && 'hover:border-primary/40',
                  !canVote && 'cursor-default'
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute inset-y-0 left-0 transition-[width] duration-300',
                    bar.leading ? 'bg-primary/20' : 'bg-foreground/[0.06]'
                  )}
                  style={{ width: `${bar.percent}%` }}
                />
                <span className="relative flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center border',
                      poll.multiple ? 'rounded' : 'rounded-full',
                      mine ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50'
                    )}
                  >
                    {mine && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{bar.label}</span>
                  <Voters option={option} />
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                    {bar.percent}%
                    <span className="sr-only">
                      , {bar.votes} vote{bar.votes === 1 ? '' : 's'}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {poll && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {poll.totalVoters} vote{poll.totalVoters === 1 ? '' : 's'}
          </span>
          {deadline && (
            <span className="flex items-center gap-1">
              {closed && <Lock className="h-3 w-3" aria-hidden="true" />}
              {deadline}
            </span>
          )}
          {canClose && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 px-2 text-xs"
              onClick={() => void closePoll()}
              disabled={busy}
            >
              Close poll
            </Button>
          )}
        </div>
      )}
    </div>
  );
});

export { PollCard };
