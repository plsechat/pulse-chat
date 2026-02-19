import { getHomeTRPCClient, getTRPCClient } from '@/lib/trpc';
import type { E2EEPlaintext, PreKeyBundle } from './types';
import {
  buildSession,
  decryptMessage,
  encryptMessage,
  generateKeys,
  generateOneTimePreKeys,
  generateSignedPreKey,
  getIdentityPublicKey,
  hasKeys,
  hasSession
} from './signal-protocol';
import {
  decryptWithSenderKey,
  encryptWithSenderKey,
  generateSenderKey,
  hasSenderKey,
  storeSenderKeyForUser
} from './sender-keys';
import {
  getActiveStore,
  getStoreForInstance,
  signalStore,
  type SignalProtocolStore
} from './store';

const OTP_REPLENISH_THRESHOLD = 25;
const OTP_REPLENISH_COUNT = 100;

// Track the next OTP key ID to avoid collisions
let nextOtpKeyId = 101; // Start after initial batch of 100

/**
 * Initialize E2EE on the home instance. Called once after auth.
 * If keys exist, replenishes OTPs. If not, does nothing — keys are
 * set up on demand via ensureE2EEKeys() when the user tries to
 * participate in an encrypted channel/DM.
 */
export async function initE2EE(): Promise<void> {
  const keysExist = await hasKeys();

  if (keysExist) {
    await replenishOTPsIfNeeded();
  }
}

/**
 * Set up E2EE keys. Called by the setup modal after the user chooses.
 * - mode 'restore': restores from server backup using passphrase
 * - mode 'generate': generates fresh keys and registers with server
 */
export async function setupE2EEKeys(
  mode: 'restore' | 'generate',
  passphrase?: string
): Promise<void> {
  if (mode === 'restore') {
    if (!passphrase) throw new Error('Passphrase required for restore');
    const { restoreBackupFromServer } = await import('./key-backup');
    await restoreBackupFromServer(passphrase);
    await replenishOTPsIfNeeded();
  } else {
    const trpc = getHomeTRPCClient();
    const keys = await generateKeys(OTP_REPLENISH_COUNT);
    await trpc.e2ee.registerKeys.mutate(keys);
  }
}

// Singleton state for the ensureE2EEKeys gate
let pendingSetup: Promise<void> | null = null;

/**
 * Gate that ensures E2EE keys exist before proceeding.
 * If keys exist, resolves immediately. If not, dispatches an
 * `e2ee-setup-needed` CustomEvent with resolve/reject callbacks
 * so the UI can show the setup modal. Returns a Promise that
 * resolves when the user completes setup or rejects on cancel.
 * Singleton: only one modal opens even if multiple operations trigger.
 */
export async function ensureE2EEKeys(): Promise<void> {
  if (await hasKeys()) return;

  if (pendingSetup) return pendingSetup;

  pendingSetup = new Promise<void>((resolve, reject) => {
    window.dispatchEvent(
      new CustomEvent('e2ee-setup-needed', {
        detail: { resolve, reject }
      })
    );
  }).finally(() => {
    pendingSetup = null;
  });

  return pendingSetup;
}

/**
 * Initialize E2EE on a federated instance by reusing the home identity.
 * Copies the home identity key pair into the per-instance store (which
 * keeps its own sessions and sender keys to avoid user-ID collisions),
 * then generates a fresh signed pre-key and OTPs and registers them
 * on the remote server.
 */
export async function initE2EEForInstance(domain: string): Promise<void> {
  await ensureE2EEKeys();

  const store = getStoreForInstance(domain);
  const keysExist = await hasKeys(store);

  // Detect if the home identity changed since we last copied it.
  // If so, wipe the stale per-instance store and re-register.
  const needsReRegister =
    keysExist && (await identityDrifted(store, signalStore));

  if (!keysExist || needsReRegister) {
    if (needsReRegister) {
      console.log(`[E2EE] Home identity changed — re-registering on ${domain}`);
      await store.clearAll();
    }

    // Copy the home identity (same key pair + registration ID) into the
    // per-instance store so all servers see the same cryptographic identity.
    await store.copyIdentityFrom(signalStore);

    // Generate a fresh signed pre-key (signed with the shared identity)
    const signedPreKey = await generateSignedPreKey(1, store);

    // Generate fresh OTPs for this instance (each server consumes independently)
    const oneTimePreKeys = await generateOneTimePreKeys(
      nextOtpKeyId,
      OTP_REPLENISH_COUNT,
      store
    );
    nextOtpKeyId += OTP_REPLENISH_COUNT;

    // Read public identity for registration
    const identityPubKey = await getIdentityPublicKey(store);
    const registrationId = await store.getLocalRegistrationId();

    // getTRPCClient() routes to remote when activeInstanceDomain is set
    const trpc = getTRPCClient();
    await trpc.e2ee.registerKeys.mutate({
      identityPublicKey: identityPubKey!,
      registrationId: registrationId!,
      signedPreKey,
      oneTimePreKeys
    });
    console.log(`[E2EE] Registered home identity on federated instance: ${domain}`);
    return;
  }

  // Check OTP count and replenish on remote if needed
  await replenishOTPsIfNeeded(store, getTRPCClient());
}

/**
 * Compare the identity public key in two stores.
 * Returns true if they differ (i.e. the home key was regenerated).
 */
async function identityDrifted(
  instanceStore: SignalProtocolStore,
  homeStore: SignalProtocolStore
): Promise<boolean> {
  const instanceKey = await getIdentityPublicKey(instanceStore);
  const homeKey = await getIdentityPublicKey(homeStore);
  if (!instanceKey || !homeKey) return true;
  return instanceKey !== homeKey;
}

/**
 * Check the server OTP count and replenish if below threshold.
 */
async function replenishOTPsIfNeeded(
  store?: SignalProtocolStore,
  trpc?: ReturnType<typeof getHomeTRPCClient>
): Promise<void> {
  const t = trpc ?? getHomeTRPCClient();
  const count = await t.e2ee.getPreKeyCount.query();

  if (count < OTP_REPLENISH_THRESHOLD) {
    const newKeys = await generateOneTimePreKeys(
      nextOtpKeyId,
      OTP_REPLENISH_COUNT,
      store
    );
    nextOtpKeyId += OTP_REPLENISH_COUNT;
    await t.e2ee.uploadOneTimePreKeys.mutate({
      oneTimePreKeys: newKeys
    });
  }
}

/**
 * Ensure we have a session with a user. If not, fetch their pre-key bundle
 * and establish one via X3DH.
 *
 * When `verifyIdentity` is true, checks whether the remote user's server-side
 * identity key still matches what we have stored locally. If it changed (key
 * reset), the stale session is cleared and a fresh one is built. This avoids
 * encrypting with an old session that the reset user can't decrypt.
 */
async function ensureSession(
  userId: number,
  opts?: {
    store?: SignalProtocolStore;
    trpc?: ReturnType<typeof getHomeTRPCClient>;
    verifyIdentity?: boolean;
  }
): Promise<void> {
  const s = opts?.store ?? signalStore;
  const trpc = opts?.trpc ?? getHomeTRPCClient();

  if (await hasSession(userId, s)) {
    if (opts?.verifyIdentity) {
      const serverKey = await trpc.e2ee.getIdentityPublicKey.query({ userId });
      const localKey = await s.getStoredIdentityKey(userId);

      if (serverKey && localKey && serverKey !== localKey) {
        // Identity changed — clear stale session so we rebuild below
        await s.clearUserSession(userId);
      } else {
        return;
      }
    } else {
      return;
    }
  }

  const bundle = await trpc.e2ee.getPreKeyBundle.query({ userId });

  if (!bundle) {
    throw new Error(`User ${userId} has no E2EE keys registered`);
  }

  await buildSession(userId, bundle as PreKeyBundle, s);
}

/**
 * Encrypt a DM message payload for a specific recipient.
 * Establishes a session first if needed.
 * Always uses home instance store + home tRPC.
 */
export async function encryptDmMessage(
  recipientUserId: number,
  payload: E2EEPlaintext
): Promise<string> {
  await ensureE2EEKeys();
  await ensureSession(recipientUserId);
  const plaintext = JSON.stringify(payload);
  return encryptMessage(recipientUserId, plaintext);
}

/**
 * Decrypt a DM message received from a specific sender.
 * Always uses home instance store.
 */
export async function decryptDmMessage(
  senderUserId: number,
  encryptedContent: string
): Promise<E2EEPlaintext> {
  const plaintext = await decryptMessage(senderUserId, encryptedContent);
  return JSON.parse(plaintext) as E2EEPlaintext;
}

// --- Channel E2EE (Sender Keys) ---

/**
 * Track which members have successfully received our sender key per channel.
 * Cleared on page reload, which forces re-distribution (safe & idempotent).
 */
const distributedMembers = new Map<number, Set<number>>();

/**
 * Remove a user from all distributedMembers sets, forcing re-distribution
 * on the next ensureChannelSenderKey call. Used when a user's identity
 * may have changed (key reset, reconnect).
 */
export function clearDistributedMember(userId: number): void {
  for (const members of distributedMembers.values()) {
    members.delete(userId);
  }
}

/**
 * Ensure we have a sender key for this channel and that it has been
 * distributed to all provided member IDs.
 *
 * On first call: generates a new AES-256-GCM key and distributes it.
 * On subsequent calls: re-distributes to any members who haven't received
 * the key yet (e.g. new members, or members whose first distribution failed).
 *
 * Uses the active instance store so it works on federated servers.
 */
export async function ensureChannelSenderKey(
  channelId: number,
  ownUserId: number,
  memberUserIds: number[]
): Promise<void> {
  await ensureE2EEKeys();
  const store = getActiveStore();
  const hasKey = await hasSenderKey(channelId, ownUserId, store);

  let keyBase64: string | undefined;

  if (!hasKey) {
    keyBase64 = await generateSenderKey(channelId, ownUserId, store);
    distributedMembers.set(channelId, new Set());
  }

  // Determine which members still need the key
  const distributed = distributedMembers.get(channelId) ?? new Set();
  const otherMembers = memberUserIds.filter(
    (id) => id !== ownUserId && !distributed.has(id)
  );

  if (otherMembers.length === 0) return;

  // Read key from store if we didn't just generate it
  if (!keyBase64) {
    keyBase64 = await store.getSenderKey(channelId, ownUserId);
    if (!keyBase64) {
      throw new Error(`Sender key not found for channel ${channelId}`);
    }
  }

  // Distribute the key to each member via Signal Protocol
  const trpc = getTRPCClient();

  for (const memberId of otherMembers) {
    try {
      await ensureSession(memberId, { store, trpc, verifyIdentity: true });
      const encryptedKey = await encryptMessage(memberId, keyBase64, store);
      await trpc.e2ee.distributeSenderKey.mutate({
        channelId,
        toUserId: memberId,
        distributionMessage: encryptedKey
      });
      distributed.add(memberId);
    } catch (err) {
      console.warn(
        `[E2EE] Failed to distribute sender key to user ${memberId}:`,
        err
      );
    }
  }

  distributedMembers.set(channelId, distributed);
}

/**
 * Process a received sender key distribution message.
 * Decrypts the key using Signal Protocol and stores it.
 * Uses the active instance store.
 */
export async function processIncomingSenderKey(
  channelId: number,
  fromUserId: number,
  distributionMessage: string
): Promise<void> {
  const store = getActiveStore();
  const keyBase64 = await decryptMessage(
    fromUserId,
    distributionMessage,
    store
  );
  await storeSenderKeyForUser(channelId, fromUserId, keyBase64, store);
}

/**
 * Dedup map to prevent concurrent fetches for the same channel from racing.
 * Without this, the subscription handler and message decrypt handler can both
 * fire concurrent HTTP requests and redundantly process the same keys.
 */
const activeSenderKeyFetches = new Map<
  number | undefined,
  Promise<void>
>();

/**
 * Fetch and process all pending sender keys from the server.
 * Uses the active instance store + active tRPC client.
 * Concurrent calls for the same channelId share one in-flight request.
 */
export function fetchAndProcessPendingSenderKeys(
  channelId?: number
): Promise<void> {
  const existing = activeSenderKeyFetches.get(channelId);
  if (existing) return existing;

  const promise = doFetchAndProcessPendingSenderKeys(channelId).finally(() => {
    activeSenderKeyFetches.delete(channelId);
  });
  activeSenderKeyFetches.set(channelId, promise);
  return promise;
}

async function doFetchAndProcessPendingSenderKeys(
  channelId?: number
): Promise<void> {
  const store = getActiveStore();
  const trpc = getTRPCClient();
  const pending = await trpc.e2ee.getPendingSenderKeys.query({
    channelId
  });

  const processedIds: number[] = [];

  for (const key of pending) {
    try {
      const keyBase64 = await decryptMessage(
        key.fromUserId,
        key.distributionMessage,
        store
      );
      await storeSenderKeyForUser(
        key.channelId,
        key.fromUserId,
        keyBase64,
        store
      );
      processedIds.push(key.id);
    } catch (err) {
      console.warn(
        `[E2EE] Failed to process sender key from user ${key.fromUserId}:`,
        err
      );
      // Don't add to processedIds — key stays on server for retry
    }
  }

  // Acknowledge successfully processed keys so the server can delete them
  if (processedIds.length > 0) {
    try {
      await trpc.e2ee.acknowledgeSenderKeys.mutate({ ids: processedIds });
    } catch {
      // Non-fatal: keys will be re-fetched and deduped on next attempt
    }
  }
}

/**
 * Encrypt a channel message payload using sender keys.
 * Uses the active instance store.
 */
export async function encryptChannelMessage(
  channelId: number,
  ownUserId: number,
  payload: E2EEPlaintext
): Promise<string> {
  await ensureE2EEKeys();
  const store = getActiveStore();
  const plaintext = JSON.stringify(payload);
  return encryptWithSenderKey(channelId, ownUserId, plaintext, store);
}

/**
 * Decrypt a channel message using the sender's key.
 * If the key is missing, tries to fetch pending keys first, with retries.
 * Uses the active instance store.
 */
export async function decryptChannelMessage(
  channelId: number,
  fromUserId: number,
  encryptedContent: string
): Promise<E2EEPlaintext> {
  const store = getActiveStore();

  // Try to fetch pending sender keys if we don't have this user's key
  if (!(await hasSenderKey(channelId, fromUserId, store))) {
    await fetchAndProcessPendingSenderKeys(channelId);
  }

  // If still missing, the distribution may still be in transit from the
  // sender — wait and retry with a fresh fetch from the server
  if (!(await hasSenderKey(channelId, fromUserId, store))) {
    await new Promise((r) => setTimeout(r, 1000));
    await fetchAndProcessPendingSenderKeys(channelId);
  }

  // Final retry with a longer wait
  if (!(await hasSenderKey(channelId, fromUserId, store))) {
    await new Promise((r) => setTimeout(r, 2000));
    await fetchAndProcessPendingSenderKeys(channelId);
  }

  try {
    const plaintext = await decryptWithSenderKey(
      channelId,
      fromUserId,
      encryptedContent,
      store
    );
    return JSON.parse(plaintext) as E2EEPlaintext;
  } catch {
    // Decryption failed — the sender may have reset keys. Fetch fresh
    // sender keys (which now always overwrites old keys) and retry once.
    await fetchAndProcessPendingSenderKeys(channelId);
    const plaintext = await decryptWithSenderKey(
      channelId,
      fromUserId,
      encryptedContent,
      store
    );
    return JSON.parse(plaintext) as E2EEPlaintext;
  }
}

// --- Key Reset Handling ---

/**
 * Flag to prevent the identity reset broadcast handler from reloading
 * the tab that initiated the reset. Set true before own key reset,
 * cleared after redistribution.
 */
let _isLocalReset = false;

export function setLocalResetFlag(value: boolean): void {
  _isLocalReset = value;
}

/**
 * Handle a peer (or own other-tab) identity reset broadcast.
 * - If userId matches our own and we didn't initiate it locally: reload
 *   (another tab reset our keys — IDB already updated, clear in-memory state)
 * - If peer: clear Signal session, clear distributedMembers for that user,
 *   then re-distribute own sender keys to them for all E2EE channels.
 */
export async function handlePeerIdentityReset(
  userId: number
): Promise<void> {
  const { store: reduxStore } = await import('@/features/store');
  const state = reduxStore.getState();
  const ownUserId = state.server.ownUserId;

  if (userId === ownUserId) {
    if (!_isLocalReset) {
      // Another tab reset our keys — reload to pick up new IDB state
      window.location.reload();
    }
    return;
  }

  // Peer reset their keys — clear our stale session with them
  const store = getActiveStore();
  await store.clearUserSession(userId);
  clearDistributedMember(userId);

  // Re-distribute own sender keys to the reset peer for all E2EE channels
  const channels = state.server.channels.filter((c) => c.e2ee);
  const users = state.server.users;

  for (const channel of channels) {
    const channelUserIds = users.map((u) => u.id);
    if (!channelUserIds.includes(userId)) continue;

    try {
      await ensureChannelSenderKey(channel.id, ownUserId!, [
        ownUserId!,
        userId
      ]);
    } catch (err) {
      console.warn(
        `[E2EE] Failed to re-distribute sender key to reset user ${userId} in channel ${channel.id}:`,
        err
      );
    }
  }
}

/**
 * After own key reset: clear all distributedMembers and re-distribute
 * new sender keys to all members of all E2EE channels.
 */
export async function redistributeOwnSenderKeys(): Promise<void> {
  const { store: reduxStore } = await import('@/features/store');
  const state = reduxStore.getState();
  const ownUserId = state.server.ownUserId;
  if (!ownUserId) return;

  // Clear all distribution tracking — we have new keys
  distributedMembers.clear();

  const channels = state.server.channels.filter((c) => c.e2ee);
  const users = state.server.users;

  for (const channel of channels) {
    const memberIds = users.map((u) => u.id);
    try {
      await ensureChannelSenderKey(channel.id, ownUserId, memberIds);
    } catch (err) {
      console.warn(
        `[E2EE] Failed to redistribute sender key for channel ${channel.id}:`,
        err
      );
    }
  }
}

// Re-export types and utilities
export type { E2EEPlaintext, PreKeyBundle } from './types';
export { encryptFile, decryptFile } from './file-crypto';
export { hasKeys, getIdentityPublicKey } from './signal-protocol';
export { signalStore, getActiveStore, getStoreForInstance } from './store';
