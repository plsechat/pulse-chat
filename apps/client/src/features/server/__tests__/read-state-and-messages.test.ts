/**
 * The New-messages-divider bookkeeping in setSelectedChannelId and the
 * pagination invariants of addMessages (A10-10 #4, #5).
 */
import { describe, expect, test } from 'bun:test';
import type { TJoinedMessage } from '@pulse/shared';
import {
  type IServerState,
  serverSliceActions,
  serverSliceReducer as reducer
} from '../slice';

const initial = reducer(undefined, { type: '@@init' });
const msg = (id: number, createdAt = id) =>
  ({ id, channelId: 1, userId: 2, content: `m${id}`, createdAt, files: [], reactions: [] }) as unknown as TJoinedMessage;

const withLoaded = () =>
  reducer(
    initial,
    serverSliceActions.addMessages({ channelId: 1, messages: [msg(1), msg(2), msg(3)] })
  );

describe('setSelectedChannelId', () => {
  test('selecting zeroes the unread/mention counters and drops the thread', () => {
    let s: IServerState = {
      ...initial,
      readStatesMap: { 1: 4 },
      mentionStatesMap: { 1: 2 },
      activeThreadId: 77
    };
    s = reducer(s, serverSliceActions.setSelectedChannelId(1));
    expect(s.selectedChannelId).toBe(1);
    expect(s.readStatesMap[1]).toBe(0);
    expect(s.mentionStatesMap[1]).toBe(0);
    expect(s.activeThreadId).toBeUndefined();
  });

  test('leaving a channel advances its last-read marker to the newest LOADED id', () => {
    let s = reducer(withLoaded(), serverSliceActions.setSelectedChannelId(1));
    s = reducer(s, serverSliceActions.setSelectedChannelId(2));
    expect(s.lastReadMessageIdMap[1]).toBe(3);
    expect(s.selectedChannelId).toBe(2);
  });

  test('never moves the marker backwards', () => {
    let s: IServerState = { ...withLoaded(), lastReadMessageIdMap: { 1: 10 } };
    s = reducer(s, serverSliceActions.setSelectedChannelId(1));
    s = reducer(s, serverSliceActions.setSelectedChannelId(undefined));
    expect(s.lastReadMessageIdMap[1]).toBe(10);
    expect(s.selectedChannelId).toBeUndefined();
  });

  test('re-selecting the same channel leaves the marker alone', () => {
    let s = reducer(withLoaded(), serverSliceActions.setSelectedChannelId(1));
    s = reducer(s, serverSliceActions.setSelectedChannelId(1));
    expect(s.lastReadMessageIdMap[1]).toBeUndefined();
  });

  test('a channel with nothing loaded gets no marker', () => {
    let s = reducer(initial, serverSliceActions.setSelectedChannelId(5));
    s = reducer(s, serverSliceActions.setSelectedChannelId(6));
    expect(s.lastReadMessageIdMap[5]).toBeUndefined();
  });
});

describe('addMessages', () => {
  test('dedupes by id', () => {
    let s = withLoaded();
    s = reducer(s, serverSliceActions.addMessages({ channelId: 1, messages: [msg(3), msg(4)] }));
    expect(s.messagesMap[1].map((m) => m.id)).toEqual([1, 2, 3, 4]);
  });

  test('prepend keeps the page order ahead of the loaded tail', () => {
    let s = reducer(initial, serverSliceActions.addMessages({ channelId: 1, messages: [msg(5), msg(6)] }));
    s = reducer(
      s,
      serverSliceActions.addMessages({ channelId: 1, messages: [msg(1), msg(2)], opts: { prepend: true } })
    );
    expect(s.messagesMap[1].map((m) => m.id)).toEqual([1, 2, 5, 6]);
  });

  test('the result is sorted by createdAt regardless of arrival order', () => {
    const s = reducer(
      initial,
      serverSliceActions.addMessages({ channelId: 1, messages: [msg(3, 30), msg(1, 10), msg(2, 20)] })
    );
    expect(s.messagesMap[1].map((m) => m.id)).toEqual([1, 2, 3]);
  });
});
