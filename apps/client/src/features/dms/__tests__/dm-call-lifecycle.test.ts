/**
 * A DM call's local session ends on every path, not only on a successful
 * voiceLeave: the leave clears Redux before its mutate (a deleted channel
 * makes the server reject it), the channel disappearing takes its call
 * with it, and a server-side end or eviction tears the session down.
 *
 * Run via:
 *   bun test apps/client/src/features/dms/__tests__/dm-call-lifecycle.test.ts
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { toast } from 'sonner';
import type { TVoiceUserState } from '@pulse/shared';
import { appSliceActions } from '@/features/app/slice';
import {
  dmCallEnded,
  leaveDmVoiceCall,
  removeDmChannel
} from '@/features/dms/actions';
import { dmsSliceActions } from '@/features/dms/slice';
import { setCurrentVoiceChannelId } from '@/features/server/channels/actions';
import { serverSliceActions } from '@/features/server/slice';
import {
  addUserToVoiceChannel,
  removeUserFromVoiceChannel,
  setPinnedCard
} from '@/features/server/voice/actions';
import * as sounds from '@/features/server/sounds/actions';
import { store } from '@/features/store';
import * as trpcModule from '@/lib/trpc';

const voice: TVoiceUserState = {
  micMuted: false,
  soundMuted: false,
  webcamEnabled: false,
  sharingScreen: false,
  serverMuted: false,
  serverDeafened: false
};

type Snapshot = {
  ownDmCallChannelId: number | undefined;
  currentVoiceChannelId: number | undefined;
  currentVoiceKind: string | undefined;
};
const snapshot = (): Snapshot => {
  const s = store.getState();
  return {
    ownDmCallChannelId: s.dms.ownDmCallChannelId,
    currentVoiceChannelId: s.server.currentVoiceChannelId,
    currentVoiceKind: s.server.currentVoiceKind
  };
};
const ended: Snapshot = {
  ownDmCallChannelId: undefined,
  currentVoiceChannelId: undefined,
  currentVoiceKind: undefined
};

/** The session's client (a DM call is pinned to home); its
 *  dms.voiceLeave records the Redux state it saw. */
const fakeHome = (impl: () => Promise<unknown>) =>
  ({ dms: { voiceLeave: { mutate: impl } } }) as unknown as ReturnType<
    typeof trpcModule.getVoiceTRPCClient
  >;

const inDmCall = (dmChannelId: number) => {
  store.dispatch(dmsSliceActions.dmCallStarted({ dmChannelId, startedBy: 7 }));
  store.dispatch(
    dmsSliceActions.dmCallUserJoined({ dmChannelId, userId: 7, state: voice })
  );
  store.dispatch(dmsSliceActions.setOwnDmCallChannelId(dmChannelId));
  setCurrentVoiceChannelId(dmChannelId, 'dm');
  addUserToVoiceChannel(7, dmChannelId, 'dm', voice);
  setPinnedCard({ id: 'user-7', type: 'user', userId: 7 } as never);
};

const spies: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
  spies.push(spyOn(toast, 'info').mockImplementation((() => 1) as never));
  spies.push(spyOn(toast, 'error').mockImplementation((() => 1) as never));
  spies.push(spyOn(sounds, 'playSound').mockImplementation(() => {}));
  store.dispatch(appSliceActions.setHomeOwnUserId(7));
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  store.dispatch(dmsSliceActions.resetState());
  store.dispatch(serverSliceActions.resetState());
});

describe('leaveDmVoiceCall', () => {
  test('clears the session before the mutate, and keeps it cleared when the server rejects', async () => {
    inDmCall(5);
    let seenDuringMutate: Snapshot | undefined;
    spies.push(
      spyOn(trpcModule, 'getVoiceTRPCClient').mockReturnValue(
        fakeHome(async () => {
          seenDuringMutate = snapshot();
          throw new Error('Not in a DM voice call');
        })
      )
    );

    await leaveDmVoiceCall();

    expect(seenDuringMutate).toEqual(ended);
    expect(snapshot()).toEqual(ended);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  test('does nothing when not in a call', async () => {
    const mutate = spyOn({ m: async () => undefined }, 'm');
    spies.push(
      spyOn(trpcModule, 'getVoiceTRPCClient').mockReturnValue(
        fakeHome(mutate as never)
      )
    );
    await leaveDmVoiceCall();
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('a DM channel disappearing', () => {
  test('takes its call, ring and our session with it', () => {
    inDmCall(5);
    store.dispatch(dmsSliceActions.dmCallStarted({ dmChannelId: 6, startedBy: 8 }));
    store.dispatch(dmsSliceActions.addRingingCall(5));
    store.dispatch(dmsSliceActions.addRingingCall(6));

    removeDmChannel(5);

    const dms = store.getState().dms;
    expect(snapshot()).toEqual(ended);
    expect(store.getState().server.pinnedCard).toBeUndefined();
    expect(dms.activeCalls[5]).toBeUndefined();
    expect(dms.activeCalls[6]).toBeDefined();
    expect(dms.ringingCalls).toEqual([6]);
  });

  test('leaves a call in another channel alone', () => {
    inDmCall(5);
    removeDmChannel(6);
    expect(snapshot()).toEqual({
      ownDmCallChannelId: 5,
      currentVoiceChannelId: 5,
      currentVoiceKind: 'dm'
    });
  });
});

describe('DM_CALL_ENDED', () => {
  test('ends our session when the server ended the call under us', () => {
    inDmCall(5);
    dmCallEnded(5);
    expect(snapshot()).toEqual(ended);
    expect(store.getState().dms.activeCalls[5]).toBeUndefined();
  });

  test('after our own leave it only drops the call entry', () => {
    inDmCall(5);
    // Our leave cleared the marker first; a same-id server channel session
    // that happens to exist must not be touched by the DM call ending.
    store.dispatch(dmsSliceActions.setOwnDmCallChannelId(undefined));
    setCurrentVoiceChannelId(5);
    dmCallEnded(5);
    expect(snapshot()).toEqual({
      ownDmCallChannelId: undefined,
      currentVoiceChannelId: 5,
      currentVoiceKind: 'channel'
    });
  });
});

describe('USER_LEAVE_VOICE for ourselves', () => {
  test('in the DM keyspace tears the DM session down', () => {
    inDmCall(5);
    removeUserFromVoiceChannel(7, 5, 'dm');
    expect(snapshot()).toEqual(ended);
    expect(toast.info).toHaveBeenCalledWith(
      'You were disconnected from the call'
    );
  });

  test('in the channel keyspace leaves the DM session alone', () => {
    inDmCall(5);
    removeUserFromVoiceChannel(7, 5, 'channel');
    expect(snapshot()).toEqual({
      ownDmCallChannelId: 5,
      currentVoiceChannelId: 5,
      currentVoiceKind: 'dm'
    });
    expect(toast.info).not.toHaveBeenCalled();
  });
});
