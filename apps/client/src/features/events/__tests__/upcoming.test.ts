/**
 * The Home overview's upcoming-events store: one query per fetch (a
 * concurrent call joins the in-flight one), the list is filed under
 * the account it was fetched for, a change refetches while someone is
 * listening and otherwise drops the cache so the next mount fetches
 * fresh, and a failed query keeps what was there.
 *
 * Run via: bun test apps/client/src/features/events/__tests__/upcoming.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TUpcomingEvent } from '@pulse/server/types';
import {
  __testing,
  fetchUpcomingEvents,
  refreshUpcomingEvents
} from '../upcoming';

const row = (id: number): TUpcomingEvent => ({
  serverId: 1,
  serverPublicId: 'srv',
  serverName: 'Guild',
  event: {
    id,
    title: `Event ${id}`,
    startsAt: 1_000 + id,
    endsAt: 2_000 + id,
    status: 'scheduled',
    hostId: null
  },
  mySignupStatus: null,
  mySignupRole: null
});

let queries = 0;
let nextItems: TUpcomingEvent[] = [];
let fail = false;

const fakeClient = {
  events: {
    upcomingForUser: {
      query: async () => {
        queries += 1;
        if (fail) throw new Error('offline');
        return nextItems;
      }
    }
  }
} as never;

beforeEach(() => {
  __testing.reset();
  __testing.setClientResolver(() => fakeClient);
  queries = 0;
  nextItems = [];
  fail = false;
});

afterEach(() => {
  __testing.reset();
});

describe('fetchUpcomingEvents', () => {
  test('files the list under the account and joins a concurrent call', async () => {
    nextItems = [row(1), row(2)];
    await Promise.all([fetchUpcomingEvents(7), fetchUpcomingEvents(7)]);
    expect(queries).toBe(1);
    expect(__testing.snapshot()).toEqual({
      items: nextItems,
      forUserId: 7,
      loaded: true
    });
  });

  test('a failed query keeps the previous list', async () => {
    nextItems = [row(1)];
    await fetchUpcomingEvents(7);
    fail = true;
    await fetchUpcomingEvents(7);
    expect(__testing.snapshot().items).toEqual([row(1)]);
    expect(__testing.snapshot().loaded).toBe(true);
  });

  test('no home client means nothing is fetched', async () => {
    __testing.setClientResolver(() => undefined as never);
    await fetchUpcomingEvents(7);
    expect(__testing.snapshot().loaded).toBe(false);
  });
});

describe('refreshUpcomingEvents', () => {
  test('refetches while the overview listens', async () => {
    nextItems = [row(1)];
    await fetchUpcomingEvents(7);
    let notified = 0;
    const unsubscribe = __testing.subscribe(() => {
      notified += 1;
    });

    nextItems = [row(1), row(3)];
    refreshUpcomingEvents();
    await Bun.sleep(0);
    expect(queries).toBe(2);
    expect(notified).toBe(1);
    expect(__testing.snapshot().items).toEqual(nextItems);
    unsubscribe();
  });

  test('drops the cached list when nobody listens, so the next mount fetches fresh', async () => {
    nextItems = [row(1)];
    await fetchUpcomingEvents(7);
    refreshUpcomingEvents();
    expect(queries).toBe(1);
    expect(__testing.snapshot().loaded).toBe(false);
    expect(__testing.snapshot().items).toEqual([]);
  });

  test('nothing to drop is a no-op', () => {
    refreshUpcomingEvents();
    expect(__testing.snapshot().loaded).toBe(false);
    expect(queries).toBe(0);
  });
});
