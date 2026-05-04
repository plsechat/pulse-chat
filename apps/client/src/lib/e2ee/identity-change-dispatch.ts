/**
 * Identity-change dialog dispatch.
 *
 * When `isTrustedIdentity` rejects a key (Phase C — different from the
 * pinned `verifiedIdentities` entry), libsignal throws `Identity key
 * changed`. The session-establishment path catches that, calls
 * `presentIdentityChange` to surface the modal, and either retries on
 * Accept or throws `UntrustedIdentityError` to the caller.
 *
 * Concurrent throws for the same (store, userId) collapse to a single
 * modal — every caller awaits the same Promise. This keeps a busy
 * conversation from stacking up N modals when N pending decrypt
 * attempts all fail on the same identity mismatch.
 */

import { Dialog } from '@/components/dialogs/dialogs';
import { ServerScreen } from '@/components/server-screens/screens';
import { closeDialogs, openDialog } from '@/features/dialogs/actions';
import { blockUser } from '@/features/friends/actions';
import { openServerScreen } from '@/features/server-screens/actions';
import type { SignalProtocolStore } from './store';
import { notifyVerifiedIdentityChanged } from './use-verified-identity';
import { arrayBufferToBase64 } from './utils';

const pendingByStore = new WeakMap<
  SignalProtocolStore,
  Map<number, Promise<boolean>>
>();

function getPendingMap(
  store: SignalProtocolStore
): Map<number, Promise<boolean>> {
  let m = pendingByStore.get(store);
  if (!m) {
    m = new Map();
    pendingByStore.set(store, m);
  }
  return m;
}

/**
 * Surface the identity-changed modal for `userId` and resolve with
 * the user's choice (true = accept/verify, false = block/cancel).
 *
 * Multiple concurrent calls for the same peer in the same store
 * collapse into one modal — they all await the same Promise.
 */
export async function presentIdentityChange(
  userId: number,
  newIdentityPublicKey: string,
  store: SignalProtocolStore
): Promise<boolean> {
  const map = getPendingMap(store);
  const existing = map.get(userId);
  if (existing) return existing;

  const previous = await store.getVerifiedIdentity(userId);

  // Pre-compute the local identity inputs needed for safety-number
  // rendering. The dialog stays purely presentational — it doesn't
  // need to know which store it's operating against.
  const ownKeyPair = await store.getIdentityKeyPair();
  const localIdentityKey = ownKeyPair
    ? arrayBufferToBase64(ownKeyPair.pubKey)
    : null;
  const { store: reduxStore } = await import('@/features/store');
  const localUserId = reduxStore.getState().server.ownUserId ?? null;

  const pending = new Promise<boolean>((resolve) => {
    openDialog(Dialog.IDENTITY_CHANGED, {
      userId,
      newIdentityKey: newIdentityPublicKey,
      previousIdentityKey: previous?.identityPublicKey,
      previouslyVerifiedAt: previous?.verifiedAt,
      previousMethod: previous?.verifiedMethod ?? null,
      localUserId,
      localIdentityKey,
      onAccept: async () => {
        await store.acceptIdentityChange(userId, newIdentityPublicKey);
        notifyVerifiedIdentityChanged();
        closeDialogs();
        resolve(true);
      },
      onVerifyNow: async () => {
        // Tentatively re-pin so the session can be re-established now.
        // The settings page below is where the user flips the resulting
        // 'tofu' record to 'manual' after comparing in person.
        await store.acceptIdentityChange(userId, newIdentityPublicKey);
        notifyVerifiedIdentityChanged();
        closeDialogs();
        openServerScreen(ServerScreen.USER_SETTINGS, {
          initialSection: 'verify-identity',
          initialVerifyPeerId: userId
        });
        resolve(true);
      },
      onBlock: async () => {
        try {
          await blockUser(userId);
        } catch (err) {
          console.error('[E2EE] blockUser failed during identity-change flow:', err);
        }
        closeDialogs();
        resolve(false);
      }
    });
  });

  map.set(userId, pending);
  pending.finally(() => map.delete(userId));
  return pending;
}

export class UntrustedIdentityError extends Error {
  readonly userId: number;
  readonly newIdentityPublicKey: string;
  constructor(userId: number, newIdentityPublicKey: string) {
    super(`Untrusted identity for user ${userId}`);
    this.name = 'UntrustedIdentityError';
    this.userId = userId;
    this.newIdentityPublicKey = newIdentityPublicKey;
  }
}
