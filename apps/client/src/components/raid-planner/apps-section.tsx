import { IconButton } from '@/components/ui/icon-button';
import { fetchEventsWindow, openRaidPlanner } from '@/features/events/actions';
import { HOUR_MS } from '@/features/events/calendar';
import {
  useEventsNeedAttention,
  useEventWindow,
  usePlannerOpen
} from '@/features/events/hooks';
import {
  useConnectedServerPublicId,
  usePlannerEnabled,
  usePreviewMode
} from '@/features/server/hooks';
import { cn } from '@/lib/utils';
import { CalendarDays, ChevronDown, ChevronRight } from 'lucide-react';
import { memo, useEffect, useState } from 'react';

/**
 * The Apps block at the top of the channel list: first-party apps of
 * the community, each a row styled like a channel. The Planner is the
 * first; the row carries a dot while an event the viewer signed up for
 * is live or starts within the hour.
 */
const AppsSection = memo(() => {
  const [expanded, setExpanded] = useState(true);
  const selected = usePlannerOpen();
  const attention = useEventsNeedAttention();
  const previewMode = usePreviewMode();
  const plannerEnabled = usePlannerEnabled();
  const serverKey = useConnectedServerPublicId();
  const windowLoaded = useEventWindow() !== null;

  // The dot needs the next hour's events even when the planner was
  // never opened: load a day around now once per server. The planner
  // widens this to its month when it opens. With the Planner switched
  // off the list route refuses, so nothing is asked for.
  useEffect(() => {
    if (previewMode || !plannerEnabled || !serverKey || windowLoaded) return;
    const now = Date.now();
    void fetchEventsWindow(now - 12 * HOUR_MS, now + 36 * HOUR_MS);
  }, [previewMode, plannerEnabled, serverKey, windowLoaded]);

  // A preview is a read-only snapshot of a server the viewer has not
  // joined; its events are members-only. A community that switched the
  // Planner off has no row to show.
  if (previewMode || !plannerEnabled) return null;

  const ChevronIcon = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="mb-4">
      <div className="mb-1 flex w-full items-center px-2 py-1 text-xs font-medium text-muted-foreground/80">
        <div className="flex w-full items-center gap-1">
          <IconButton
            variant="ghost"
            size="sm"
            icon={ChevronIcon}
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Collapse apps' : 'Expand apps'}
          />
          <span>Apps</span>
        </div>
      </div>
      {expanded && (
        <div className="space-y-0.5">
          <button
            type="button"
            onClick={openRaidPlanner}
            aria-current={selected ? 'page' : undefined}
            className={cn(
              'relative flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors duration-150 select-none hover:bg-accent/60 hover:text-foreground',
              selected && 'channel-row-active font-medium text-foreground',
              attention && !selected && 'font-semibold text-foreground'
            )}
          >
            <span className="channel-tile flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
              <CalendarDays className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1 truncate">Planner</span>
            {attention && (
              <span className="badge-pop ml-auto flex h-5 items-center">
                <span aria-hidden className="h-2 w-2 rounded-full bg-live" />
                <span className="sr-only">an event you joined starts soon</span>
              </span>
            )}
          </button>
        </div>
      )}
    </div>
  );
});

export { AppsSection };
