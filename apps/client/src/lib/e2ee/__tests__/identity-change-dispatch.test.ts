/**
 * presentIdentityChange — the identity-changed modal dispatcher.
 *
 * The e2e suite cannot reach this dialog (a hostile server is the only
 * trigger; see e2ee.spec.ts), so the dispatch contract is proven here:
 *   - concurrent calls for one (store, peer) share ONE modal and all
 *     resolve with the user's single decision;
 *   - a settled peer gets a fresh modal next time;
 *   - different peers, or the same peer in different stores, each get
 *     their own modal;
 *   - Accept / Verify re-pin and resolve true; Block blocks the user and
 *     resolves false, even when the block call fails.
 *
 * Sibling files replace this module process-wide with a recorder (see
 * instance-harness.ts) and bun module mocks cannot be restored, so the
 * real implementation is loaded through a query-suffixed specifier:
 * bun evaluates the source as a distinct module instance that no
 * `mock.module` registration matches. Its collaborators are spied on
 * their module namespaces, which patches the live bindings it imports.
 *
 * Run via: bun test apps/client/src/lib/e2ee/__tests__/identity-change-dispatch.test.ts
 */

import './instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Dialog } from '@/components/dialogs/dialogs';
import { ServerScreen } from '@/components/server-screens/screens';
import * as dialogActions from '@/features/dialogs/actions';
import * as friendsActions from '@/features/friends/actions';
import * as serverScreenActions from '@/features/server-screens/actions';
import type { SignalProtocolStore, VerifiedIdentityRecord } from '../store';

type DispatchModule = typeof import('../identity-change-dispatch');
const REAL_MODULE: string = '../identity-change-dispatch.ts?real';
const { presentIdentityChange } = (await import(REAL_MODULE)) as DispatchModule;

type DialogProps = {
  userId: number;
  newIdentityKey: string;
  previousIdentityKey?: string;
  previouslyVerifiedAt?: number;
  previousMethod?: string | null;
  localUserId: number | null;
  localIdentityKey: string | null;
  onAccept: () => Promise<void>;
  onVerifyNow: () => Promise<void>;
  onBlock: () => Promise<void>;
};

const openDialog = spyOn(dialogActions, 'openDialog');
const closeDialogs = spyOn(dialogActions, 'closeDialogs');
const blockUser = spyOn(friendsActions, 'blockUser');
const openServerScreen = spyOn(serverScreenActions, 'openServerScreen');

const dialogs = (): DialogProps[] =>
  openDialog.mock.calls.map((call) => call[1] as unknown as DialogProps);

/** Settle enough microtasks/macrotasks for the dispatcher's store reads. */
const flush = () => new Promise((r) => setTimeout(r, 5));

type FakeStore = SignalProtocolStore & { accepted: [number, string][] };

const OWN_PUB = new Uint8Array([1, 2, 3, 4]).buffer;

function fakeStore(opts: {
  verified?: VerifiedIdentityRecord;
  failRead?: boolean;
} = {}): FakeStore {
  const accepted: [number, string][] = [];
  const store = {
    accepted,
    getVerifiedIdentity: async () => {
      if (opts.failRead) throw new Error('idb unavailable');
      return opts.verified;
    },
    getIdentityKeyPair: async () => ({ pubKey: OWN_PUB, privKey: new ArrayBuffer(0) }),
    acceptIdentityChange: async (userId: number, key: string) => {
      accepted.push([userId, key]);
    }
  };
  return store as unknown as FakeStore;
}

beforeEach(() => {
  for (const spy of [openDialog, closeDialogs, blockUser, openServerScreen]) spy.mockReset();
  openDialog.mockImplementation(() => undefined);
  closeDialogs.mockImplementation(() => undefined);
  blockUser.mockImplementation(async () => undefined);
  openServerScreen.mockImplementation(() => undefined);
});

afterEach(() => {
  // Leave every pending modal settled so no promise outlives its test.
  for (const d of dialogs()) void d.onBlock();
});

describe('presentIdentityChange — single-modal collapse', () => {
  test('concurrent calls for one peer share one modal and one decision', async () => {
    const store = fakeStore();
    const first = presentIdentityChange(7, 'KEY-NEW', store);
    const second = presentIdentityChange(7, 'KEY-NEW', store);
    const third = presentIdentityChange(7, 'KEY-NEW', store);
    await flush();

    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(openDialog.mock.calls[0][0]).toBe(Dialog.IDENTITY_CHANGED);

    await dialogs()[0].onAccept();

    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    expect(store.accepted).toEqual([[7, 'KEY-NEW']]);
    expect(closeDialogs).toHaveBeenCalledTimes(1);
  });

  test('a call arriving while the modal is open joins it', async () => {
    const store = fakeStore();
    const first = presentIdentityChange(7, 'KEY-NEW', store);
    await flush();
    expect(openDialog).toHaveBeenCalledTimes(1);

    const late = presentIdentityChange(7, 'KEY-NEW', store);
    await flush();
    expect(openDialog).toHaveBeenCalledTimes(1);

    await dialogs()[0].onBlock();
    expect(await first).toBe(false);
    expect(await late).toBe(false);
  });

  test('after the decision the next change for that peer opens a new modal', async () => {
    const store = fakeStore();
    const first = presentIdentityChange(7, 'KEY-1', store);
    await flush();
    await dialogs()[0].onAccept();
    await first;

    const second = presentIdentityChange(7, 'KEY-2', store);
    await flush();
    expect(openDialog).toHaveBeenCalledTimes(2);
    expect(dialogs()[1].newIdentityKey).toBe('KEY-2');
    await dialogs()[1].onAccept();
    expect(await second).toBe(true);
    expect(store.accepted).toEqual([[7, 'KEY-1'], [7, 'KEY-2']]);
  });

  test('different peers get separate modals', async () => {
    const store = fakeStore();
    const a = presentIdentityChange(7, 'KEY-A', store);
    const b = presentIdentityChange(8, 'KEY-B', store);
    await flush();
    expect(openDialog).toHaveBeenCalledTimes(2);
    expect(dialogs().map((d) => d.userId).sort()).toEqual([7, 8]);

    await dialogs().find((d) => d.userId === 7)!.onAccept();
    await dialogs().find((d) => d.userId === 8)!.onBlock();
    expect(await a).toBe(true);
    expect(await b).toBe(false);
  });

  test('the same peer id in different stores is a different person: separate modals', async () => {
    const home = fakeStore();
    const federated = fakeStore();
    const a = presentIdentityChange(7, 'KEY-A', home);
    const b = presentIdentityChange(7, 'KEY-B', federated);
    await flush();
    expect(openDialog).toHaveBeenCalledTimes(2);

    await dialogs()[0].onAccept();
    await dialogs()[1].onAccept();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(home.accepted).toEqual([[7, 'KEY-A']]);
    expect(federated.accepted).toEqual([[7, 'KEY-B']]);
  });

  test('a failed store read rejects the caller and clears the pending slot', async () => {
    const broken = fakeStore({ failRead: true });
    await expect(presentIdentityChange(7, 'KEY', broken)).rejects.toThrow('idb unavailable');
    expect(openDialog).not.toHaveBeenCalled();

    // The slot is free again: a working store opens the modal.
    const ok = fakeStore();
    const next = presentIdentityChange(7, 'KEY', ok);
    await flush();
    expect(openDialog).toHaveBeenCalledTimes(1);
    await dialogs()[0].onBlock();
    expect(await next).toBe(false);
  });
});

describe('presentIdentityChange — dialog contract', () => {
  test('the modal receives the previous pin and the local identity inputs', async () => {
    const verified: VerifiedIdentityRecord = {
      identityPublicKey: 'KEY-OLD',
      verifiedAt: 1234,
      verifiedMethod: 'manual'
    };
    const store = fakeStore({ verified });
    const pending = presentIdentityChange(7, 'KEY-NEW', store);
    await flush();

    const props = dialogs()[0];
    expect(props).toMatchObject({
      userId: 7,
      newIdentityKey: 'KEY-NEW',
      previousIdentityKey: 'KEY-OLD',
      previouslyVerifiedAt: 1234,
      previousMethod: 'manual',
      localIdentityKey: btoa(String.fromCharCode(1, 2, 3, 4))
    });
    expect(typeof props.localUserId === 'number' || props.localUserId === null).toBe(true);

    await props.onBlock();
    await pending;
  });

  test('with no previous pin the modal gets null/undefined previous fields', async () => {
    const store = fakeStore();
    const pending = presentIdentityChange(7, 'KEY-NEW', store);
    await flush();
    const props = dialogs()[0];
    expect(props.previousIdentityKey).toBeUndefined();
    expect(props.previouslyVerifiedAt).toBeUndefined();
    expect(props.previousMethod).toBeNull();
    await props.onBlock();
    await pending;
  });

  test('Verify now re-pins, closes, opens the verify page for that peer and resolves true', async () => {
    const store = fakeStore();
    const pending = presentIdentityChange(7, 'KEY-NEW', store);
    await flush();

    await dialogs()[0].onVerifyNow();

    expect(await pending).toBe(true);
    expect(store.accepted).toEqual([[7, 'KEY-NEW']]);
    expect(closeDialogs).toHaveBeenCalledTimes(1);
    expect(openServerScreen).toHaveBeenCalledWith(ServerScreen.USER_SETTINGS, {
      initialSection: 'verify-identity',
      initialVerifyPeerId: 7
    });
  });

  test('Block blocks the user, leaves the pin alone and resolves false', async () => {
    const store = fakeStore();
    const pending = presentIdentityChange(7, 'KEY-NEW', store);
    await flush();

    await dialogs()[0].onBlock();

    expect(await pending).toBe(false);
    expect(blockUser).toHaveBeenCalledWith(7);
    expect(store.accepted).toEqual([]);
    expect(closeDialogs).toHaveBeenCalledTimes(1);
  });

  test('a failing block call still closes the modal and resolves false', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      blockUser.mockImplementation(async () => {
        throw new Error('offline');
      });
      const store = fakeStore();
      const pending = presentIdentityChange(7, 'KEY-NEW', store);
      await flush();

      await dialogs()[0].onBlock();

      expect(await pending).toBe(false);
      expect(closeDialogs).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });
});
