import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getTRPCClient } from '@/lib/trpc';
import { store } from '../store';
import { fetchEventDetail, handleEventReminder } from './actions';
import { eventsSliceActions } from './slice';
import { refreshUpcomingEvents } from './upcoming';

/**
 * Event fan-out reaches every member of the server, on the instance the
 * subscription is bound to. Only the server in focus is filed: its
 * publicId is the slice key, and `app.activeServerId` is its numeric id
 * in that instance's id space. Another server's rows are fetched fresh
 * when it comes into focus, so nothing is lost by ignoring them here.
 * The Home overview's cross-community list is the exception: any
 * change on the home socket refreshes it, whichever server it is for.
 */
const keyFor = (serverId: number): string | undefined => {
  const { app, server } = store.getState();
  if (server.previewMode) return undefined;
  if (app.activeServerId !== serverId) return undefined;
  return server.serverId;
};

const subscribeToEvents = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    subscribe('onEventCreate', trpc.events.onEventCreate, (event) => {
      refreshUpcomingEvents();
      const serverKey = keyFor(event.serverId);
      if (serverKey) {
        store.dispatch(eventsSliceActions.upsertEvent({ serverKey, event }));
      }
    }),
    subscribe('onEventUpdate', trpc.events.onEventUpdate, (event) => {
      refreshUpcomingEvents();
      const serverKey = keyFor(event.serverId);
      if (serverKey) {
        store.dispatch(eventsSliceActions.upsertEvent({ serverKey, event }));
      }
    }),
    subscribe(
      'onEventDelete',
      trpc.events.onEventDelete,
      ({ eventId, serverId }) => {
        refreshUpcomingEvents();
        const serverKey = keyFor(serverId);
        if (serverKey) {
          store.dispatch(
            eventsSliceActions.removeEvent({ serverKey, eventId })
          );
        }
      }
    ),
    subscribe(
      'onEventSignupsUpdate',
      trpc.events.onEventSignupsUpdate,
      ({ eventId, serverId, counts }) => {
        refreshUpcomingEvents();
        const serverKey = keyFor(serverId);
        if (!serverKey) return;
        store.dispatch(
          eventsSliceActions.setSignupCounts({ serverKey, eventId, counts })
        );
        // The counts cover the chips; a loaded roster (an open sheet, a
        // card that expanded) needs the rows themselves.
        if (store.getState().events.byServer[serverKey]?.details[eventId]) {
          void fetchEventDetail(eventId);
        }
      }
    ),
    subscribe('onEventReminder', trpc.events.onEventReminder, (payload) =>
      handleEventReminder(payload)
    )
  );
};

export { subscribeToEvents };
