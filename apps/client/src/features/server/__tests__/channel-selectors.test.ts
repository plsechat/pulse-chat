import { describe, expect, test } from 'bun:test';
import type { TChannel } from '@pulse/shared';
import {
  channelByIdSelector,
  channelMentionCountByIdSelector,
  channelReadStateByIdSelector,
  lastReadMessageIdSelector
} from '@/features/server/channels/selectors';
import { serverSliceActions, serverSliceReducer as reducer } from '@/features/server/slice';
import type { IRootState } from '@/features/store';

const channel = (id: number) =>
  ({ id, name: `c${id}`, type: 'TEXT', categoryId: 1, position: id }) as unknown as TChannel;

const state = (() => {
  let server = reducer(undefined, { type: '@@init' });
  server = reducer(
    server,
    serverSliceActions.setInitialData({
      serverId: 'srv',
      categories: [],
      channels: [channel(1), channel(2)],
      ownUserId: 1,
      roles: [],
      channelPermissions: {},
      readStates: { 1: 3 },
      mentionStates: { 1: 1 },
      lastReadMessageIds: { 1: 40 }
    })
  );
  return { server } as unknown as IRootState;
})();

describe('channel read-state selectors', () => {
  test('known channel reports its counts and marker', () => {
    expect(channelReadStateByIdSelector(state, 1)).toBe(3);
    expect(channelMentionCountByIdSelector(state, 1)).toBe(1);
    expect(lastReadMessageIdSelector(state, 1)).toBe(40);
  });

  test('unseen channel: counts read as 0, marker undefined', () => {
    expect(channelReadStateByIdSelector(state, 2)).toBe(0);
    expect(channelMentionCountByIdSelector(state, 2)).toBe(0);
    expect(lastReadMessageIdSelector(state, 2)).toBeUndefined();
  });

  test('channelByIdSelector memoises per id', () => {
    const c1 = channelByIdSelector(state, 1);
    const c2 = channelByIdSelector(state, 2);
    expect(channelByIdSelector(state, 1)).toBe(c1);
    expect(channelByIdSelector(state, 2)).toBe(c2);
    expect(c1?.name).toBe('c1');
    expect(channelByIdSelector(state, 9)).toBeUndefined();
  });
});
