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
 * Ensure we have a sender key for this channel.
 * If not, generate one and distribute it to all provided member IDs.
 * Uses the active instance store so it works on federated servers.
 */
export async function ensureChannelSenderKey(
  channelId: number,
  ownUserId: number,
  memberUserIds: number[]
): Promise<void> {
  const store = getActiveStore();
  if (await hasSenderKey(channelId, ownUserId, store)) return;

  const keyBase64 = await generateSenderKey(channelId, ownUserId, store);

  // Distribute the key to each member via Signal Protocol
  const trpc = getTRPCClient();
  const otherMembers = memberUserIds.filter((id) => id !== ownUserId);

  for (const memberId of otherMembers) {
    try {
      await ensureSession(memberId, { store, trpc });
      const encryptedKey = await encryptMessage(memberId, keyBase64, store);
      await trpc.e2ee.distributeSenderKey.mutate({
        channelId,
        toUserId: memberId,
        distributionMessage: encryptedKey
      });
    } catch (err) {
      console.warn(
        `[E2EE] Failed to distribute sender key to user ${memberId}:`,
        err
      );
    }
  }
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
 * Fetch and process all pending sender keys from the server.
 * Uses the active instance store + active tRPC client.
 */
export async function fetchAndProcessPendingSenderKeys(
  channelId?: number
): Promise<void> {
  const store = getActiveStore();
  const trpc = getTRPCClient();
  const pending = await trpc.e2ee.getPendingSenderKeys.query({
    channelId
  });

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
    } catch (err) {
      console.warn(
        `[E2EE] Failed to process sender key from user ${key.fromUserId}:`,
        err
      );
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
 * If the key is missing, tries to fetch pending keys first.
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
