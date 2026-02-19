import { getHomeTRPCClient, getTRPCClient } from '@/lib/trpc';
import type { E2EEPlaintext, PreKeyBundle } from './types';
import {
  buildSession,
  decryptMessage,
  encryptMessage,
  generateKeys,
  generateOneTimePreKeys,
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
  type SignalProtocolStore
} from './store';

const OTP_REPLENISH_THRESHOLD = 25;
const OTP_REPLENISH_COUNT = 100;

// Track the next OTP key ID to avoid collisions
let nextOtpKeyId = 101; // Start after initial batch of 100

/**
 * Initialize E2EE keys on the home instance. Called once after auth.
 * If the user has no keys, generate and register them with the server.
 * If they have keys, check OTP count and replenish if needed.
 */
export async function initE2EE(): Promise<void> {
  const keysExist = await hasKeys();

  if (!keysExist) {
    const keys = await generateKeys(OTP_REPLENISH_COUNT);
    const trpc = getHomeTRPCClient();
    await trpc.e2ee.registerKeys.mutate(keys);
    return;
  }

  // Check OTP count and replenish if needed
  await replenishOTPsIfNeeded();
}

/**
 * Initialize E2EE keys on a federated instance.
 * Generates a separate identity and registers it with the remote server.
 */
export async function initE2EEForInstance(domain: string): Promise<void> {
  const store = getStoreForInstance(domain);
  const keysExist = await hasKeys(store);

  if (!keysExist) {
    const keys = await generateKeys(OTP_REPLENISH_COUNT, store);
    // getTRPCClient() routes to remote when activeInstanceDomain is set
    const trpc = getTRPCClient();
    await trpc.e2ee.registerKeys.mutate(keys);
    console.log(`[E2EE] Registered keys on federated instance: ${domain}`);
    return;
  }

  // Check OTP count and replenish on remote if needed
  await replenishOTPsIfNeeded(store, getTRPCClient());
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
 * For DM callers: use defaults (home store, home tRPC).
 * For channel callers on federated instances: pass the instance store + remote tRPC.
 */
async function ensureSession(
  userId: number,
  opts?: {
    store?: SignalProtocolStore;
    trpc?: ReturnType<typeof getHomeTRPCClient>;
  }
): Promise<void> {
  const store = opts?.store;
  if (await hasSession(userId, store)) return;

  const trpc = opts?.trpc ?? getHomeTRPCClient();
  const bundle = await trpc.e2ee.getPreKeyBundle.query({ userId });

  if (!bundle) {
    throw new Error(`User ${userId} has no E2EE keys registered`);
  }

  await buildSession(userId, bundle as PreKeyBundle, store);
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
      await ensureSession(memberId, { store, trpc });
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
      // Skip Signal Protocol decryption if we already have this sender's key
      if (await hasSenderKey(key.channelId, key.fromUserId, store)) {
        processedIds.push(key.id);
        continue;
      }

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

  const plaintext = await decryptWithSenderKey(
    channelId,
    fromUserId,
    encryptedContent,
    store
  );
  return JSON.parse(plaintext) as E2EEPlaintext;
}

// Re-export types and utilities
export type { E2EEPlaintext, PreKeyBundle } from './types';
export { encryptFile, decryptFile } from './file-crypto';
export { hasKeys, getIdentityPublicKey } from './signal-protocol';
export { signalStore, getActiveStore, getStoreForInstance } from './store';
