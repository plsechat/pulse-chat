import { useCan, useIsOwnUserOwner } from '@/features/server/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import type { IRootState } from '@/features/store';
import { useNow } from '@/hooks/use-now';
import type { TEvent } from '@pulse/server/types';
import { ChannelPermission, ChannelType, Permission } from '@pulse/shared';
import { useMemo } from 'react';
import { useSelector } from 'react-redux';
import { eventNeedsAttention } from './roster';
import {
  calendarUrlSelector,
  eventDetailSelector,
  eventEditorSelector,
  eventItemSelector,
  eventItemsSelector,
  eventWindowSelector,
  openEventIdSelector,
  plannerFocusDaySelector,
  plannerMonthStartSelector,
  plannerOpenSelector,
  plannerViewSelector,
  rosterTemplatesSelector
} from './selectors';

export const useEventItems = () => useSelector(eventItemsSelector);

export const useEventItem = (eventId: number) =>
  useSelector((state: IRootState) => eventItemSelector(state, eventId));

export const useEventDetail = (eventId: number) =>
  useSelector((state: IRootState) => eventDetailSelector(state, eventId));

export const useEventWindow = () => useSelector(eventWindowSelector);

export const useRosterTemplates = () => useSelector(rosterTemplatesSelector);

export const useCalendarUrl = () => useSelector(calendarUrlSelector);

export const usePlannerOpen = () => useSelector(plannerOpenSelector);

export const useOpenEventId = () => useSelector(openEventIdSelector);

export const useEventEditor = () => useSelector(eventEditorSelector);

export const usePlannerView = () => useSelector(plannerViewSelector);

export const usePlannerMonthStart = () =>
  useSelector(plannerMonthStartSelector);

export const usePlannerFocusDay = () => useSelector(plannerFocusDaySelector);

/** True while an event the viewer signed up for is live or about to start. */
export const useEventsNeedAttention = () => {
  const items = useEventItems();
  const now = useNow();
  return useMemo(
    () => items.some((item) => eventNeedsAttention(item, now)),
    [items, now]
  );
};

/** Host of the event, or a member holding MANAGE_EVENTS. */
export const useCanManageEvent = (
  event: Pick<TEvent, 'hostId'> | undefined
) => {
  const can = useCan();
  const ownUserId = useOwnUserId();
  if (!event) return false;
  return (
    (ownUserId !== undefined && event.hostId === ownUserId) ||
    can(Permission.MANAGE_EVENTS)
  );
};

/**
 * Text channels the viewer may read — the announce-channel choices.
 * Same rule as useChannelCan, applied across the list: the owner sees
 * everything; a channel absent from the permission map falls back to
 * its privacy flag.
 */
export const useViewableTextChannels = () => {
  const channels = useSelector((state: IRootState) => state.server.channels);
  const permissions = useSelector(
    (state: IRootState) => state.server.channelPermissions
  );
  const isOwner = useIsOwnUserOwner();
  return useMemo(
    () =>
      channels.filter((channel) => {
        if (channel.type !== ChannelType.TEXT) return false;
        if (isOwner) return true;
        const entry = permissions[channel.id]?.permissions;
        if (!entry) return !channel.private;
        return entry[ChannelPermission.VIEW_CHANNEL] !== false;
      }),
    [channels, permissions, isOwner]
  );
};
