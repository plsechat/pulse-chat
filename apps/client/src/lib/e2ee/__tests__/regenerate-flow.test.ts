/**
 * Key regeneration ordering.
 *
 *  - The new identity is registered BEFORE it replaces the local one:
 *    a failed registration leaves the current keys untouched.
 *  - On success the home store carries exactly what the server holds
 *    (identity, signed prekey, OTP batch, seeded counters).
 *  - regenerateOwnKeys reports redistribution legs that failed instead
 *    of swallowing them, so the UI cannot show success over a partial
 *    failure.
 *
 * Run via: bun test apps/client/src/lib/e2ee/__tests__/regenerate-flow.test.ts
 */

import './instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  fakeTrpc,
  installModuleMocks,
  installClients,
  installHomeIdentity,
  resetInstanceState,
  setInstanceState,
  type Peer
} from './instance-harness';
// Re-assert the harness mocks (another file may have replaced them since
// the harness first loaded), then import the lib — a static import would
// bind index.ts to whatever modules were registered first.
installModuleMocks();
const { invalidateChannelMembers, regenerateOwnKeys, setupE2EEKeys } = await import('..');
const { getIdentityPublicKey } = await import('../signal-protocol');
const { SignalProtocolStore, signalStore } = await import('../store');

const ME_HOME = 10;

let restoreClients: (() => void) | null = null;
let me: Peer;

beforeEach(async () => {
  me = await installHomeIdentity();
  invalidateChannelMembers();
  await signalStore.markIdentityTofu(2, 'alice-key');
});

afterEach(async () => {
  restoreClients?.();
  restoreClients = null;
  resetInstanceState();
  await signalStore.clearAll();
});

describe("setupE2EEKeys('generate')", () => {
  test('a rejected registration leaves the current identity untouched', async () => {
    const home = fakeTrpc({
      'e2ee.registerKeys': () => {
        throw new Error('503 from server');
      }
    });
    restoreClients = installClients({ home });
    const signedBefore = await signalStore.loadSignedPreKey(1);

    await expect(setupE2EEKeys('generate')).rejects.toThrow('503 from server');

    expect(await getIdentityPublicKey()).toBe(me.identityPublicKey);
    expect(await signalStore.loadSignedPreKey(1)).toEqual(signedBefore);
    // Nothing else was wiped either — the pin from before survives.
    expect((await signalStore.getVerifiedIdentity(2))?.identityPublicKey).toBe('alice-key');
    // The scratch store is not left holding a private identity.
    expect(await new SignalProtocolStore('pulse-e2ee-scratch').hasLocalIdentity()).toBe(false);
  });

  test('a successful registration replaces the identity with what the server got', async () => {
    let registered: { identityPublicKey: string; oneTimePreKeys: { keyId: number }[] } | null =
      null;
    const home = fakeTrpc({
      'e2ee.registerKeys': (input) => {
        registered = input as typeof registered;
      }
    });
    restoreClients = installClients({ home });

    await setupE2EEKeys('generate');

    expect(registered).not.toBeNull();
    const newIdentity = await getIdentityPublicKey();
    expect(newIdentity).not.toBe(me.identityPublicKey);
    expect(newIdentity).toBe(registered!.identityPublicKey);
    expect(await signalStore.loadSignedPreKey(1)).toBeDefined();
    for (const otp of registered!.oneTimePreKeys) {
      expect(await signalStore.loadPreKey(otp.keyId)).toBeDefined();
    }
    expect(await signalStore.getNextOtpKeyId()).toBe(101);
    expect(await signalStore.getSignedPreKeyId()).toBe(1);
    // The old identity's pins are gone with it.
    expect(await signalStore.getVerifiedIdentity(2)).toBeUndefined();
    expect(await new SignalProtocolStore('pulse-e2ee-scratch').hasLocalIdentity()).toBe(false);
  });
});

describe('regenerateOwnKeys', () => {
  test('returns the redistribution legs that failed', async () => {
    const home = fakeTrpc({
      'e2ee.registerKeys': () => undefined,
      'e2ee.listMyE2eeChannelIds': () => {
        throw new Error('listing unavailable');
      }
    });
    restoreClients = installClients({ home });
    setInstanceState({ homeOwnUserId: ME_HOME });
    const registeredAfterCalls: number[] = [];

    const failures = await regenerateOwnKeys({
      onRegistered: () => {
        registeredAfterCalls.push(home.calls.length);
      }
    });

    expect(await getIdentityPublicKey()).not.toBe(me.identityPublicKey);
    // Fired once, after registerKeys and before the redistribution's
    // first call.
    expect(registeredAfterCalls).toEqual([1]);
    expect(failures).toEqual(['home (could not list encrypted channels)']);
  });

  test('a registration failure propagates and nothing is redistributed', async () => {
    const home = fakeTrpc({
      'e2ee.registerKeys': () => {
        throw new Error('offline');
      },
      'e2ee.listMyE2eeChannelIds': () => []
    });
    restoreClients = installClients({ home });
    setInstanceState({ homeOwnUserId: ME_HOME });

    await expect(regenerateOwnKeys()).rejects.toThrow('offline');
    expect(home.callsTo('e2ee.listMyE2eeChannelIds')).toHaveLength(0);
    expect(await getIdentityPublicKey()).toBe(me.identityPublicKey);
  });

  test('a clean run reports no failures', async () => {
    const home = fakeTrpc({
      'e2ee.registerKeys': () => undefined,
      'e2ee.listMyE2eeChannelIds': () => []
    });
    restoreClients = installClients({ home });
    setInstanceState({ homeOwnUserId: ME_HOME });

    expect(await regenerateOwnKeys()).toEqual([]);
  });
});
