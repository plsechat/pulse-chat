/**
 * dms.reconcileActiveCalls — a fresh getActiveCalls snapshot after a
 * (re)connect.
 *
 *  - the roster becomes the snapshot (a call that ended while we were
 *    away is gone)
 *  - our own call survives only while the snapshot still lists us in it
 *  - with no own call there is nothing to clear
 *
 * Run via: bun test apps/client/src/features/dms/__tests__/active-calls-reconcile.test.ts
 */

import { describe, expect, test } from 'bun:test';
import type { TVoiceUserState } from '@pulse/shared';
import { dmsSliceActions, dmsSliceReducer as reducer } from '../slice';

const initial = reducer(undefined, { type: '@@init' });

const voiceState: TVoiceUserState = {
  micMuted: false,
  soundMuted: false,
  webcamEnabled: false,
  sharingScreen: false,
  serverMuted: false,
  serverDeafened: false
};

const inCall = (dmChannelId: number) => {
  let s = reducer(
    initial,
    dmsSliceActions.dmCallStarted({ dmChannelId, startedBy: 10 })
  );
  s = reducer(
    s,
    dmsSliceActions.dmCallUserJoined({
      dmChannelId,
      userId: 10,
      state: voiceState
    })
  );
  s = reducer(
    s,
    dmsSliceActions.dmCallUserJoined({
      dmChannelId,
      userId: 11,
      state: voiceState
    })
  );
  return reducer(s, dmsSliceActions.setOwnDmCallChannelId(dmChannelId));
};

describe('reconcileActiveCalls', () => {
  test('a call we are no longer listed in is dead: own call cleared', () => {
    const s = reducer(
      inCall(7),
      dmsSliceActions.reconcileActiveCalls({
        calls: [{ dmChannelId: 7, users: [{ userId: 11, state: voiceState }] }],
        ownUserId: 10
      })
    );

    expect(s.ownDmCallChannelId).toBeUndefined();
    expect(Object.keys(s.activeCalls[7]!.users)).toEqual(['11']);
  });

  test('a call that ended while we were away is gone, own call cleared', () => {
    const s = reducer(
      inCall(7),
      dmsSliceActions.reconcileActiveCalls({ calls: [], ownUserId: 10 })
    );

    expect(s.ownDmCallChannelId).toBeUndefined();
    expect(s.activeCalls).toEqual({});
  });

  test('a call that still lists us keeps the own call', () => {
    const s = reducer(
      inCall(7),
      dmsSliceActions.reconcileActiveCalls({
        calls: [
          {
            dmChannelId: 7,
            users: [
              { userId: 10, state: voiceState },
              { userId: 11, state: voiceState }
            ]
          }
        ],
        ownUserId: 10
      })
    );

    expect(s.ownDmCallChannelId).toBe(7);
    expect(Object.keys(s.activeCalls[7]!.users).sort()).toEqual(['10', '11']);
  });

  test('an unknown own id cannot vouch for the call', () => {
    const s = reducer(
      inCall(7),
      dmsSliceActions.reconcileActiveCalls({
        calls: [{ dmChannelId: 7, users: [{ userId: 10, state: voiceState }] }],
        ownUserId: undefined
      })
    );

    expect(s.ownDmCallChannelId).toBeUndefined();
  });

  test('the snapshot replaces the roster wholesale', () => {
    let s = reducer(
      initial,
      dmsSliceActions.dmCallStarted({ dmChannelId: 3, startedBy: 11 })
    );
    s = reducer(
      s,
      dmsSliceActions.reconcileActiveCalls({
        calls: [{ dmChannelId: 8, users: [{ userId: 12, state: voiceState }] }],
        ownUserId: 10
      })
    );

    expect(Object.keys(s.activeCalls)).toEqual(['8']);
    expect(s.ownDmCallChannelId).toBeUndefined();
  });
});
