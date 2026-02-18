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

const OTP_REPLENISH_THRESHOLD = 25;
const OTP_REPLENISH_COUNT = 100;

// Track the next OTP key ID to avoid collisions
let nextOtpKeyId = 101; // Start after initial batch of 100

/**
 * Initialize E2EE keys. Called once after auth.
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
 * Check the server OTP count and replenish if below threshold.
 */
async function replenishOTPsIfNeeded(): Promise<void> {
  const trpc = getHomeTRPCClient();
  const count = await trpc.e2ee.getPreKeyCount.query();

  if (count < OTP_REPLENISH_THRESHOLD) {
    const newKeys = await generateOneTimePreKeys(
      nextOtpKeyId,
      OTP_REPLENISH_COUNT
    );
    nextOtpKeyId += OTP_REPLENISH_COUNT;
    await trpc.e2ee.uploadOneTimePreKeys.mutate({
      oneTimePreKeys: newKeys
    });
  }
}

/**
 * Ensure we have a session with a user. If not, fetch their pre-key bundle
 * and establish one via X3DH.
 */
async function ensureSession(userId: number): Promise<void> {
  if (await hasSession(userId)) return;

  const trpc = getHomeTRPCClient();
  const bundle = await trpc.e2ee.getPreKeyBundle.query({ userId });

  if (!bundle) {
    throw new Error(`User ${userId} has no E2EE keys registered`);
  }

  await buildSession(userId, bundle as PreKeyBundle);
}

/**
 * Encrypt a DM message payload for a specific recipient.
 * Establishes a session first if needed.
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
 */
export async function ensureChannelSenderKey(
  channelId: number,
  ownUserId: number,
  memberUserIds: number[]
): Promise<void> {
  if (await hasSenderKey(channelId, ownUserId)) return;

  const keyBase64 = await generateSenderKey(channelId, ownUserId);

  // Distribute the key to each member via Signal Protocol
  const trpc = getTRPCClient();
  const otherMembers = memberUserIds.filter((id) => id !== ownUserId);

  for (const memberId of otherMembers) {
    try {
      await ensureSession(memberId);
      const encryptedKey = await encryptMessage(memberId, keyBase64);
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
 */
export async function processIncomingSenderKey(
  channelId: number,
  fromUserId: number,
  distributionMessage: string
): Promise<void> {
  const keyBase64 = await decryptMessage(fromUserId, distributionMessage);
  await storeSenderKeyForUser(channelId, fromUserId, keyBase64);
}

/**
 * Fetch and process all pending sender keys from the server.
 */
export async function fetchAndProcessPendingSenderKeys(
  channelId?: number
): Promise<void> {
  const trpc = getTRPCClient();
  const pending = await trpc.e2ee.getPendingSenderKeys.query({
    channelId
  });

  for (const key of pending) {
    try {
      await processIncomingSenderKey(
        key.channelId,
        key.fromUserId,
        key.distributionMessage
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
 */
export async function encryptChannelMessage(
  channelId: number,
  ownUserId: number,
  payload: E2EEPlaintext
): Promise<string> {
  const plaintext = JSON.stringify(payload);
  return encryptWithSenderKey(channelId, ownUserId, plaintext);
}

/**
 * Decrypt a channel message using the sender's key.
 * If the key is missing, tries to fetch pending keys first.
 */
export async function decryptChannelMessage(
  channelId: number,
  fromUserId: number,
  encryptedContent: string
): Promise<E2EEPlaintext> {
  // Try to fetch pending sender keys if we don't have this user's key
  if (!(await hasSenderKey(channelId, fromUserId))) {
    await fetchAndProcessPendingSenderKeys(channelId);
  }

  const plaintext = await decryptWithSenderKey(
    channelId,
    fromUserId,
    encryptedContent
  );
  return JSON.parse(plaintext) as E2EEPlaintext;
}

// Re-export types and utilities
export type { E2EEPlaintext, PreKeyBundle } from './types';
export { encryptFile, decryptFile } from './file-crypto';
export { hasKeys, getIdentityPublicKey } from './signal-protocol';
export { signalStore } from './store';
