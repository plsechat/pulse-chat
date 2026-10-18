/**
 * The DM slice's message window: same 300-message cap and detach rules
 * as the channel slice (features/message-window.ts): a forward page
 * (dms.getMessages `after`) appends and trims the oldest end, and
 * "Jump to Present" replaces the window with the latest page.
 *
 * Run via: bun test apps/client/src/features/dms/__tests__/message-window.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { TJoinedDmMessage } from '@pulse/server/types';
import { dmsSliceActions, dmsSliceReducer as reducer } from '../slice';

const initial = reducer(undefined, { type: '@@init' });
const msg = (id: number) =>
  ({ id, dmChannelId: 1, userId: 2, content: 'x', createdAt: id * 1000, e2ee: false, files: [], reactions: [] }) as unknown as TJoinedDmMessage;
const page = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));

describe('DM message window cap', () => {
  test('after N > 300 live appends the array holds 300 and the newest is kept', () => {
    let s = initial;
    for (let id = 1; id <= 310; id++) {
      s = reducer(
        s,
        dmsSliceActions.addMessages({ dmChannelId: 1, messages: [msg(id)], opts: { live: true } })
      );
    }
    expect(s.messagesMap[1]).toHaveLength(300);
    expect(s.messagesMap[1][0].id).toBe(11);
    expect(s.messagesMap[1][299].id).toBe(310);
    expect(s.messageWindowMap[1]).toEqual({ hasOlder: true, hasNewer: false });
  });

  test('prepending past the cap drops the newest and sets hasNewer', () => {
    let s = reducer(
      initial,
      dmsSliceActions.replaceMessages({ dmChannelId: 1, messages: page(201, 500), hasOlder: true })
    );
    s = reducer(
      s,
      dmsSliceActions.addMessages({ dmChannelId: 1, messages: page(151, 200), opts: { prepend: true } })
    );
    expect(s.messagesMap[1]).toHaveLength(300);
    expect(s.messagesMap[1][0].id).toBe(151);
    expect(s.messagesMap[1][299].id).toBe(450);
    expect(s.messageWindowMap[1]).toEqual({ hasOlder: true, hasNewer: true });
  });

  test('a live message does not grow a detached window', () => {
    let s = reducer(initial, dmsSliceActions.addMessages({ dmChannelId: 1, messages: page(1, 5) }));
    s = reducer(s, dmsSliceActions.setMessageWindow({ dmChannelId: 1, hasNewer: true }));
    s = reducer(
      s,
      dmsSliceActions.addMessages({ dmChannelId: 1, messages: [msg(900)], opts: { live: true } })
    );
    expect(s.messagesMap[1].map((m) => m.id)).toEqual([1, 2, 3, 4, 5]);
  });

  test('a forward page appended past the cap trims the oldest end; the tail re-attaches', () => {
    let s = reducer(
      initial,
      dmsSliceActions.replaceMessages({ dmChannelId: 1, messages: page(1, 300), hasOlder: false })
    );
    s = reducer(s, dmsSliceActions.setMessageWindow({ dmChannelId: 1, hasNewer: true }));
    // The page comes newest-first from the server, like every other page.
    s = reducer(
      s,
      dmsSliceActions.addMessages({ dmChannelId: 1, messages: page(301, 350).reverse() })
    );
    expect(s.messagesMap[1]).toHaveLength(300);
    expect(s.messagesMap[1][0].id).toBe(51);
    expect(s.messagesMap[1][299].id).toBe(350);
    // Trimming re-opened the older edge; the newer edge is the action's
    // call (the reducer cannot know whether the page reached the tail).
    expect(s.messageWindowMap[1]).toEqual({ hasOlder: true, hasNewer: true });

    s = reducer(s, dmsSliceActions.setMessageWindow({ dmChannelId: 1, hasNewer: false }));
    expect(s.messageWindowMap[1]).toEqual({ hasOlder: true, hasNewer: false });
  });

  test('the latest page re-attaches a detached window and clears it', () => {
    let s = reducer(initial, dmsSliceActions.addMessages({ dmChannelId: 1, messages: page(1, 300) }));
    s = reducer(s, dmsSliceActions.setMessageWindow({ dmChannelId: 1, hasNewer: true }));
    s = reducer(
      s,
      dmsSliceActions.replaceMessages({ dmChannelId: 1, messages: page(951, 1000), hasOlder: true })
    );
    expect(s.messagesMap[1].map((m) => m.id)).toEqual(page(951, 1000).map((m) => m.id));
    expect(s.messageWindowMap[1]).toEqual({ hasOlder: true, hasNewer: false });
  });

  test('the beginning of history is recorded from the page result', () => {
    let s = reducer(initial, dmsSliceActions.addMessages({ dmChannelId: 1, messages: page(1, 20) }));
    s = reducer(s, dmsSliceActions.setMessageWindow({ dmChannelId: 1, hasOlder: false }));
    expect(s.messageWindowMap[1]).toEqual({ hasOlder: false, hasNewer: false });
  });

  test('removeChannel and purge drop the window flags with the messages', () => {
    let s = reducer(initial, dmsSliceActions.addMessages({ dmChannelId: 1, messages: page(1, 5) }));
    s = reducer(s, dmsSliceActions.setMessageWindow({ dmChannelId: 1, hasNewer: true }));
    expect(reducer(s, dmsSliceActions.removeChannel(1)).messageWindowMap[1]).toBeUndefined();
    const purged = reducer(s, dmsSliceActions.purgeChannelMessages({ dmChannelId: 1 }));
    expect(purged.messagesMap[1]).toEqual([]);
    expect(purged.messageWindowMap[1]).toBeUndefined();
  });
});
