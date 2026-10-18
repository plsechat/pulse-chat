import type { IRootState } from '@/features/store';
import type { TEventListItem } from '@pulse/server/types';
import { createSelector } from '@reduxjs/toolkit';
import type { TEventsServerState } from './slice';

export const eventsServerStateSelector = (
  state: IRootState
): TEventsServerState | undefined => {
  const key = state.server.serverId;
  return key ? state.events.byServer[key] : undefined;
};

const EMPTY_ITEMS: Record<number, TEventListItem> = {};

const itemsMapSelector = (state: IRootState) =>
  eventsServerStateSelector(state)?.items ?? EMPTY_ITEMS;

/** Every loaded row of the server in focus, soonest first. */
export const eventItemsSelector = createSelector([itemsMapSelector], (items) =>
  Object.values(items).sort((a, b) => a.startsAt - b.startsAt || a.id - b.id)
);

export const eventItemSelector = (state: IRootState, eventId: number) =>
  itemsMapSelector(state)[eventId];

export const eventDetailSelector = (state: IRootState, eventId: number) =>
  eventsServerStateSelector(state)?.details[eventId];

export const eventWindowSelector = (state: IRootState) =>
  eventsServerStateSelector(state)?.window ?? null;

export const rosterTemplatesSelector = (state: IRootState) =>
  eventsServerStateSelector(state)?.templates ?? null;

export const calendarUrlSelector = (state: IRootState) =>
  eventsServerStateSelector(state)?.calendarUrl ?? null;

/**
 * The planner is on screen when its row is selected for the server in
 * focus and no channel is: picking a channel row hides it (the row's
 * own click clears the channel), so the two selections never fight.
 */
export const plannerOpenSelector = (state: IRootState) =>
  state.events.plannerOpenFor !== undefined &&
  state.events.plannerOpenFor === state.server.serverId &&
  state.server.selectedChannelId === undefined;

export const openEventIdSelector = (state: IRootState) =>
  state.events.openEventId;

export const eventEditorSelector = (state: IRootState) => state.events.editor;

export const plannerViewSelector = (state: IRootState) => state.events.view;

export const plannerMonthStartSelector = (state: IRootState) =>
  state.events.monthStart;

export const plannerFocusDaySelector = (state: IRootState) =>
  state.events.focusDay;
