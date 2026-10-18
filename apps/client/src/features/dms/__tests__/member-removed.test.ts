/**
 * DM_MEMBER_REMOVE for OUR OWN id drops the channel (messages, typing,
 * selection and its storage mirror) and says so; anyone else leaving
 * keeps the channel. Also covers the D38 selection persistence that
 * lives with the setSelectedDmChannelId action.
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { toast } from 'sonner';
import {
  handleDmMemberRemoved,
  removeDmChannel,
  setDmChannels,
  setSelectedDmChannelId
} from '@/features/dms/actions';
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
const channel = (
  id: number,
  members: TJoinedPublicUser[],
  name: string | null = null
) =>
  ({
    id,
    name,
    isGroup: members.length > 2,
    e2ee: false,
    members,
    unreadCount: 0
  }) as unknown as TJoinedDmChannel;
const message = (id: number, dmChannelId: number, userId: number) =>
  ({
    id,
    dmChannelId,
    userId,
    content: 'x',
    createdAt: id,
    e2ee: false,
    files: [],
    reactions: []
  }) as unknown as TJoinedDmMessage;

let infoSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  infoSpy = spyOn(toast, 'info').mockImplementation((() => 1) as never);
  store.dispatch(appSliceActions.setHomeOwnUserId(7));
  setDmChannels([
    channel(1, [user(7, 'me'), user(8, 'bob'), user(9, 'cy')], 'Trio'),
    channel(2, [user(7, 'me'), user(8, 'bob')])
  ]);
  store.dispatch(
    dmsSliceActions.addMessages({ dmChannelId: 1, messages: [message(10, 1, 8)] })
  );
  store.dispatch(dmsSliceActions.addDmTypingUser({ dmChannelId: 1, userId: 8 }));
  setSelectedDmChannelId(1);
});
afterEach(() => {
  infoSpy.mockRestore();
  store.dispatch(dmsSliceActions.resetState());
  localStorage.removeItem(LocalStorageKey.ACTIVE_DM_CHANNEL_ID);
});

describe('handleDmMemberRemoved', () => {
  test('own removal drops the channel, its transient state and toasts', async () => {
    await handleDmMemberRemoved(1, 7);

    const dms = store.getState().dms;
    expect(dms.channels.map((c) => c.id)).toEqual([2]);
    expect(dms.messagesMap[1]).toBeUndefined();
    expect(dms.dmTypingMap[1]).toBeUndefined();
    expect(dms.selectedChannelId).toBeUndefined();
    expect(localStorage.getItem(LocalStorageKey.ACTIVE_DM_CHANNEL_ID)).toBeNull();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toBe('You were removed from Trio');
  });

  test('an unnamed group is described by the other members', async () => {
    setDmChannels([channel(3, [user(7, 'me'), user(8, 'bob'), user(9, 'cy')])]);
    await handleDmMemberRemoved(3, 7);
    expect(infoSpy.mock.calls[0][0]).toBe('You were removed from bob, cy');
  });

  test('someone else leaving keeps the channel and stays quiet', async () => {
    await handleDmMemberRemoved(1, 8);

    const dms = store.getState().dms;
    expect(dms.channels.map((c) => c.id)).toEqual([1, 2]);
    expect(dms.messagesMap[1]?.length).toBe(1);
    expect(dms.selectedChannelId).toBe(1);
    expect(infoSpy).not.toHaveBeenCalled();
  });
});

describe('DM selection persistence (D38)', () => {
  test('setSelectedDmChannelId mirrors the selection to storage', () => {
    setSelectedDmChannelId(2);
    expect(store.getState().dms.selectedChannelId).toBe(2);
    expect(localStorage.getItem(LocalStorageKey.ACTIVE_DM_CHANNEL_ID)).toBe('2');

    setSelectedDmChannelId(undefined);
    expect(store.getState().dms.selectedChannelId).toBeUndefined();
    expect(localStorage.getItem(LocalStorageKey.ACTIVE_DM_CHANNEL_ID)).toBeNull();
  });

  test('removing the selected channel clears the mirror; another does not', () => {
    removeDmChannel(2);
    expect(localStorage.getItem(LocalStorageKey.ACTIVE_DM_CHANNEL_ID)).toBe('1');
    removeDmChannel(1);
    expect(localStorage.getItem(LocalStorageKey.ACTIVE_DM_CHANNEL_ID)).toBeNull();
  });

  test('setChannels marks the list as loaded', () => {
    store.dispatch(dmsSliceActions.resetState());
    expect(store.getState().dms.channelsLoaded).toBe(false);
    setDmChannels([]);
    expect(store.getState().dms.channelsLoaded).toBe(true);
  });
});
