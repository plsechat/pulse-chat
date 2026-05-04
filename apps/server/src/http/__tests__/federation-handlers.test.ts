/**
 * Phase D — federation HTTP handler integration tests.
 *
 * Each test fabricates a signed request as if it came from a peer
 * instance using `_signChallengeAs`, posts it to the test HTTP
 * server, and asserts on response status, response signature,
 * persisted DB state, and pubsub events.
 *
 * Setup is done inline in each test (no beforeEach) to avoid
 * piling row inserts onto the global setup.ts TRUNCATE in a way
 * that competes with parallel test files for table-level locks.
 *
 * Covers:
 *   - POST /federation/get-prekey-bundle (D1)
 *   - POST /federation/dm-group-create / dm-group-add-member /
 *     dm-group-remove-member (D2)
 *   - POST /federation/dm-sender-key (D2)
 *   - POST /federation/identity-rotation-broadcast (D3)
 *
 * Each handler is exercised on the happy path plus the most
 * security-critical rejection paths (unsigned, wrong key, unknown
 * peer, idempotency).
 */

import { ServerEvents } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { config } from '../../config';
import { db } from '../../db';
import {
  dmChannelMembers,
  dmChannels,
  dmE2eeSenderKeys,
  federationInstances,
  userIdentityKeys,
  userOneTimePreKeys,
  userSignedPreKeys,
  users
} from '../../db/schema';
import { initTest } from '../../__tests__/helpers';
import { testsBaseUrl } from '../../__tests__/setup';
import {
  _resetSeenJtis,
  _signChallengeAs,
  generateFederationKeys
} from '../../utils/federation';
import { _resetBundleFetchRateLimit } from '../../utils/bundle-fetch-rate-limit';
import { pubsub } from '../../utils/pubsub';

// The mock-modules default has federation disabled; the handlers
// short-circuit with 403 in that state. Every assertion in this file
// expects the handler logic past the enabled-check, so flip the flag
// at module load. Bun's per-test-file matrix and the chunked-shard
// matrix both isolate the mutation to this Bun process; no other
// test asserts on the "Federation not enabled" branch.
config.federation.enabled = true;

const PEER_DOMAIN = 'peer.example';
const TEST_LOCAL_DOMAIN = 'test.local'; // matches setup.ts mock

type PeerSetup = {
  peerInstanceId: number;
  peerPrivateJwk: JWK;
};

/**
 * Create the local instance's federation keys + a peer
 * instance row signed with the peer's own keypair so
 * `verifyChallenge` will accept signatures forged with the peer key.
 */
async function seedPeer(): Promise<PeerSetup> {
  _resetSeenJtis();
  _resetBundleFetchRateLimit();
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    extractable: true
  });
  const peerPublicJwk = await exportJWK(publicKey);
  const peerPrivateJwk = await exportJWK(privateKey);

  const [instance] = await db
    .insert(federationInstances)
    .values({
      domain: PEER_DOMAIN,
      name: 'Peer',
      status: 'active',
      direction: 'outgoing',
      publicKey: JSON.stringify(peerPublicJwk),
      createdAt: Date.now()
    })
    .returning();

  // Local keys are needed because signedJsonResponse signs responses
  // with the local instance's federation key. Keys are reset by the
  // global beforeEach TRUNCATE so they always need re-generation.
  await generateFederationKeys();

  return {
    peerInstanceId: instance!.id,
    peerPrivateJwk
  };
}

async function postSignedAsPeer(
  path: string,
  payload: Record<string, unknown>,
  peerPrivateJwk: JWK
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const bodyToSign = { ...payload, fromDomain: PEER_DOMAIN };
  const signature = await _signChallengeAs(
    bodyToSign,
    PEER_DOMAIN,
    TEST_LOCAL_DOMAIN,
    peerPrivateJwk
  );
  const fullBody = { ...bodyToSign, signature };

  const res = await fetch(`${testsBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fullBody)
  });
  let body: Record<string, unknown> | null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/**
 * Set up a complete pre-key bundle for user 1 (the test owner).
 * Returns the OTPK count after seeding so tests can verify
 * decrement-by-one semantics.
 */
async function seedBundleForUser(userId: number): Promise<number> {
  const now = Date.now();
  await db
    .insert(userIdentityKeys)
    .values({
      userId,
      identityPublicKey: 'identity-pk-base64',
      registrationId: 12345,
      createdAt: now
    })
    .onConflictDoUpdate({
      target: userIdentityKeys.userId,
      set: { identityPublicKey: 'identity-pk-base64', registrationId: 12345 }
    });

  await db.insert(userSignedPreKeys).values({
    userId,
    keyId: 1,
    publicKey: 'spk-pk-base64',
    signature: 'spk-sig-base64',
    createdAt: now
  });

  await db.insert(userOneTimePreKeys).values([
    { userId, keyId: 100, publicKey: 'otpk-100', createdAt: now },
    { userId, keyId: 101, publicKey: 'otpk-101', createdAt: now + 1 },
    { userId, keyId: 102, publicKey: 'otpk-102', createdAt: now + 2 }
  ]);

  return 3;
}

async function getUserPublicId(userId: number): Promise<string> {
  const [u] = await db
    .select({ publicId: users.publicId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u!.publicId!;
}

function withPubsubSpy<T>(
  fn: (events: { topic: string; payload: unknown }[]) => Promise<T>
): Promise<T> {
  const events: { topic: string; payload: unknown }[] = [];
  const original = pubsub.publishFor.bind(pubsub);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pubsub as any).publishFor = (
    userIds: unknown,
    topic: string,
    payload: unknown
  ) => {
    events.push({ topic, payload });
    return original(userIds as never, topic as never, payload as never);
  };
  const restore = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsub as any).publishFor = original;
  };
  return fn(events).finally(restore);
}

describe('POST /federation/get-prekey-bundle (D1)', () => {
  test('returns the user bundle on a valid signed request', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const targetPublicId = await getUserPublicId(1);
    await seedBundleForUser(1);

    const res = await postSignedAsPeer(
      '/federation/get-prekey-bundle',
      { targetPublicId },
      peerPrivateJwk
    );

    expect(res.status).toBe(200);
    expect(res.body?.identityPublicKey).toBe('identity-pk-base64');
    expect(res.body?.registrationId).toBe(12345);
    expect(typeof res.body?.signature).toBe('string'); // D0 response sig
    expect(res.body?.fromDomain).toBe(TEST_LOCAL_DOMAIN);
  });

  test('claims one OTPK per call (FIFO)', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const targetPublicId = await getUserPublicId(1);
    await seedBundleForUser(1);

    const res = await postSignedAsPeer(
      '/federation/get-prekey-bundle',
      { targetPublicId },
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    const otpk = res.body?.oneTimePreKey as { keyId: number } | null;
    expect(otpk?.keyId).toBe(100); // oldest first

    const remaining = await db
      .select()
      .from(userOneTimePreKeys)
      .where(eq(userOneTimePreKeys.userId, 1));
    expect(remaining).toHaveLength(2);
    expect(remaining.find((k) => k.keyId === 100)).toBeUndefined();
  });

  test('rejects unsigned requests', async () => {
    await initTest();
    await seedPeer();

    const res = await fetch(`${testsBaseUrl}/federation/get-prekey-bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromDomain: PEER_DOMAIN,
        targetPublicId: 'whatever'
      })
    });
    expect(res.status).toBe(400);
  });

  test('rejects requests signed with a key not registered for the claimed peer', async () => {
    await initTest();
    await seedPeer();
    const targetPublicId = await getUserPublicId(1);
    await seedBundleForUser(1);

    // Generate a DIFFERENT keypair — not the one stored in the
    // federation_instances row for PEER_DOMAIN.
    const { privateKey: otherPriv } = await generateKeyPair('EdDSA', {
      extractable: true
    });
    const otherPrivJwk = await exportJWK(otherPriv);

    const res = await postSignedAsPeer(
      '/federation/get-prekey-bundle',
      { targetPublicId },
      otherPrivJwk
    );
    expect(res.status).toBe(401);
  });

  test('rejects requests from an unknown peer domain', async () => {
    await initTest();
    // Don't seed the peer instance row at all.
    const { privateKey } = await generateKeyPair('EdDSA', {
      extractable: true
    });
    const privJwk = await exportJWK(privateKey);

    const res = await postSignedAsPeer(
      '/federation/get-prekey-bundle',
      { targetPublicId: 'doesnt-matter' },
      privJwk
    );
    expect(res.status).toBe(403);
  });

  test('returns 404 when the target user has no identity key', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const targetPublicId = await getUserPublicId(1);
    // No seedBundleForUser → no identity_key row.

    const res = await postSignedAsPeer(
      '/federation/get-prekey-bundle',
      { targetPublicId },
      peerPrivateJwk
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /federation/dm-group-create (D2)', () => {
  test('creates a local mirror channel with the announced federationGroupId', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const localPublicId = await getUserPublicId(1);

    const federationGroupId = 'fed-group-1';
    const res = await postSignedAsPeer(
      '/federation/dm-group-create',
      {
        federationGroupId,
        name: 'Test Federated Group',
        ownerPublicId: 'remote-owner-pid',
        members: [
          { publicId: 'remote-owner-pid', instanceDomain: PEER_DOMAIN, name: 'Remote Owner' },
          { publicId: localPublicId, instanceDomain: TEST_LOCAL_DOMAIN, name: 'Local' }
        ]
      },
      peerPrivateJwk
    );

    expect(res.status).toBe(200);

    const [channel] = await db
      .select()
      .from(dmChannels)
      .where(eq(dmChannels.federationGroupId, federationGroupId))
      .limit(1);
    expect(channel).toBeDefined();
    expect(channel!.isGroup).toBe(true);
    expect(channel!.name).toBe('Test Federated Group');

    const members = await db
      .select()
      .from(dmChannelMembers)
      .where(eq(dmChannelMembers.dmChannelId, channel!.id));
    expect(members).toHaveLength(2);
  });

  test('is idempotent — re-announcing returns alreadyExists', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const localPublicId = await getUserPublicId(1);

    const payload = {
      federationGroupId: 'fed-group-idem',
      name: 'Idempotent',
      ownerPublicId: 'remote-owner-pid',
      members: [
        { publicId: 'remote-owner-pid', instanceDomain: PEER_DOMAIN, name: 'Remote' },
        { publicId: localPublicId, instanceDomain: TEST_LOCAL_DOMAIN, name: 'Local' }
      ]
    };

    const first = await postSignedAsPeer(
      '/federation/dm-group-create',
      payload,
      peerPrivateJwk
    );
    expect(first.status).toBe(200);

    _resetSeenJtis(); // allow a second signed body without replay rejection
    const second = await postSignedAsPeer(
      '/federation/dm-group-create',
      payload,
      peerPrivateJwk
    );
    expect(second.status).toBe(200);
    expect(second.body?.alreadyExists).toBe(true);

    const channels = await db
      .select()
      .from(dmChannels)
      .where(eq(dmChannels.federationGroupId, 'fed-group-idem'));
    expect(channels).toHaveLength(1); // not duplicated
  });

  test('refuses to mirror a group with no local member', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    const res = await postSignedAsPeer(
      '/federation/dm-group-create',
      {
        federationGroupId: 'fed-no-local',
        name: 'No Local Members',
        ownerPublicId: 'remote-1-pid',
        members: [
          { publicId: 'remote-1-pid', instanceDomain: PEER_DOMAIN, name: 'Remote 1' },
          { publicId: 'remote-2-pid', instanceDomain: PEER_DOMAIN, name: 'Remote 2' }
        ]
      },
      peerPrivateJwk
    );
    expect(res.status).toBe(404);

    const [channel] = await db
      .select()
      .from(dmChannels)
      .where(eq(dmChannels.federationGroupId, 'fed-no-local'))
      .limit(1);
    expect(channel).toBeUndefined();
  });
});

describe('POST /federation/dm-group-add-member (D2)', () => {
  test('adds a federated member to an existing mirror', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const localPublicId = await getUserPublicId(1);

    // Seed an existing mirror via dm-group-create
    await postSignedAsPeer(
      '/federation/dm-group-create',
      {
        federationGroupId: 'fed-add-member',
        name: 'Add Member Test',
        ownerPublicId: 'remote-owner-pid',
        members: [
          { publicId: 'remote-owner-pid', instanceDomain: PEER_DOMAIN, name: 'Remote' },
          { publicId: localPublicId, instanceDomain: TEST_LOCAL_DOMAIN, name: 'Local' }
        ]
      },
      peerPrivateJwk
    );
    _resetSeenJtis();

    const res = await postSignedAsPeer(
      '/federation/dm-group-add-member',
      {
        federationGroupId: 'fed-add-member',
        addedMember: {
          publicId: 'remote-new-pid',
          instanceDomain: PEER_DOMAIN,
          name: 'New Remote'
        }
      },
      peerPrivateJwk
    );
    expect(res.status).toBe(200);

    const [channel] = await db
      .select({ id: dmChannels.id })
      .from(dmChannels)
      .where(eq(dmChannels.federationGroupId, 'fed-add-member'))
      .limit(1);
    const members = await db
      .select()
      .from(dmChannelMembers)
      .where(eq(dmChannelMembers.dmChannelId, channel!.id));
    expect(members.length).toBe(3); // owner + local + new remote
  });

  test('returns 404 when the federationGroupId is unknown', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    const res = await postSignedAsPeer(
      '/federation/dm-group-add-member',
      {
        federationGroupId: 'non-existent',
        addedMember: {
          publicId: 'whoever',
          instanceDomain: PEER_DOMAIN,
          name: 'Whoever'
        }
      },
      peerPrivateJwk
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /federation/dm-sender-key (D2)', () => {
  test('writes a per-recipient SKDM and pubsub-publishes to the recipient', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const localPublicId = await getUserPublicId(1);

    await postSignedAsPeer(
      '/federation/dm-group-create',
      {
        federationGroupId: 'fed-skdm',
        name: 'SKDM Test',
        ownerPublicId: 'remote-sender-pid',
        members: [
          { publicId: 'remote-sender-pid', instanceDomain: PEER_DOMAIN, name: 'Remote Sender' },
          { publicId: localPublicId, instanceDomain: TEST_LOCAL_DOMAIN, name: 'Local' }
        ]
      },
      peerPrivateJwk
    );
    _resetSeenJtis();

    await withPubsubSpy(async (events) => {
      const res = await postSignedAsPeer(
        '/federation/dm-sender-key',
        {
          federationGroupId: 'fed-skdm',
          senderKeyId: 1,
          fromPublicId: 'remote-sender-pid',
          toPublicId: localPublicId,
          distributionMessage: 'opaque-skdm-base64'
        },
        peerPrivateJwk
      );
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(dmE2eeSenderKeys)
        .where(eq(dmE2eeSenderKeys.toUserId, 1));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.distributionMessage).toBe('opaque-skdm-base64');
      expect(rows[0]!.senderKeyId).toBe(1);

      const distrEvents = events.filter(
        (e) => e.topic === 'dmSenderKeyDistribution'
      );
      expect(distrEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  test('returns 404 when the federationGroupId mirror does not exist', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const localPublicId = await getUserPublicId(1);

    const res = await postSignedAsPeer(
      '/federation/dm-sender-key',
      {
        federationGroupId: 'no-such-group',
        senderKeyId: 1,
        fromPublicId: 'whoever',
        toPublicId: localPublicId,
        distributionMessage: 'opaque'
      },
      peerPrivateJwk
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /federation/identity-rotation-broadcast (D3)', () => {
  test('pubsub-publishes E2EE_IDENTITY_RESET to local users sharing a DM with the rotating peer', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();

    // Create a shadow user representing the rotating peer.
    const [shadow] = await db
      .insert(users)
      .values({
        supabaseId: 'shadow-rotator',
        name: 'Rotator',
        publicId: 'shadow-publicid',
        isFederated: true,
        federatedInstanceId: peerInstanceId,
        federatedPublicId: 'remote-rotator-pid',
        createdAt: Date.now()
      })
      .returning();

    // Put shadow into a DM with local user 1.
    const [dm] = await db
      .insert(dmChannels)
      .values({ isGroup: false, createdAt: Date.now() })
      .returning();
    await db.insert(dmChannelMembers).values([
      { dmChannelId: dm!.id, userId: 1, createdAt: Date.now() },
      { dmChannelId: dm!.id, userId: shadow!.id, createdAt: Date.now() }
    ]);

    await withPubsubSpy(async (events) => {
      const res = await postSignedAsPeer(
        '/federation/identity-rotation-broadcast',
        {
          fromPublicId: 'remote-rotator-pid',
          newIdentityPublicKey: 'new-identity-pk-base64'
        },
        peerPrivateJwk
      );
      expect(res.status).toBe(200);

      const resetEvents = events.filter(
        (e) => e.topic === 'e2eeIdentityReset'
      );
      expect(resetEvents.length).toBe(1);
      const payload = resetEvents[0]!.payload as {
        userId: number;
        newIdentityPublicKey?: string;
      };
      expect(payload.userId).toBe(shadow!.id);
      expect(payload.newIdentityPublicKey).toBe('new-identity-pk-base64');
    });
  });

  test('skipped when no shadow user exists for the rotating peer', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    const res = await postSignedAsPeer(
      '/federation/identity-rotation-broadcast',
      {
        fromPublicId: 'unknown-peer-pid',
        newIdentityPublicKey: 'new-key'
      },
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    expect(res.body?.skipped).toBe('no shadow user');
  });
});

describe('POST /federation/dm-channel-state-update (E2)', () => {
  test('group: updates e2ee flag on a federationGroupId mirror and pubsubs to local members', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const localPublicId = await getUserPublicId(1);

    const federationGroupId = 'fed-group-state-1';
    // Seed a mirror channel via the group-create handler so the
    // shape matches a real federated group.
    await postSignedAsPeer(
      '/federation/dm-group-create',
      {
        federationGroupId,
        name: 'State Test Group',
        ownerPublicId: 'remote-owner-pid',
        members: [
          { publicId: 'remote-owner-pid', instanceDomain: PEER_DOMAIN, name: 'Remote' },
          { publicId: localPublicId, instanceDomain: TEST_LOCAL_DOMAIN, name: 'Local' }
        ]
      },
      peerPrivateJwk
    );

    _resetSeenJtis();

    const events = await withPubsubSpy(async (collected) => {
      const res = await postSignedAsPeer(
        '/federation/dm-channel-state-update',
        { federationGroupId, e2ee: true },
        peerPrivateJwk
      );
      expect(res.status).toBe(200);
      expect(res.body?.applied).toBe(true);
      return collected;
    });

    const [channel] = await db
      .select({ e2ee: dmChannels.e2ee, id: dmChannels.id })
      .from(dmChannels)
      .where(eq(dmChannels.federationGroupId, federationGroupId))
      .limit(1);
    expect(channel!.e2ee).toBe(true);

    const dmUpdates = events.filter(
      (e) => e.topic === ServerEvents.DM_CHANNEL_UPDATE
    );
    expect(dmUpdates.length).toBeGreaterThan(0);
    expect(
      dmUpdates.some(
        (e) =>
          (e.payload as { dmChannelId: number }).dmChannelId === channel!.id
      )
    ).toBe(true);
  });

  test('group: idempotent when current state already matches', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const localPublicId = await getUserPublicId(1);

    const federationGroupId = 'fed-group-idem-state';
    await postSignedAsPeer(
      '/federation/dm-group-create',
      {
        federationGroupId,
        name: 'Idem Group',
        ownerPublicId: 'remote-owner-pid',
        members: [
          { publicId: 'remote-owner-pid', instanceDomain: PEER_DOMAIN, name: 'Remote' },
          { publicId: localPublicId, instanceDomain: TEST_LOCAL_DOMAIN, name: 'Local' }
        ]
      },
      peerPrivateJwk
    );

    _resetSeenJtis();
    const first = await postSignedAsPeer(
      '/federation/dm-channel-state-update',
      { federationGroupId, e2ee: true },
      peerPrivateJwk
    );
    expect(first.status).toBe(200);
    expect(first.body?.applied).toBe(true);

    _resetSeenJtis();
    const second = await postSignedAsPeer(
      '/federation/dm-channel-state-update',
      { federationGroupId, e2ee: true },
      peerPrivateJwk
    );
    expect(second.status).toBe(200);
    expect(second.body?.applied).toBe(false);
  });

  test('1:1: updates e2ee flag on a (fromPublicId, toPublicId) mirror', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const localPublicId = await getUserPublicId(1);

    // Create a 1:1 DM mirror manually: the receiver instance
    // (us) has a shadow user for the peer's sender + a real local
    // user, joined into a non-group dm_channels row.
    const remoteSenderPublicId = 'remote-sender-pid-state';
    const [shadow] = await db
      .insert(users)
      .values({
        name: 'RemoteSender',
        supabaseId: 'remote-sender-shadow-state',
        publicId: 'shadow-' + remoteSenderPublicId,
        isFederated: true,
        federatedInstanceId: peerInstanceId,
        federatedPublicId: remoteSenderPublicId,
        createdAt: Date.now()
      })
      .returning();

    const [channel] = await db
      .insert(dmChannels)
      .values({ isGroup: false, e2ee: false, createdAt: Date.now() })
      .returning();

    await db.insert(dmChannelMembers).values([
      { dmChannelId: channel!.id, userId: 1, createdAt: Date.now() },
      { dmChannelId: channel!.id, userId: shadow!.id, createdAt: Date.now() }
    ]);

    const res = await postSignedAsPeer(
      '/federation/dm-channel-state-update',
      {
        fromPublicId: remoteSenderPublicId,
        toPublicId: localPublicId,
        e2ee: true
      },
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    expect(res.body?.applied).toBe(true);

    const [refreshed] = await db
      .select({ e2ee: dmChannels.e2ee })
      .from(dmChannels)
      .where(eq(dmChannels.id, channel!.id))
      .limit(1);
    expect(refreshed!.e2ee).toBe(true);
  });

  test('rejects unsigned requests', async () => {
    await initTest();
    await seedPeer();

    const res = await fetch(
      `${testsBaseUrl}/federation/dm-channel-state-update`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromDomain: PEER_DOMAIN,
          federationGroupId: 'whatever',
          e2ee: true
        })
      }
    );
    expect(res.status).toBe(400);
  });

  test('rejects when neither channel identifier nor a complete pair is supplied', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    const res = await postSignedAsPeer(
      '/federation/dm-channel-state-update',
      { e2ee: true }, // no channel identifier
      peerPrivateJwk
    );
    expect(res.status).toBe(400);
  });

  test('rejects when both channel identifier paths are supplied', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    const res = await postSignedAsPeer(
      '/federation/dm-channel-state-update',
      {
        federationGroupId: 'a',
        fromPublicId: 'b',
        toPublicId: 'c',
        e2ee: true
      },
      peerPrivateJwk
    );
    expect(res.status).toBe(400);
  });

  test('rejects when no changes are specified', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    const res = await postSignedAsPeer(
      '/federation/dm-channel-state-update',
      { federationGroupId: 'fed-no-change' }, // no e2ee field
      peerPrivateJwk
    );
    expect(res.status).toBe(400);
  });

  test('200 ignored when the federationGroupId mirror does not exist', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    const res = await postSignedAsPeer(
      '/federation/dm-channel-state-update',
      { federationGroupId: 'never-mirrored', e2ee: true },
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    expect(res.body?.ignored).toBe('no_mirror_channel');
  });

  test('200 ignored when 1:1 toPublicId is unknown locally', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    const res = await postSignedAsPeer(
      '/federation/dm-channel-state-update',
      {
        fromPublicId: 'remote-x',
        toPublicId: 'never-existed-local-pid',
        e2ee: true
      },
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    expect(res.body?.ignored).toBe('unknown_recipient');
  });
});
