import { describe, expect, test } from 'bun:test';
import { ServerEvents } from '@pulse/shared';
import { initTest } from '../../__tests__/helpers';
import { pubsub } from '../../utils/pubsub';

describe('e2ee router', () => {
  const mockKeys = {
    identityPublicKey: 'mock-identity-public-key-base64',
    registrationId: 12345,
    signedPreKey: {
      keyId: 1,
      publicKey: 'mock-signed-pre-key-public-base64',
      signature: 'mock-signature-base64'
    },
    oneTimePreKeys: [
      { keyId: 1, publicKey: 'mock-otp-1-base64' },
      { keyId: 2, publicKey: 'mock-otp-2-base64' },
      { keyId: 3, publicKey: 'mock-otp-3-base64' }
    ]
  };

  // --- registerKeys ---

  test('should register E2EE keys for a user', async () => {
    const { caller } = await initTest();

    await caller.e2ee.registerKeys(mockKeys);

    const count = await caller.e2ee.getPreKeyCount();
    expect(count).toBe(3);
  });

  test('should upsert identity key and replace keys on re-registration', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.e2ee.registerKeys(mockKeys);

    // Re-register with different keys (simulates key regeneration)
    await caller1.e2ee.registerKeys({
      ...mockKeys,
      identityPublicKey: 'updated-identity-key',
      signedPreKey: {
        keyId: 2,
        publicKey: 'new-signed-key',
        signature: 'new-signature'
      },
      oneTimePreKeys: [
        { keyId: 10, publicKey: 'new-otp-1' },
        { keyId: 11, publicKey: 'new-otp-2' }
      ]
    });

    // Old OTPs should be cleared, only new ones remain
    const count = await caller1.e2ee.getPreKeyCount();
    expect(count).toBe(2);

    // Bundle should reflect new signed pre-key (not old one)
    const bundle = await caller2.e2ee.getPreKeyBundle({ userId: 1 });
    expect(bundle!.identityPublicKey).toBe('updated-identity-key');
    expect(bundle!.signedPreKey.keyId).toBe(2);
    expect(bundle!.signedPreKey.publicKey).toBe('new-signed-key');
  });

  test('should register keys with empty OTP array', async () => {
    const { caller } = await initTest();

    await caller.e2ee.registerKeys({
      ...mockKeys,
      oneTimePreKeys: []
    });

    const count = await caller.e2ee.getPreKeyCount();
    expect(count).toBe(0);
  });

  // --- getPreKeyBundle ---

  test('should return pre-key bundle for a user', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    // User 1 registers keys
    await caller1.e2ee.registerKeys(mockKeys);

    // User 2 fetches user 1's bundle
    const bundle = await caller2.e2ee.getPreKeyBundle({ userId: 1 });

    expect(bundle).not.toBeNull();
    expect(bundle!.identityPublicKey).toBe(mockKeys.identityPublicKey);
    expect(bundle!.registrationId).toBe(mockKeys.registrationId);
    expect(bundle!.signedPreKey.keyId).toBe(mockKeys.signedPreKey.keyId);
    expect(bundle!.signedPreKey.publicKey).toBe(mockKeys.signedPreKey.publicKey);
    expect(bundle!.signedPreKey.signature).toBe(mockKeys.signedPreKey.signature);
    expect(bundle!.oneTimePreKey).not.toBeNull();
    expect(bundle!.oneTimePreKey!.publicKey).toBe('mock-otp-1-base64');
  });

  test('should consume one OTP per bundle fetch', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.e2ee.registerKeys(mockKeys);

    const countBefore = await caller1.e2ee.getPreKeyCount();
    expect(countBefore).toBe(3);

    // Fetch bundle (consumes 1 OTP)
    await caller2.e2ee.getPreKeyBundle({ userId: 1 });

    const countAfter = await caller1.e2ee.getPreKeyCount();
    expect(countAfter).toBe(2);
  });

  test('should return different OTPs on successive bundle fetches', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.e2ee.registerKeys(mockKeys);

    const bundle1 = await caller2.e2ee.getPreKeyBundle({ userId: 1 });
    const bundle2 = await caller2.e2ee.getPreKeyBundle({ userId: 1 });

    expect(bundle1!.oneTimePreKey!.keyId).not.toBe(
      bundle2!.oneTimePreKey!.keyId
    );
  });

  test('should return null OTP when all are consumed', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.e2ee.registerKeys({
      ...mockKeys,
      oneTimePreKeys: [{ keyId: 1, publicKey: 'single-otp' }]
    });

    // Consume the only OTP
    const bundle1 = await caller2.e2ee.getPreKeyBundle({ userId: 1 });
    expect(bundle1!.oneTimePreKey).not.toBeNull();

    // No OTPs left
    const bundle2 = await caller2.e2ee.getPreKeyBundle({ userId: 1 });
    expect(bundle2!.oneTimePreKey).toBeNull();
  });

  test('should return null for user with no keys', async () => {
    const { caller } = await initTest();

    const bundle = await caller.e2ee.getPreKeyBundle({ userId: 2 });
    expect(bundle).toBeNull();
  });

  // --- uploadOneTimePreKeys ---

  test('should upload additional OTPs', async () => {
    const { caller } = await initTest();

    await caller.e2ee.registerKeys(mockKeys);

    const countBefore = await caller.e2ee.getPreKeyCount();
    expect(countBefore).toBe(3);

    await caller.e2ee.uploadOneTimePreKeys({
      oneTimePreKeys: [
        { keyId: 100, publicKey: 'replenished-otp-1' },
        { keyId: 101, publicKey: 'replenished-otp-2' }
      ]
    });

    const countAfter = await caller.e2ee.getPreKeyCount();
    expect(countAfter).toBe(5);
  });

  test('should handle empty OTP upload', async () => {
    const { caller } = await initTest();

    await caller.e2ee.registerKeys(mockKeys);

    await caller.e2ee.uploadOneTimePreKeys({ oneTimePreKeys: [] });

    const count = await caller.e2ee.getPreKeyCount();
    expect(count).toBe(3);
  });

  // --- getPreKeyCount ---

  test('should return 0 for user with no keys', async () => {
    const { caller } = await initTest();

    const count = await caller.e2ee.getPreKeyCount();
    expect(count).toBe(0);
  });

  // --- rotateSignedPreKey ---

  test('should rotate signed pre-key', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.e2ee.registerKeys(mockKeys);

    await caller1.e2ee.rotateSignedPreKey({
      keyId: 99,
      publicKey: 'rotated-signed-key',
      signature: 'rotated-signature'
    });

    // Bundle should reflect the new signed pre-key (latest by createdAt)
    const bundle = await caller2.e2ee.getPreKeyBundle({ userId: 1 });

    expect(bundle!.signedPreKey.keyId).toBe(99);
    expect(bundle!.signedPreKey.publicKey).toBe('rotated-signed-key');
    expect(bundle!.signedPreKey.signature).toBe('rotated-signature');
  });

  // --- distributeSenderKey / getPendingSenderKeys ---

  test('should distribute and retrieve sender keys', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.e2ee.distributeSenderKey({
      channelId: 1,
      toUserId: 2,
      distributionMessage: 'encrypted-sender-key-data'
    });

    const pending = await caller2.e2ee.getPendingSenderKeys({});

    expect(pending.length).toBe(1);
    expect(pending[0]!.id).toBeDefined();
    expect(pending[0]!.channelId).toBe(1);
    expect(pending[0]!.fromUserId).toBe(1);
    expect(pending[0]!.distributionMessage).toBe('encrypted-sender-key-data');
  });

  test('should keep sender keys until acknowledged', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.e2ee.distributeSenderKey({
      channelId: 1,
      toUserId: 2,
      distributionMessage: 'key-data'
    });

    // First fetch returns the key
    const first = await caller2.e2ee.getPendingSenderKeys({});
    expect(first.length).toBe(1);
    expect(first[0]!.id).toBeDefined();

    // Second fetch should still return the key (not deleted yet)
    const second = await caller2.e2ee.getPendingSenderKeys({});
    expect(second.length).toBe(1);

    // Acknowledge the key
    await caller2.e2ee.acknowledgeSenderKeys({ ids: [first[0]!.id] });

    // Now it should be gone
    const third = await caller2.e2ee.getPendingSenderKeys({});
    expect(third.length).toBe(0);
  });

  test('should only allow acknowledging own sender keys', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.e2ee.distributeSenderKey({
      channelId: 1,
      toUserId: 2,
      distributionMessage: 'key-data'
    });

    const pending = await caller2.e2ee.getPendingSenderKeys({});

    // User 1 tries to acknowledge user 2's key — should not delete it
    await caller1.e2ee.acknowledgeSenderKeys({ ids: [pending[0]!.id] });

    // Key should still be there for user 2
    const stillPending = await caller2.e2ee.getPendingSenderKeys({});
    expect(stillPending.length).toBe(1);
  });

  test('should filter sender keys by channel', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.e2ee.distributeSenderKey({
      channelId: 1,
      toUserId: 2,
      distributionMessage: 'key-for-channel-1'
    });

    await caller1.e2ee.distributeSenderKey({
      channelId: 2,
      toUserId: 2,
      distributionMessage: 'key-for-channel-2'
    });

    const filtered = await caller2.e2ee.getPendingSenderKeys({ channelId: 1 });

    expect(filtered.length).toBe(1);
    expect(filtered[0]!.channelId).toBe(1);
  });

  test('should not return sender keys for other users', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    // Distribute to user 1 (not user 2)
    await caller2.e2ee.distributeSenderKey({
      channelId: 1,
      toUserId: 1,
      distributionMessage: 'key-for-user-1'
    });

    // User 2 should not see keys meant for user 1
    const pending = await caller2.e2ee.getPendingSenderKeys({});
    expect(pending.length).toBe(0);

    // User 1 should see the key
    const pendingForUser1 = await caller1.e2ee.getPendingSenderKeys({});
    expect(pendingForUser1.length).toBe(1);
  });

  // --- Key regeneration ---

  test('should allow re-registration without signed pre-key conflict', async () => {
    const { caller } = await initTest();

    // Register with keyId 1
    await caller.e2ee.registerKeys(mockKeys);

    // Re-register with the same signed pre-key keyId (should not conflict)
    await caller.e2ee.registerKeys({
      ...mockKeys,
      signedPreKey: {
        keyId: 1,
        publicKey: 'regenerated-signed-key',
        signature: 'regenerated-signature'
      },
      oneTimePreKeys: [{ keyId: 1, publicKey: 'regenerated-otp' }]
    });

    // Should succeed and only have the new OTP
    const count = await caller.e2ee.getPreKeyCount();
    expect(count).toBe(1);
  });

  test('should distribute sender keys to multiple users', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const { caller: caller3 } = await initTest(3);

    // User 1 distributes to user 2 and user 3
    await caller1.e2ee.distributeSenderKey({
      channelId: 1,
      toUserId: 2,
      distributionMessage: 'key-for-user-2'
    });
    await caller1.e2ee.distributeSenderKey({
      channelId: 1,
      toUserId: 3,
      distributionMessage: 'key-for-user-3'
    });

    const pending2 = await caller2.e2ee.getPendingSenderKeys({ channelId: 1 });
    expect(pending2.length).toBe(1);
    expect(pending2[0]!.distributionMessage).toBe('key-for-user-2');

    const pending3 = await caller3.e2ee.getPendingSenderKeys({ channelId: 1 });
    expect(pending3.length).toBe(1);
    expect(pending3[0]!.distributionMessage).toBe('key-for-user-3');
  });

  test('should handle multiple sender key distributions from different users', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const { caller: caller3 } = await initTest(3);

    // User 1 and User 2 both distribute keys to User 3
    await caller1.e2ee.distributeSenderKey({
      channelId: 1,
      toUserId: 3,
      distributionMessage: 'key-from-user-1'
    });
    await caller2.e2ee.distributeSenderKey({
      channelId: 1,
      toUserId: 3,
      distributionMessage: 'key-from-user-2'
    });

    const pending = await caller3.e2ee.getPendingSenderKeys({ channelId: 1 });
    expect(pending.length).toBe(2);

    const fromUser1 = pending.find((k) => k.fromUserId === 1);
    const fromUser2 = pending.find((k) => k.fromUserId === 2);
    expect(fromUser1!.distributionMessage).toBe('key-from-user-1');
    expect(fromUser2!.distributionMessage).toBe('key-from-user-2');
  });

  // --- getIdentityPublicKey ---

  test('should return identity public key for a user', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.e2ee.registerKeys(mockKeys);

    const key = await caller2.e2ee.getIdentityPublicKey({ userId: 1 });
    expect(key).toBe(mockKeys.identityPublicKey);
  });

  test('should return null for user with no identity key', async () => {
    const { caller } = await initTest();

    const key = await caller.e2ee.getIdentityPublicKey({ userId: 999 });
    expect(key).toBeNull();
  });

  // --- Key reset: stale distribution cleanup ---

  test('should delete stale sender key distributions on identity change', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    // Register initial keys for user 1
    await caller1.e2ee.registerKeys(mockKeys);

    // Distribute a sender key from user 1 to user 2
    await caller1.e2ee.distributeSenderKey({
      channelId: 1,
      toUserId: 2,
      distributionMessage: 'old-key-data'
    });

    // Distribute a sender key from user 2 to user 1
    await caller2.e2ee.distributeSenderKey({
      channelId: 1,
      toUserId: 1,
      distributionMessage: 'key-for-user-1'
    });

    // Verify distributions exist
    const pending2 = await caller2.e2ee.getPendingSenderKeys({});
    expect(pending2.length).toBe(1);
    const pending1 = await caller1.e2ee.getPendingSenderKeys({});
    expect(pending1.length).toBe(1);

    // User 1 re-registers with a NEW identity key (simulating key reset)
    await caller1.e2ee.registerKeys({
      ...mockKeys,
      identityPublicKey: 'completely-new-identity-key'
    });

    // All distributions involving user 1 should be deleted
    const pending2After = await caller2.e2ee.getPendingSenderKeys({});
    expect(pending2After.length).toBe(0);
    const pending1After = await caller1.e2ee.getPendingSenderKeys({});
    expect(pending1After.length).toBe(0);
  });

  test('should not delete distributions when re-registering with same identity', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.e2ee.registerKeys(mockKeys);

    await caller1.e2ee.distributeSenderKey({
      channelId: 1,
      toUserId: 2,
      distributionMessage: 'valid-key'
    });

    // Re-register with SAME identity key (e.g. OTP replenishment)
    await caller1.e2ee.registerKeys(mockKeys);

    // Distribution should still exist
    const pending = await caller2.e2ee.getPendingSenderKeys({});
    expect(pending.length).toBe(1);
    expect(pending[0]!.distributionMessage).toBe('valid-key');
  });

  // --- Identity reset broadcast ---

  test('should publish E2EE_IDENTITY_RESET when identity key changes', async () => {
    const { caller } = await initTest(1);
    const publishedEvents: { topic: string; payload: unknown }[] = [];
    const original = pubsub.publish.bind(pubsub);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsub as any).publish = (topic: string, payload: unknown) => {
      publishedEvents.push({ topic, payload });
      return original(topic as never, payload as never);
    };

    // Register initial keys
    await caller.e2ee.registerKeys(mockKeys);

    // Re-register with changed identity key
    await caller.e2ee.registerKeys({
      ...mockKeys,
      identityPublicKey: 'new-identity-key-for-reset'
    });

    // Verify the reset event was published
    const resetEvents = publishedEvents.filter(
      (e) => e.topic === ServerEvents.E2EE_IDENTITY_RESET
    );
    expect(resetEvents.length).toBe(1);
    expect(resetEvents[0]!.payload).toEqual({ userId: 1 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsub as any).publish = original;
  });

  test('should NOT publish E2EE_IDENTITY_RESET when re-registering with same key', async () => {
    const { caller } = await initTest(1);
    const publishedEvents: { topic: string; payload: unknown }[] = [];
    const original = pubsub.publish.bind(pubsub);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsub as any).publish = (topic: string, payload: unknown) => {
      publishedEvents.push({ topic, payload });
      return original(topic as never, payload as never);
    };

    // Register initial keys
    await caller.e2ee.registerKeys(mockKeys);
    publishedEvents.length = 0;

    // Re-register with same identity key
    await caller.e2ee.registerKeys(mockKeys);

    // No reset event should be published
    const resetEvents = publishedEvents.filter(
      (e) => e.topic === ServerEvents.E2EE_IDENTITY_RESET
    );
    expect(resetEvents.length).toBe(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsub as any).publish = original;
  });

  // --- Key backup ---

  test('should store and retrieve key backup', async () => {
    const { caller } = await initTest(1);

    await caller.e2ee.uploadKeyBackup({
      encryptedData: '{"version":2,"salt":"abc","iv":"def","ciphertext":"ghi"}'
    });

    const backup = await caller.e2ee.getKeyBackup();
    expect(backup).not.toBeNull();
    expect(backup!.encryptedData).toBe(
      '{"version":2,"salt":"abc","iv":"def","ciphertext":"ghi"}'
    );
  });

  test('should return null when no backup exists', async () => {
    const { caller } = await initTest(1);

    const backup = await caller.e2ee.getKeyBackup();
    expect(backup).toBeNull();
  });

  test('hasKeyBackup should return correct boolean', async () => {
    const { caller } = await initTest(1);

    const before = await caller.e2ee.hasKeyBackup();
    expect(before).toBe(false);

    await caller.e2ee.uploadKeyBackup({ encryptedData: 'encrypted-blob' });

    const after = await caller.e2ee.hasKeyBackup();
    expect(after).toBe(true);
  });

  test('should upsert key backup (uploading twice overwrites)', async () => {
    const { caller } = await initTest(1);

    await caller.e2ee.uploadKeyBackup({ encryptedData: 'first-backup' });
    await caller.e2ee.uploadKeyBackup({ encryptedData: 'second-backup' });

    const backup = await caller.e2ee.getKeyBackup();
    expect(backup!.encryptedData).toBe('second-backup');
  });

  test('key backups are per-user', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.e2ee.uploadKeyBackup({ encryptedData: 'user1-backup' });

    const backup1 = await caller1.e2ee.getKeyBackup();
    expect(backup1!.encryptedData).toBe('user1-backup');

    const backup2 = await caller2.e2ee.getKeyBackup();
    expect(backup2).toBeNull();
  });
});
