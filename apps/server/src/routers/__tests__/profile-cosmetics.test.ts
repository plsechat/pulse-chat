/**
 * Profile cosmetics — avatar decorations (users.avatarDecoration) and
 * styled display names (users.nameStyle).
 *
 * Setup is done inline in each test (no beforeEach) to avoid piling row
 * inserts onto the global setup.ts TRUNCATE in a way that competes with
 * parallel test files for table-level locks.
 */

import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { config } from '../../config';
import { db } from '../../db';
import { federationInstances, users } from '../../db/schema';
import { initTest } from '../../__tests__/helpers';
import { testsBaseUrl } from '../../__tests__/setup';
import {
  _resetSeenJtis,
  _signChallengeAs,
  generateFederationKeys
} from '../../utils/federation';

// The mock-modules default has federation disabled; the user-info-update
// handler short-circuits before its logic in that state. The receiver
// tests below need the real handler path, so flip the flag at module
// load (isolated to this Bun process by the per-file test matrix).
config.federation.enabled = true;

const PEER_DOMAIN = 'peer.example';
const TEST_LOCAL_DOMAIN = 'test.local'; // matches setup.ts mock

/** Seed an active peer instance whose signatures we can forge. */
async function seedPeer(): Promise<{
  peerInstanceId: number;
  peerPrivateJwk: JWK;
}> {
  _resetSeenJtis();
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

  // signedJsonResponse signs responses with the local instance's key;
  // the global beforeEach TRUNCATE wipes it, so re-generate per test.
  await generateFederationKeys();

  return { peerInstanceId: instance!.id, peerPrivateJwk };
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

  const res = await fetch(`${testsBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...bodyToSign, signature })
  });
  let body: Record<string, unknown> | null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** Insert a shadow user for the peer, optionally with cosmetics pre-set. */
async function insertShadowUser(
  peerInstanceId: number,
  federatedPublicId: string
) {
  const [shadow] = await db
    .insert(users)
    .values({
      name: 'ShadowUser',
      supabaseId: `shadow-${federatedPublicId}`,
      publicId: `shadow-pid-${federatedPublicId}`,
      avatarDecoration: 'preset:halo',
      nameStyle: { effect: 'solid', color: '#ff5500' },
      isFederated: true,
      federatedInstanceId: peerInstanceId,
      federatedPublicId,
      createdAt: Date.now()
    })
    .returning();
  return shadow!;
}

describe('profile cosmetics', () => {
  test('preset decoration equips, appears in the public payload, and null clears it', async () => {
    const { caller } = await initTest(1);

    await caller.users.setAvatarDecoration({ decoration: 'preset:halo' });

    const members = await caller.others.getServerMembers();
    const me = members.find((m) => m.id === 1);

    expect(me).toBeDefined();
    expect(me!.avatarDecoration).toBe('preset:halo');

    await caller.users.setAvatarDecoration({ decoration: null });

    const cleared = await caller.others.getServerMembers();
    expect(cleared.find((m) => m.id === 1)!.avatarDecoration).toBeNull();
  });

  test('unknown decoration slugs and malformed values are refused', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.users.setAvatarDecoration({ decoration: 'preset:not-a-slug' })
    ).rejects.toThrow('Unknown avatar decoration');

    await expect(
      caller.users.setAvatarDecoration({ decoration: 'halo' })
    ).rejects.toThrow('Unknown avatar decoration');
  });

  test('name style equips, appears in the public payload, and null clears it', async () => {
    const { caller } = await initTest(1);

    const style = {
      font: 'pacifico' as const,
      effect: 'gradient' as const,
      color: '#ff0055',
      color2: '#00ffaa'
    };
    await caller.users.setNameStyle({ style });

    const members = await caller.others.getServerMembers();
    expect(members.find((m) => m.id === 1)!.nameStyle).toEqual(style);

    await caller.users.setNameStyle({ style: null });

    const cleared = await caller.others.getServerMembers();
    expect(cleared.find((m) => m.id === 1)!.nameStyle).toBeNull();
  });

  test('name styles with a bad font, effect, or color are refused', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.users.setNameStyle({
        // @ts-expect-error — invalid font on purpose
        style: { font: 'comic-sans', effect: 'solid', color: '#ff0055' }
      })
    ).rejects.toThrow();

    await expect(
      caller.users.setNameStyle({
        // @ts-expect-error — invalid effect on purpose
        style: { effect: 'blink', color: '#ff0055' }
      })
    ).rejects.toThrow();

    await expect(
      caller.users.setNameStyle({
        style: { effect: 'solid', color: 'red' }
      })
    ).rejects.toThrow();

    await expect(
      caller.users.setNameStyle({
        // @ts-expect-error — unknown key on purpose (shape is strict)
        style: { effect: 'solid', color: '#ff0055', sneaky: 'x' }
      })
    ).rejects.toThrow();

    // Nothing was persisted by the refused calls
    const [row] = await db
      .select({ nameStyle: users.nameStyle })
      .from(users)
      .where(eq(users.id, 1))
      .limit(1);
    expect(row!.nameStyle).toBeNull();
  });

  test('federation receiver applies valid cosmetics from a peer', async () => {
    await initTest(1);
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();

    const subject = 'remote-cosmetics-valid';
    const shadow = await insertShadowUser(peerInstanceId, subject);

    const res = await postSignedAsPeer(
      '/federation/user-info-update',
      {
        subjectPublicId: subject,
        avatarDecoration: 'preset:flames',
        nameStyle: { font: 'oswald', effect: 'neon', color: '#00ff88' }
      },
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    expect(res.body?.applied).toBe(true);

    const [row] = await db
      .select({
        avatarDecoration: users.avatarDecoration,
        nameStyle: users.nameStyle
      })
      .from(users)
      .where(eq(users.id, shadow.id))
      .limit(1);
    expect(row!.avatarDecoration).toBe('preset:flames');
    expect(row!.nameStyle).toEqual({
      font: 'oswald',
      effect: 'neon',
      color: '#00ff88'
    });
  });

  test('federation receiver coerces invalid cosmetics to null', async () => {
    await initTest(1);
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();

    const subject = 'remote-cosmetics-invalid';
    const shadow = await insertShadowUser(peerInstanceId, subject);

    const res = await postSignedAsPeer(
      '/federation/user-info-update',
      {
        subjectPublicId: subject,
        avatarDecoration: 'preset:definitely-not-a-slug',
        nameStyle: { effect: 'blink', color: 'javascript:alert(1)' }
      },
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    expect(res.body?.applied).toBe(true);

    // Pre-set values (insertShadowUser) were coerced to cleared, not kept
    const [row] = await db
      .select({
        avatarDecoration: users.avatarDecoration,
        nameStyle: users.nameStyle
      })
      .from(users)
      .where(eq(users.id, shadow.id))
      .limit(1);
    expect(row!.avatarDecoration).toBeNull();
    expect(row!.nameStyle).toBeNull();
  });
});
