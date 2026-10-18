import type {
  TEvent,
  TEventDetail,
  TEventListItem,
  TEventRosterCounts,
  TEventRosterTemplate,
  TEventSignup
} from '@pulse/server/types';
import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * Planner state. Everything the planner shows is keyed by the
 * server's globally-unique publicId (`state.server.serverId`), never by
 * the numeric id: events are per server, federated servers included,
 * and two instances can both hold an event (or a server) with id 1.
 * The UI chrome (open planner, open sheet, month in view) is global —
 * one planner is on screen at a time.
 */

export type TPlannerView = 'month' | 'agenda';

export type TEventEditor =
  | { mode: 'create'; startsAt?: number }
  | { mode: 'edit'; eventId: number };

export type TOwnSignup = TEventListItem['ownSignup'];

export type TEventsServerState = {
  /** The range the last list call covered; null until the first fetch. */
  window: { from: number; to: number } | null;
  /** List rows by event id: the window's rows plus any event whose detail was loaded. */
  items: Record<number, TEventListItem>;
  details: Record<number, TEventDetail>;
  templates: TEventRosterTemplate[] | null;
  calendarUrl: string | null;
};

export interface TEventsState {
  byServer: Record<string, TEventsServerState>;
  /** publicId of the server whose planner row is selected. */
  plannerOpenFor: string | undefined;
  /** Undefined until the user picks one: phones default to the agenda. */
  view: TPlannerView | undefined;
  /** First day of the month in view (local midnight, epoch ms); undefined = this month. */
  monthStart: number | undefined;
  /** A day picked from the grid (local midnight, epoch ms): the agenda narrows to it. */
  focusDay: number | undefined;
  openEventId: number | undefined;
  editor: TEventEditor | undefined;
  /** `${serverId}:${eventId}:${stage}` of every reminder already surfaced. */
  remindersSeen: string[];
}

const REMINDERS_SEEN_MAX = 200;

const emptyServerState = (): TEventsServerState => ({
  window: null,
  items: {},
  details: {},
  templates: null,
  calendarUrl: null
});

const initialState: TEventsState = {
  byServer: {},
  plannerOpenFor: undefined,
  view: undefined,
  monthStart: undefined,
  focusDay: undefined,
  openEventId: undefined,
  editor: undefined,
  remindersSeen: []
};

const serverState = (state: TEventsState, serverKey: string) => {
  state.byServer[serverKey] ??= emptyServerState();
  return state.byServer[serverKey];
};

const emptyCounts = (event: TEvent): TEventRosterCounts => ({
  byRole: Object.fromEntries(
    event.roles.map((role) => [role.key, { confirmed: 0, bench: 0 }])
  ),
  confirmed: 0,
  bench: 0,
  declined: 0
});

const overlaps = (
  event: Pick<TEvent, 'startsAt' | 'endsAt'>,
  window: { from: number; to: number }
) => event.startsAt <= window.to && event.endsAt >= window.from;

/**
 * The viewer's own row, read off a roster. Declined signups are only a
 * count in the roster, so a declined viewer keeps the status the list
 * already gave them.
 */
const deriveOwnSignup = (
  detail: TEventDetail,
  ownUserId: number | undefined,
  previous: TOwnSignup | undefined
): TOwnSignup => {
  if (ownUserId === undefined) return previous ?? null;
  const pick = (signup: TEventSignup): TOwnSignup => ({
    roleKey: signup.roleKey,
    status: signup.status,
    position: signup.position
  });
  for (const column of detail.roster.confirmed) {
    const mine = column.signups.find((s) => s.userId === ownUserId);
    if (mine) return pick(mine);
  }
  const benched = detail.roster.bench.find((s) => s.userId === ownUserId);
  if (benched) return pick(benched);
  return previous?.status === 'declined' ? previous : null;
};

export const eventsSlice = createSlice({
  name: 'events',
  initialState,
  reducers: {
    resetState: () => initialState,

    setWindow: (
      state,
      action: PayloadAction<{
        serverKey: string;
        from: number;
        to: number;
        items: TEventListItem[];
      }>
    ) => {
      const { serverKey, from, to, items } = action.payload;
      const s = serverState(state, serverKey);
      const window = { from, to };
      // The fetch is authoritative for its range: rows inside it that
      // did not come back are gone (cancelled before the subscription
      // caught up, or never ours). Rows outside it were loaded for a
      // sheet or a card and stay.
      const next: Record<number, TEventListItem> = {};
      for (const item of Object.values(s.items)) {
        if (!overlaps(item, window)) next[item.id] = item;
      }
      for (const item of items) next[item.id] = item;
      s.items = next;
      s.window = window;
    },

    /**
     * EVENT_CREATE / EVENT_UPDATE: the bare event row. Counts and the
     * viewer's signup are kept from the row already held; a new row in
     * the window starts empty (a fresh event has no signups yet).
     * Events outside the window with nothing loaded for them are not
     * tracked — the next list call for their range brings them in.
     */
    upsertEvent: (
      state,
      action: PayloadAction<{ serverKey: string; event: TEvent }>
    ) => {
      const { serverKey, event } = action.payload;
      const s = serverState(state, serverKey);
      const existing = s.items[event.id];
      const detail = s.details[event.id];
      const inWindow = s.window !== null && overlaps(event, s.window);

      if (!existing && !detail && !inWindow) return;

      s.items[event.id] = existing
        ? { ...existing, ...event }
        : { ...event, counts: emptyCounts(event), ownSignup: null };
      if (detail) detail.event = event;
    },

    removeEvent: (
      state,
      action: PayloadAction<{ serverKey: string; eventId: number }>
    ) => {
      const { serverKey, eventId } = action.payload;
      const s = state.byServer[serverKey];
      if (s) {
        delete s.items[eventId];
        delete s.details[eventId];
      }
      if (state.openEventId === eventId) state.openEventId = undefined;
      if (state.editor?.mode === 'edit' && state.editor.eventId === eventId) {
        state.editor = undefined;
      }
    },

    setSignupCounts: (
      state,
      action: PayloadAction<{
        serverKey: string;
        eventId: number;
        counts: TEventRosterCounts;
      }>
    ) => {
      const { serverKey, eventId, counts } = action.payload;
      const s = state.byServer[serverKey];
      if (!s) return;
      const item = s.items[eventId];
      if (item) item.counts = counts;
      const detail = s.details[eventId];
      if (detail) detail.counts = counts;
    },

    setDetail: (
      state,
      action: PayloadAction<{
        serverKey: string;
        detail: TEventDetail;
        ownUserId: number | undefined;
      }>
    ) => {
      const { serverKey, detail, ownUserId } = action.payload;
      const s = serverState(state, serverKey);
      s.details[detail.event.id] = detail;
      s.items[detail.event.id] = {
        ...detail.event,
        counts: detail.counts,
        ownSignup: deriveOwnSignup(
          detail,
          ownUserId,
          s.items[detail.event.id]?.ownSignup
        )
      };
    },

    setOwnSignup: (
      state,
      action: PayloadAction<{
        serverKey: string;
        eventId: number;
        signup: TOwnSignup;
      }>
    ) => {
      const { serverKey, eventId, signup } = action.payload;
      const item = state.byServer[serverKey]?.items[eventId];
      if (item) item.ownSignup = signup;
    },

    setTemplates: (
      state,
      action: PayloadAction<{
        serverKey: string;
        templates: TEventRosterTemplate[];
      }>
    ) => {
      serverState(state, action.payload.serverKey).templates =
        action.payload.templates;
    },

    upsertTemplate: (
      state,
      action: PayloadAction<{
        serverKey: string;
        template: TEventRosterTemplate;
      }>
    ) => {
      const s = serverState(state, action.payload.serverKey);
      const list = s.templates ?? [];
      const at = list.findIndex((t) => t.id === action.payload.template.id);
      if (at === -1) list.push(action.payload.template);
      else list[at] = action.payload.template;
      s.templates = list;
    },

    removeTemplate: (
      state,
      action: PayloadAction<{ serverKey: string; templateId: number }>
    ) => {
      const s = state.byServer[action.payload.serverKey];
      if (!s?.templates) return;
      s.templates = s.templates.filter(
        (t) => t.id !== action.payload.templateId
      );
    },

    setCalendarUrl: (
      state,
      action: PayloadAction<{ serverKey: string; url: string }>
    ) => {
      serverState(state, action.payload.serverKey).calendarUrl =
        action.payload.url;
    },

    openPlanner: (state, action: PayloadAction<string>) => {
      state.plannerOpenFor = action.payload;
    },

    closePlanner: (state) => {
      state.plannerOpenFor = undefined;
    },

    setView: (state, action: PayloadAction<TPlannerView>) => {
      state.view = action.payload;
      if (action.payload === 'month') state.focusDay = undefined;
    },

    setMonthStart: (state, action: PayloadAction<number | undefined>) => {
      state.monthStart = action.payload;
      state.focusDay = undefined;
    },

    /** Picking a day narrows the agenda to it and shows the agenda. */
    setFocusDay: (state, action: PayloadAction<number | undefined>) => {
      state.focusDay = action.payload;
      if (action.payload !== undefined) state.view = 'agenda';
    },

    openEvent: (state, action: PayloadAction<number>) => {
      state.openEventId = action.payload;
    },

    closeEvent: (state) => {
      state.openEventId = undefined;
    },

    openEditor: (state, action: PayloadAction<TEventEditor>) => {
      state.editor = action.payload;
    },

    closeEditor: (state) => {
      state.editor = undefined;
    },

    /** Records a reminder as surfaced; a repeat is a no-op. */
    noteReminder: (state, action: PayloadAction<string>) => {
      if (state.remindersSeen.includes(action.payload)) return;
      state.remindersSeen.push(action.payload);
      if (state.remindersSeen.length > REMINDERS_SEEN_MAX) {
        state.remindersSeen.splice(
          0,
          state.remindersSeen.length - REMINDERS_SEEN_MAX
        );
      }
    }
  }
});

const eventsSliceActions = eventsSlice.actions;
const eventsSliceReducer = eventsSlice.reducer;

export { deriveOwnSignup, eventsSliceActions, eventsSliceReducer };
