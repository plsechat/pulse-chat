import { describe, expect, test } from 'bun:test';
import { initTest } from '../../__tests__/helpers';

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

  test('should upsert identity key on re-registration', async () => {
    const { caller } = await initTest();

    await caller.e2ee.registerKeys(mockKeys);

    // Re-register with different identity key
    await caller.e2ee.registerKeys({
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

    // Should have original 3 + new 2 OTPs
    const count = await caller.e2ee.getPreKeyCount();
    expect(count).toBe(5);
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
    expect(pending[0]!.channelId).toBe(1);
    expect(pending[0]!.fromUserId).toBe(1);
    expect(pending[0]!.distributionMessage).toBe('encrypted-sender-key-data');
  });

  test('should delete sender keys after fetching', async () => {
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

    // Second fetch should be empty (keys were deleted)
    const second = await caller2.e2ee.getPendingSenderKeys({});
    expect(second.length).toBe(0);
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
});
