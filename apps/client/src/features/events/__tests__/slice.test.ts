/**
 * Planner slice: the visible window, live upserts/deletes, roster
 * counts, the viewer's own signup derived from a roster, and reminder
 * dedupe.
 *
 * Run via: bun test apps/client/src/features/events/__tests__/slice.test.ts
 */
import type {
  TEvent,
  TEventDetail,
  TEventListItem,
  TEventSignup
} from '@pulse/server/types';
import { describe, expect, test } from 'bun:test';
import {
  eventsSliceActions as actions,
  deriveOwnSignup,
  eventsSliceReducer as reducer
} from '../slice';

const KEY = 'srv-public-id';
const HOUR = 60 * 60 * 1000;

const roles = [
  { key: 'tank', label: 'Tank', cap: 2, color: '#60a5fa' },
  { key: 'dps', label: 'DPS', cap: 3, color: '#ff5c6c' }
];

const event = (
  id: number,
  startsAt: number,
  patch: Partial<TEvent> = {}
): TEvent =>
  ({
    id,
    serverId: 1,
    title: `Event ${id}`,
    description: null,
    gameTag: null,
    startsAt,
    endsAt: startsAt + 2 * HOUR,
    hostId: 7,
    templateId: null,
    roles,
    maxParticipants: null,
    announceChannelId: null,
    voiceChannelId: null,
    status: 'scheduled',
    reminderStage: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch
  }) as TEvent;

const counts = (confirmed = 0, bench = 0) => ({
  byRole: { tank: { confirmed, bench }, dps: { confirmed: 0, bench: 0 } },
  confirmed,
  bench,
  declined: 0
});

const item = (id: number, startsAt: number): TEventListItem => ({
  ...event(id, startsAt),
  counts: counts(),
  ownSignup: null
});

const signup = (
  id: number,
  userId: number,
  roleKey: string,
  status: TEventSignup['status'],
  position = 0
): TEventSignup =>
  ({
    id,
    eventId: 1,
    userId,
    roleKey,
    status,
    position,
    createdAt: id
  }) as TEventSignup;

const detail = (e: TEvent, signups: TEventSignup[]): TEventDetail => ({
  event: e,
  counts: counts(signups.filter((s) => s.status === 'confirmed').length),
  roster: {
    confirmed: e.roles.map((role) => ({
      role,
      signups: signups.filter(
        (s) => s.status === 'confirmed' && s.roleKey === role.key
      )
    })),
    bench: signups.filter((s) => s.status === 'bench'),
    declined: signups.filter((s) => s.status === 'declined').length
  },
  host: null
});

const init = () => reducer(undefined, { type: '@@init' });
const withWindow = (from: number, to: number, items: TEventListItem[]) =>
  reducer(init(), actions.setWindow({ serverKey: KEY, from, to, items }));

describe('setWindow', () => {
  test('replaces rows inside the range and keeps rows outside it', () => {
    let s = withWindow(0, 10 * HOUR, [item(1, HOUR), item(2, 5 * HOUR)]);
    // A detail loaded for a far-away event (opened from a chat card).
    s = reducer(
      s,
      actions.setDetail({
        serverKey: KEY,
        detail: detail(event(9, 100 * HOUR), []),
        ownUserId: 1
      })
    );
    s = reducer(
      s,
      actions.setWindow({
        serverKey: KEY,
        from: 0,
        to: 10 * HOUR,
        items: [item(2, 5 * HOUR)]
      })
    );
    expect(Object.keys(s.byServer[KEY]!.items).map(Number).sort()).toEqual([
      2, 9
    ]);
    expect(s.byServer[KEY]!.window).toEqual({ from: 0, to: 10 * HOUR });
  });

  test('is keyed per server', () => {
    let s = withWindow(0, HOUR, [item(1, 0)]);
    s = reducer(
      s,
      actions.setWindow({
        serverKey: 'other',
        from: 0,
        to: HOUR,
        items: [item(5, 0)]
      })
    );
    expect(Object.keys(s.byServer[KEY]!.items)).toEqual(['1']);
    expect(Object.keys(s.byServer['other']!.items)).toEqual(['5']);
  });
});

describe('upsertEvent', () => {
  test('adds a new event that overlaps the window with empty counts', () => {
    const s = reducer(
      withWindow(0, 10 * HOUR, []),
      actions.upsertEvent({ serverKey: KEY, event: event(3, 2 * HOUR) })
    );
    const row = s.byServer[KEY]!.items[3]!;
    expect(row.counts).toEqual({
      byRole: {
        tank: { confirmed: 0, bench: 0 },
        dps: { confirmed: 0, bench: 0 }
      },
      confirmed: 0,
      bench: 0,
      declined: 0
    });
    expect(row.ownSignup).toBeNull();
  });

  test('ignores an unknown event outside the window', () => {
    const s = reducer(
      withWindow(0, 10 * HOUR, []),
      actions.upsertEvent({ serverKey: KEY, event: event(3, 50 * HOUR) })
    );
    expect(s.byServer[KEY]!.items[3]).toBeUndefined();
  });

  test('keeps counts and own signup when updating a known row', () => {
    let s = withWindow(0, 10 * HOUR, [
      {
        ...item(1, HOUR),
        counts: counts(2),
        ownSignup: { roleKey: 'tank', status: 'confirmed', position: 1 }
      }
    ]);
    s = reducer(
      s,
      actions.upsertEvent({
        serverKey: KEY,
        event: event(1, HOUR, { title: 'Renamed' })
      })
    );
    const row = s.byServer[KEY]!.items[1]!;
    expect(row.title).toBe('Renamed');
    expect(row.counts.confirmed).toBe(2);
    expect(row.ownSignup?.roleKey).toBe('tank');
  });

  test('refreshes the event inside a loaded detail', () => {
    let s = reducer(
      init(),
      actions.setDetail({
        serverKey: KEY,
        detail: detail(event(1, HOUR), []),
        ownUserId: 1
      })
    );
    s = reducer(
      s,
      actions.upsertEvent({
        serverKey: KEY,
        event: event(1, HOUR, { status: 'live' })
      })
    );
    expect(s.byServer[KEY]!.details[1]!.event.status).toBe('live');
    expect(s.byServer[KEY]!.items[1]!.status).toBe('live');
  });
});

describe('removeEvent', () => {
  test('drops the row and detail and closes the sheet/editor on it', () => {
    let s = withWindow(0, 10 * HOUR, [item(1, HOUR), item(2, HOUR)]);
    s = reducer(s, actions.openEvent(1));
    s = reducer(s, actions.openEditor({ mode: 'edit', eventId: 1 }));
    s = reducer(s, actions.removeEvent({ serverKey: KEY, eventId: 1 }));
    expect(s.byServer[KEY]!.items[1]).toBeUndefined();
    expect(s.byServer[KEY]!.items[2]).toBeDefined();
    expect(s.openEventId).toBeUndefined();
    expect(s.editor).toBeUndefined();
  });

  test('leaves another open sheet alone', () => {
    let s = withWindow(0, 10 * HOUR, [item(1, HOUR), item(2, HOUR)]);
    s = reducer(s, actions.openEvent(2));
    s = reducer(s, actions.removeEvent({ serverKey: KEY, eventId: 1 }));
    expect(s.openEventId).toBe(2);
  });
});

describe('setSignupCounts', () => {
  test('updates the row and the detail; unknown rows are a no-op', () => {
    let s = withWindow(0, 10 * HOUR, [item(1, HOUR)]);
    s = reducer(
      s,
      actions.setDetail({
        serverKey: KEY,
        detail: detail(event(1, HOUR), []),
        ownUserId: 1
      })
    );
    s = reducer(
      s,
      actions.setSignupCounts({
        serverKey: KEY,
        eventId: 1,
        counts: counts(2, 1)
      })
    );
    expect(s.byServer[KEY]!.items[1]!.counts.confirmed).toBe(2);
    expect(s.byServer[KEY]!.details[1]!.counts.bench).toBe(1);
    const before = s;
    s = reducer(
      s,
      actions.setSignupCounts({
        serverKey: KEY,
        eventId: 42,
        counts: counts(9)
      })
    );
    expect(s).toEqual(before);
  });
});

describe('setDetail / deriveOwnSignup', () => {
  const e = event(1, HOUR);

  test('finds the viewer in a confirmed column', () => {
    const d = detail(e, [
      signup(1, 5, 'tank', 'confirmed', 0),
      signup(2, 6, 'dps', 'confirmed', 1)
    ]);
    expect(deriveOwnSignup(d, 6, undefined)).toEqual({
      roleKey: 'dps',
      status: 'confirmed',
      position: 1
    });
  });

  test('finds the viewer on the bench', () => {
    const d = detail(e, [signup(1, 5, 'tank', 'bench', 3)]);
    expect(deriveOwnSignup(d, 5, undefined)).toEqual({
      roleKey: 'tank',
      status: 'bench',
      position: 3
    });
  });

  test('a declined viewer keeps the declined status the list gave them', () => {
    const d = detail(e, []);
    const declined = { roleKey: '', status: 'declined' as const, position: 0 };
    expect(deriveOwnSignup(d, 5, declined)).toEqual(declined);
    expect(deriveOwnSignup(d, 5, null)).toBeNull();
    expect(
      deriveOwnSignup(d, 5, {
        roleKey: 'tank',
        status: 'confirmed',
        position: 0
      })
    ).toBeNull();
  });

  test('setDetail writes the row with the derived signup', () => {
    const s = reducer(
      init(),
      actions.setDetail({
        serverKey: KEY,
        detail: detail(e, [signup(1, 5, 'tank', 'confirmed', 0)]),
        ownUserId: 5
      })
    );
    expect(s.byServer[KEY]!.items[1]!.ownSignup).toEqual({
      roleKey: 'tank',
      status: 'confirmed',
      position: 0
    });
    expect(s.byServer[KEY]!.items[1]!.counts.confirmed).toBe(1);
  });
});

describe('chrome', () => {
  test('the planner opens for one server; picking a day switches to the agenda', () => {
    let s = reducer(init(), actions.openPlanner(KEY));
    expect(s.plannerOpenFor).toBe(KEY);
    s = reducer(s, actions.setFocusDay(123));
    expect(s.view).toBe('agenda');
    expect(s.focusDay).toBe(123);
    s = reducer(s, actions.setView('month'));
    expect(s.focusDay).toBeUndefined();
    s = reducer(s, actions.closePlanner());
    expect(s.plannerOpenFor).toBeUndefined();
  });

  test('templates upsert and remove per server', () => {
    const t = (id: number, name: string) =>
      ({ id, serverId: 1, name, roles, createdAt: 1 }) as const;
    let s = reducer(
      init(),
      actions.setTemplates({ serverKey: KEY, templates: [t(1, 'A')] })
    );
    s = reducer(
      s,
      actions.upsertTemplate({ serverKey: KEY, template: t(2, 'B') })
    );
    s = reducer(
      s,
      actions.upsertTemplate({ serverKey: KEY, template: t(1, 'A2') })
    );
    expect(s.byServer[KEY]!.templates!.map((x) => x.name)).toEqual(['A2', 'B']);
    s = reducer(s, actions.removeTemplate({ serverKey: KEY, templateId: 1 }));
    expect(s.byServer[KEY]!.templates!.map((x) => x.id)).toEqual([2]);
  });
});

describe('noteReminder', () => {
  test('records a key once and caps the list', () => {
    let s = reducer(init(), actions.noteReminder('1:2:1'));
    s = reducer(s, actions.noteReminder('1:2:1'));
    expect(s.remindersSeen).toEqual(['1:2:1']);
    for (let i = 0; i < 250; i++)
      s = reducer(s, actions.noteReminder(`k:${i}`));
    expect(s.remindersSeen.length).toBe(200);
    expect(s.remindersSeen[0]).toBe('k:50');
    expect(s.remindersSeen.includes('1:2:1')).toBe(false);
  });
});
