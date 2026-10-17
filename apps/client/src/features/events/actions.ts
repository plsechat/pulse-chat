import { switchServer, switchToFederatedServer } from '@/features/app/actions';
import { sendDesktopNotification } from '@/features/notifications/desktop-notification';
import { getHandshakeHash } from '@/features/server/actions';
import { setSelectedChannelId } from '@/features/server/channels/actions';
import { emitAppEvent } from '@/lib/events';
import { NotConnectedError } from '@/lib/not-connected-error';
import { getTRPCClient } from '@/lib/trpc';
import type { TEventRole, TEventRosterTemplate } from '@pulse/server/types';
import { toast } from 'sonner';
import { store } from '../store';
import { reminderKey, reminderText, resolveCalendarUrl } from './roster';
import {
  eventsSliceActions,
  type TEventEditor,
  type TPlannerView
} from './slice';

/**
 * Every call goes to the instance in focus (`getTRPCClient`), because
 * events belong to the server in focus — a federated one included —
 * and every row is filed under that server's publicId.
 */

/** EVENT_REMINDER as the server publishes it (utils/pubsub.ts). */
type TReminderPayload = {
  eventId: number;
  serverId: number;
  title: string;
  startsAt: number;
  stage: 1 | 2 | 3;
};

/** The connected server's publicId; undefined between servers. */
const serverKey = () => store.getState().server.serverId;

const requireTRPCClient = () => {
  const trpc = getTRPCClient();
  if (!trpc) throw new NotConnectedError();
  return trpc;
};

const ownUserId = () => store.getState().server.ownUserId;

// ─── reads ────────────────────────────────────────────────────────────

/**
 * One in-flight list call per server and range: the planner, the Apps
 * row and a reconnect can all ask for the same window in one tick.
 */
const inflightWindows = new Map<string, Promise<void>>();

export const fetchEventsWindow = async (from: number, to: number) => {
  const key = serverKey();
  const trpc = getTRPCClient();
  if (!key || !trpc) return;
  const dedupeKey = `${key}:${from}:${to}`;
  const pending = inflightWindows.get(dedupeKey);
  if (pending) return pending;

  const run = (async () => {
    try {
      const items = await trpc.events.list.query({ from, to });
      // The response belongs to the server that was in focus when the
      // call left; a switch in between must not file it elsewhere.
      if (serverKey() !== key) return;
      store.dispatch(
        eventsSliceActions.setWindow({ serverKey: key, from, to, items })
      );
    } catch (err) {
      console.error('Failed to fetch events:', err);
    } finally {
      inflightWindows.delete(dedupeKey);
    }
  })();
  inflightWindows.set(dedupeKey, run);
  return run;
};

const inflightDetails = new Map<string, Promise<void>>();

export const fetchEventDetail = async (eventId: number) => {
  const key = serverKey();
  const trpc = getTRPCClient();
  if (!key || !trpc) return;
  const dedupeKey = `${key}:${eventId}`;
  const pending = inflightDetails.get(dedupeKey);
  if (pending) return pending;

  const run = (async () => {
    try {
      const detail = await trpc.events.get.query({ eventId });
      if (serverKey() !== key) return;
      store.dispatch(
        eventsSliceActions.setDetail({
          serverKey: key,
          detail,
          ownUserId: ownUserId()
        })
      );
    } catch (err) {
      // A card for a cancelled event asks for a row that is gone; the
      // card renders its fallback and nothing else needs to hear this.
      console.warn(`Failed to fetch event ${eventId}:`, err);
    } finally {
      inflightDetails.delete(dedupeKey);
    }
  })();
  inflightDetails.set(dedupeKey, run);
  return run;
};

/** Loads the detail once; a card or sheet that already has it renders immediately. */
export const ensureEventDetail = (eventId: number) => {
  const key = serverKey();
  if (!key) return;
  if (store.getState().events.byServer[key]?.details[eventId]) return;
  void fetchEventDetail(eventId);
};

export const fetchRosterTemplates = async () => {
  const key = serverKey();
  const trpc = getTRPCClient();
  if (!key || !trpc) return;
  try {
    const templates = await trpc.events.templates.list.query();
    if (serverKey() !== key) return;
    store.dispatch(
      eventsSliceActions.setTemplates({ serverKey: key, templates })
    );
  } catch (err) {
    console.error('Failed to fetch roster templates:', err);
  }
};

export const fetchCalendarUrl = async (): Promise<string | undefined> => {
  const key = serverKey();
  if (!key) return undefined;
  const trpc = requireTRPCClient();
  const result = await trpc.events.getCalendarUrl.query();
  const url = resolveCalendarUrl(result, window.location.origin);
  if (serverKey() === key) {
    store.dispatch(eventsSliceActions.setCalendarUrl({ serverKey: key, url }));
  }
  return url;
};

// ─── writes (throw; the caller shows the error) ───────────────────────

export type TEventInput = {
  title: string;
  description: string | null;
  gameTag: string | null;
  startsAt: number;
  endsAt: number;
  maxParticipants: number | null;
  announceChannelId: number | null;
  /**
   * The roster: a template id (the server snapshots its roles), or the
   * roles themselves. Both undefined on an update = leave the roster as
   * it is — resending the template would re-snapshot it from the
   * template's current roles behind the host's back.
   */
  templateId?: number;
  roles?: TEventRole[];
};

export const createEvent = async (input: TEventInput) => {
  const trpc = requireTRPCClient();
  const { templateId, roles, ...fields } = input;
  const event = await trpc.events.create.mutate({
    ...fields,
    ...(templateId !== undefined ? { templateId } : {}),
    ...(roles ? { roles } : {})
  });
  const key = serverKey();
  if (key)
    store.dispatch(eventsSliceActions.upsertEvent({ serverKey: key, event }));
  return event;
};

export const updateEvent = async (eventId: number, input: TEventInput) => {
  const trpc = requireTRPCClient();
  const { templateId, roles, ...fields } = input;
  const event = await trpc.events.update.mutate({
    eventId,
    ...fields,
    ...(templateId !== undefined ? { templateId } : {}),
    ...(roles ? { roles, templateId: null } : {})
  });
  const key = serverKey();
  if (key) {
    store.dispatch(eventsSliceActions.upsertEvent({ serverKey: key, event }));
    void fetchEventDetail(eventId);
  }
  return event;
};

export const cancelEvent = async (eventId: number) => {
  const trpc = requireTRPCClient();
  await trpc.events.cancel.mutate({ eventId });
};

const applySignupResult = (
  eventId: number,
  signup: {
    roleKey: string;
    status: 'confirmed' | 'bench' | 'declined';
    position: number;
  } | null
) => {
  const key = serverKey();
  if (!key) return;
  store.dispatch(
    eventsSliceActions.setOwnSignup({
      serverKey: key,
      eventId,
      signup: signup
        ? {
            roleKey: signup.roleKey,
            status: signup.status,
            position: signup.position
          }
        : null
    })
  );
  // The roster moved (ours, and whoever auto-promoted); an open sheet
  // or card shows the new placement without waiting for the fan-out.
  void fetchEventDetail(eventId);
};

export const signupForEvent = async (eventId: number, roleKey: string) => {
  const trpc = requireTRPCClient();
  const result = await trpc.events.signup.mutate({ eventId, roleKey });
  applySignupResult(eventId, result.signup);
  return result;
};

export const declineEvent = async (eventId: number) => {
  const trpc = requireTRPCClient();
  const result = await trpc.events.decline.mutate({ eventId });
  applySignupResult(eventId, result.signup);
  return result;
};

export const withdrawFromEvent = async (eventId: number) => {
  const trpc = requireTRPCClient();
  const result = await trpc.events.withdraw.mutate({ eventId });
  applySignupResult(eventId, null);
  return result;
};

export const setSignupStatus = async (
  eventId: number,
  userId: number,
  status: 'confirmed' | 'bench',
  roleKey?: string
) => {
  const trpc = requireTRPCClient();
  const signup = await trpc.events.setSignupStatus.mutate({
    eventId,
    userId,
    status,
    ...(roleKey ? { roleKey } : {})
  });
  if (userId === ownUserId()) applySignupResult(eventId, signup);
  else void fetchEventDetail(eventId);
  return signup;
};

export const createRosterTemplate = async (
  name: string,
  roles: TEventRole[]
) => {
  const trpc = requireTRPCClient();
  const template = await trpc.events.templates.create.mutate({ name, roles });
  const key = serverKey();
  if (key)
    store.dispatch(
      eventsSliceActions.upsertTemplate({ serverKey: key, template })
    );
  return template;
};

export const updateRosterTemplate = async (
  templateId: number,
  patch: { name?: string; roles?: TEventRole[] }
): Promise<TEventRosterTemplate> => {
  const trpc = requireTRPCClient();
  const template = await trpc.events.templates.update.mutate({
    templateId,
    ...patch
  });
  const key = serverKey();
  if (key)
    store.dispatch(
      eventsSliceActions.upsertTemplate({ serverKey: key, template })
    );
  return template;
};

export const deleteRosterTemplate = async (templateId: number) => {
  const trpc = requireTRPCClient();
  await trpc.events.templates.delete.mutate({ templateId });
  const key = serverKey();
  if (key)
    store.dispatch(
      eventsSliceActions.removeTemplate({ serverKey: key, templateId })
    );
};

// ─── chrome ───────────────────────────────────────────────────────────

/**
 * Selects the planner row: the channel selection is cleared so the
 * content pane shows the planner, and the mobile drawer closes the way
 * it does for a channel row. channelId 0 is "no channel" — the only
 * listener treats the event as a navigation signal and ignores the id.
 */
export const openRaidPlanner = () => {
  const key = serverKey();
  if (!key) return;
  store.dispatch(eventsSliceActions.openPlanner(key));
  setSelectedChannelId(undefined);
  emitAppEvent('channel-selected', { channelId: 0 });
};

export const setPlannerView = (view: TPlannerView) =>
  store.dispatch(eventsSliceActions.setView(view));

export const setPlannerMonthStart = (monthStart: number | undefined) =>
  store.dispatch(eventsSliceActions.setMonthStart(monthStart));

export const setPlannerFocusDay = (dayStart: number | undefined) =>
  store.dispatch(eventsSliceActions.setFocusDay(dayStart));

export const openEvent = (eventId: number) => {
  store.dispatch(eventsSliceActions.openEvent(eventId));
  void fetchEventDetail(eventId);
};

export const closeEvent = () => store.dispatch(eventsSliceActions.closeEvent());

export const openEventEditor = (editor: TEventEditor) => {
  if (editor.mode === 'edit') void fetchEventDetail(editor.eventId);
  void fetchRosterTemplates();
  store.dispatch(eventsSliceActions.openEditor(editor));
};

export const closeEventEditor = () =>
  store.dispatch(eventsSliceActions.closeEditor());

// ─── reminders ────────────────────────────────────────────────────────

/**
 * Brings the event's server on screen and opens its sheet. The reminder
 * came over the instance in focus, so its server is one of ours there:
 * a home server, or a federated one on the active peer.
 */
export const navigateToEvent = async (serverId: number, eventId: number) => {
  const { app } = store.getState();
  try {
    if (app.activeInstanceDomain) {
      await switchToFederatedServer(app.activeInstanceDomain, serverId);
    } else {
      const handshakeHash = getHandshakeHash();
      // No hash = no live home session; nothing to switch to.
      if (!handshakeHash) return;
      await switchServer(serverId, handshakeHash);
    }
  } catch (err) {
    console.error('Failed to open the event server:', err);
    return;
  }
  openEvent(eventId);
};

/**
 * One toast and (while the tab is hidden) one desktop notification per
 * reminder; a repeat of the same stage is ignored.
 */
export const handleEventReminder = (payload: TReminderPayload) => {
  const key = reminderKey(payload);
  if (store.getState().events.remindersSeen.includes(key)) return;
  store.dispatch(eventsSliceActions.noteReminder(key));

  const text = reminderText(payload.title, payload.stage);
  toast(text, {
    duration: 20_000,
    action: {
      label: 'Open',
      onClick: () => {
        void navigateToEvent(payload.serverId, payload.eventId);
      }
    }
  });
  sendDesktopNotification('Raid Planner', text, () => {
    void navigateToEvent(payload.serverId, payload.eventId);
  });
};

/** Sign-out: drop every cached event so the next account starts clean. */
export const resetEventsState = () => {
  store.dispatch(eventsSliceActions.resetState());
};
