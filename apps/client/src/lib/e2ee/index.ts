import { getHomeTRPCClient } from '@/lib/trpc';
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

// Re-export types and utilities
export type { E2EEPlaintext, PreKeyBundle } from './types';
export { encryptFile, decryptFile } from './file-crypto';
export { hasKeys, getIdentityPublicKey } from './signal-protocol';
export { signalStore } from './store';
