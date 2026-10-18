/**
 * TOFU pins record the peer's stable (home) publicId so the safety
 * number can be derived from something every instance agrees on.
 *
 * `isTrustedIdentity` only knows a libsignal address (`${userId}.1`)
 * in the calling store's id-space, so the publicId has to come from the
 * Redux rosters at pin time — through the home-scoped selector for the
 * home store, through the ambient roster for a federated-instance store
 * and only while that instance is the active one.
 *
 * Run via: bun test apps/client/src/lib/e2ee/__tests__/verified-identity-public-id.test.ts
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { TJoinedPublicUser } from '@pulse/server/types';

// The e2ee store reads the Redux singleton; other test files in this
// suite replace that module process-wide with a stub whose dispatch is
// a no-op, so the state must be owned here and mutated directly rather
// than dispatched into whatever module happens to be registered.
const state = {
  app: { activeInstanceDomain: null as string | null, homeOwnUserId: 1 },
  server: { ownUserId: 1, users: [] as TJoinedPublicUser[] },
  friends: { friends: [] as TJoinedPublicUser[] },
  dms: { channels: [] as unknown[] }
};
mock.module('@/features/store', () => ({
  store: {
    getState: () => state,
    dispatch: () => undefined,
    subscribe: () => () => undefined
  }
}));

const { getStoreForInstance, signalStore } = await import('../store');

// libsignal's Direction enum: 1 = SENDING, 2 = RECEIVING. Only the
// address and key matter to the TOFU path.
const RECEIVING = 2;

const KEY = new Uint8Array(33).map((_, i) => (i * 7 + 5) & 0xff).buffer;
const OTHER_KEY = new Uint8Array(33).map((_, i) => (i * 11 + 3) & 0xff).buffer;

const user = (
  id: number,
  publicId: string,
  federatedPublicId: string | null = null
): TJoinedPublicUser =>
  ({
    id,
    name: `user-${id}`,
    publicId,
    federatedPublicId,
    roleIds: []
  }) as unknown as TJoinedPublicUser;

const REMOTE = 'remote.example';
const OTHER_REMOTE = 'other.example';

afterEach(async () => {
  state.server = { ownUserId: 1, users: [] };
  state.friends = { friends: [] };
  state.app = { activeInstanceDomain: null, homeOwnUserId: 1 };
  await signalStore.clearAll();
  await getStoreForInstance(REMOTE).clearAll();
  await getStoreForInstance(OTHER_REMOTE).clearAll();
});

describe('TOFU pin records the peer publicId', () => {
  test('home store: a local roster user pins with their publicId', async () => {
    state.server = { ownUserId: 1, users: [user(5, 'pid-5')] };

    expect(await signalStore.isTrustedIdentity('5.1', KEY, RECEIVING)).toBe(true);

    const pin = await signalStore.getVerifiedIdentity(5);
    expect(pin?.verifiedMethod).toBe('tofu');
    expect(pin?.publicId).toBe('pid-5');
  });

  test('home store: a federated DM peer pins with their HOME publicId, ignoring the active remote roster', async () => {
    // Viewing a federated server: the ambient roster is the remote's,
    // where id 7 is somebody else entirely. The DM peer (a shadow on
    // home) is known through the friends list with their home id.
    state.app = { activeInstanceDomain: REMOTE, homeOwnUserId: 1 };
    state.server = { ownUserId: 1, users: [user(7, 'remote-roster-7')] };
    state.friends = { friends: [user(7, 'shadow-random-on-home', 'home-pid-7')] };

    await signalStore.isTrustedIdentity('7.1', KEY, RECEIVING);

    expect((await signalStore.getVerifiedIdentity(7))?.publicId).toBe('home-pid-7');
  });

  test('instance store: pins from the ambient roster while that instance is active', async () => {
    state.app = { activeInstanceDomain: REMOTE, homeOwnUserId: 1 };
    state.server = {
      ownUserId: 1,
      users: [
        user(9, 'remote-pid-9'),
        user(10, 'shadow-on-remote', 'third-home-pid-10')
      ]
    };

    const remote = getStoreForInstance(REMOTE);
    await remote.isTrustedIdentity('9.1', KEY, RECEIVING);
    await remote.isTrustedIdentity('10.1', OTHER_KEY, RECEIVING);

    expect((await remote.getVerifiedIdentity(9))?.publicId).toBe('remote-pid-9');
    // A shadow on the remote still resolves to its home id.
    expect((await remote.getVerifiedIdentity(10))?.publicId).toBe('third-home-pid-10');
    // Nothing leaked into the home store's id-space.
    expect(await signalStore.getVerifiedIdentity(9)).toBeUndefined();
  });

  test('instance store: records no publicId when another instance is active (the roster is not its own)', async () => {
    state.app = { activeInstanceDomain: REMOTE, homeOwnUserId: 1 };
    state.server = { ownUserId: 1, users: [user(9, 'remote-pid-9')] };

    const other = getStoreForInstance(OTHER_REMOTE);
    expect(await other.isTrustedIdentity('9.1', KEY, RECEIVING)).toBe(true);

    const pin = await other.getVerifiedIdentity(9);
    expect(pin?.identityPublicKey).toBeDefined();
    expect(pin?.publicId).toBeUndefined();
  });

  test('unknown user still pins (no publicId) and a later mismatch is still refused', async () => {
    expect(await signalStore.isTrustedIdentity('42.1', KEY, RECEIVING)).toBe(true);
    expect((await signalStore.getVerifiedIdentity(42))?.publicId).toBeUndefined();
    expect(await signalStore.isTrustedIdentity('42.1', OTHER_KEY, RECEIVING)).toBe(false);
  });

  test('manual verification and a re-pin keep the recorded publicId unless a new one is supplied', async () => {
    await signalStore.markIdentityTofu(3, 'key-a', 'pid-3');

    await signalStore.markIdentityManual(3, 'key-a');
    let pin = await signalStore.getVerifiedIdentity(3);
    expect(pin?.verifiedMethod).toBe('manual');
    expect(pin?.publicId).toBe('pid-3');

    await signalStore.markIdentityTofu(3, 'key-b');
    pin = await signalStore.getVerifiedIdentity(3);
    expect(pin?.identityPublicKey).toBe('key-b');
    expect(pin?.publicId).toBe('pid-3');

    await signalStore.markIdentityManual(3, 'key-b', 'pid-3-corrected');
    expect((await signalStore.getVerifiedIdentity(3))?.publicId).toBe('pid-3-corrected');
  });
});
