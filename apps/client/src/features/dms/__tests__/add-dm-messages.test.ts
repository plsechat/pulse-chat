/**
 * addDmMessages alert gating (A10-10 #8): an incoming DM counts as unread
 * (sound + desktop notification + badge) unless that DM is on screen, in
 * which case the server read marker is advanced instead; own messages
 * do neither; an unknown channel is fetched first so the badge has
 * somewhere to land.
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as sounds from '@/features/server/sounds/actions';
import * as desktop from '@/features/notifications/desktop-notification';
import * as trpcModule from '@/lib/trpc';
import { addDmMessages, setDmChannels, setSelectedDmChannelId } from '@/features/dms/actions';
import { dmsSliceActions } from '@/features/dms/slice';
import { appSliceActions } from '@/features/app/slice';
import { store } from '@/features/store';
import { LocalStorageKey } from '@/helpers/storage';
import type {
  TJoinedDmChannel,
  TJoinedDmMessage,
  TJoinedPublicUser
} from '@pulse/server/types';

const user = (id: number, name: string) =>
  ({ id, name, roleIds: [] }) as unknown as TJoinedPublicUser;
const channel = (id: number, members: TJoinedPublicUser[]) =>
  ({ id, name: null, isGroup: false, e2ee: false, members, unreadCount: 0 }) as unknown as TJoinedDmChannel;
const message = (id: number, dmChannelId: number, userId: number) =>
  ({ id, dmChannelId, userId, content: 'hello', createdAt: id, e2ee: false, files: [], reactions: [] }) as unknown as TJoinedDmMessage;

type Call = { route: string; input: unknown };
const fakeHome = (calls: Call[], handlers: Record<string, (input: unknown) => unknown> = {}) => {
  const make = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'mutate' || prop === 'query') {
          return async (input: unknown) => {
            const route = path.join('.');
            calls.push({ route, input });
            return handlers[route]?.(input);
          };
        }
        if (prop === 'then') return undefined;
        return make([...path, String(prop)]);
      }
    });
  return make([]) as never;
};

let playSound: ReturnType<typeof spyOn>;
let notify: ReturnType<typeof spyOn>;
const spies: { mockRestore: () => void }[] = [];

beforeEach(() => {
  playSound = spyOn(sounds, 'playSound').mockImplementation(() => {});
  notify = spyOn(desktop, 'sendDesktopNotification').mockImplementation(() => {});
  store.dispatch(appSliceActions.setHomeOwnUserId(7));
  store.dispatch(appSliceActions.setActiveView('server'));
  setDmChannels([channel(1, [user(7, 'me'), user(8, 'bob')])]);
  setSelectedDmChannelId(undefined);
});
afterEach(() => {
  playSound.mockRestore();
  notify.mockRestore();
  for (const s of spies.splice(0)) s.mockRestore();
  store.dispatch(dmsSliceActions.resetState());
  localStorage.removeItem(LocalStorageKey.ACTIVE_DM_CHANNEL_ID);
});

describe('addDmMessages (subscription path)', () => {
  test('a message from someone else while not on that DM: sound, notification, badge', async () => {
    await addDmMessages(1, [message(10, 1, 8)], {}, true);

    const ch = store.getState().dms.channels[0];
    expect(ch.unreadCount).toBe(1);
    expect(ch.lastMessage?.id).toBe(10);
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('bob');
    expect(store.getState().dms.messagesMap[1].map((m) => m.id)).toEqual([10]);
  });

  test('while viewing that DM: no badge, the server read marker advances', async () => {
    const calls: Call[] = [];
    spies.push(spyOn(trpcModule, 'getHomeTRPCClient').mockReturnValue(fakeHome(calls)));
    store.dispatch(appSliceActions.setActiveView('home'));
    setSelectedDmChannelId(1);

    await addDmMessages(1, [message(11, 1, 8)], {}, true);

    expect(store.getState().dms.channels[0].unreadCount).toBe(0);
    expect(playSound).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(calls).toEqual([{ route: 'dms.markChannelAsRead', input: { dmChannelId: 1 } }]);
  });

  test('selected but viewing a server still alerts (selection is sticky)', async () => {
    setSelectedDmChannelId(1);
    await addDmMessages(1, [message(12, 1, 8)], {}, true);
    expect(store.getState().dms.channels[0].unreadCount).toBe(1);
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  test('our own message neither alerts nor badges', async () => {
    await addDmMessages(1, [message(13, 1, 7)], {}, true);
    expect(store.getState().dms.channels[0].unreadCount).toBe(0);
    expect(playSound).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(store.getState().dms.channels[0].lastMessage?.id).toBe(13);
  });

  test('an unknown channel is fetched first so the badge lands', async () => {
    const calls: Call[] = [];
    spies.push(
      spyOn(trpcModule, 'getHomeTRPCClient').mockReturnValue(
        fakeHome(calls, {
          'dms.getChannels': () => [
            channel(1, [user(7, 'me'), user(8, 'bob')]),
            channel(2, [user(7, 'me'), user(9, 'cy')])
          ]
        })
      )
    );

    await addDmMessages(2, [message(14, 2, 9)], {}, true);

    expect(calls[0]?.route).toBe('dms.getChannels');
    const ch2 = store.getState().dms.channels.find((c) => c.id === 2);
    expect(ch2?.unreadCount).toBe(1);
    expect(notify.mock.calls[0][0]).toBe('cy');
  });

  test('a history page (not a subscription) never alerts', async () => {
    await addDmMessages(1, [message(15, 1, 8)], { prepend: true });
    expect(store.getState().dms.channels[0].unreadCount).toBe(0);
    expect(playSound).not.toHaveBeenCalled();
  });
});
