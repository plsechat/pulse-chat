import { describe, expect, test } from 'bun:test';
import type { TJoinedDmChannel, TJoinedDmMessage } from '@pulse/shared';
import { dmsSliceActions, dmsSliceReducer as reducer } from '../slice';

const channel = (id: number, unreadCount = 0) =>
  ({ id, name: null, isGroup: false, members: [], unreadCount }) as unknown as TJoinedDmChannel;
const message = (id: number, dmChannelId: number) =>
  ({ id, dmChannelId, userId: 2, content: 'x', createdAt: id, e2ee: false, files: [], reactions: [] }) as unknown as TJoinedDmMessage;

const base = reducer(
  reducer(undefined, { type: '@@init' }),
  dmsSliceActions.setChannels([channel(1, 2), channel(2)])
);

describe('DM unread reducers', () => {
  test('incrementChannelUnread counts up; unknown channel is a no-op', () => {
    let s = reducer(base, dmsSliceActions.incrementChannelUnread(2));
    expect(s.channels[1].unreadCount).toBe(1);
    s = reducer(s, dmsSliceActions.incrementChannelUnread(99));
    expect(s.channels.map((c) => c.unreadCount)).toEqual([2, 1]);
  });

  test('clearChannelUnread zeroes one channel; unknown is a no-op', () => {
    let s = reducer(base, dmsSliceActions.clearChannelUnread(1));
    expect(s.channels[0].unreadCount).toBe(0);
    s = reducer(s, dmsSliceActions.clearChannelUnread(99));
    expect(s).toEqual(reducer(base, dmsSliceActions.clearChannelUnread(1)));
  });

  test('clearAllUnread zeroes every channel', () => {
    const s = reducer(
      reducer(base, dmsSliceActions.incrementChannelUnread(2)),
      dmsSliceActions.clearAllUnread()
    );
    expect(s.channels.map((c) => c.unreadCount)).toEqual([0, 0]);
  });

  test('updateChannelLastMessage replaces the snippet for that channel only', () => {
    let s = reducer(
      base,
      dmsSliceActions.updateChannelLastMessage({ dmChannelId: 1, lastMessage: message(5, 1) })
    );
    expect(s.channels[0].lastMessage?.id).toBe(5);
    expect(s.channels[1].lastMessage).toBeUndefined();
    s = reducer(
      s,
      dmsSliceActions.updateChannelLastMessage({ dmChannelId: 1, lastMessage: message(6, 1) })
    );
    expect(s.channels[0].lastMessage?.id).toBe(6);
    // Unknown channel: nothing changes.
    expect(
      reducer(s, dmsSliceActions.updateChannelLastMessage({ dmChannelId: 9, lastMessage: message(7, 9) }))
    ).toEqual(s);
  });

  test('applyReadState clears when the marker covers the newest message, else recounts', () => {
    let s = reducer(
      base,
      dmsSliceActions.updateChannelLastMessage({ dmChannelId: 1, lastMessage: message(5, 1) })
    );
    s = reducer(s, dmsSliceActions.addMessages({ dmChannelId: 1, messages: [message(3, 1), message(4, 1), message(5, 1)] }));
    expect(reducer(s, dmsSliceActions.applyReadState({ dmChannelId: 1, lastReadMessageId: 5 })).channels[0].unreadCount).toBe(0);
    expect(reducer(s, dmsSliceActions.applyReadState({ dmChannelId: 1, lastReadMessageId: 3 })).channels[0].unreadCount).toBe(2);
  });
});
