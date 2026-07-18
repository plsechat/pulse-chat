import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { config } from '../../config';
import { servers } from '../../db/schema';
import { getTestDb } from '../../__tests__/mock-db';
import { initTest } from '../../__tests__/helpers';

/**
 * Instance-level federation — enabling federation, peering with other
 * instances — is the instance owner's alone (the operator who owns the
 * first server). Previously these gated on MANAGE_SETTINGS of the first
 * server, which any admin, or any user who created their OWN server (its
 * owner, with every permission), satisfied. Seeded user 1 owns the first
 * server (the instance owner); user 2 is a plain member.
 */
describe('federation config is instance-owner-only', () => {
  test('the instance owner can read federation config (incl. the policy flag)', async () => {
    config.federation.allowUserFederatableServers = false;
    const { caller } = await initTest(1);
    const cfg = await caller.federation.getConfig();
    expect(cfg).toHaveProperty('enabled');
    expect(cfg.allowUserFederatableServers).toBe(false);
  });

  test('a non-instance-owner cannot READ federation config', async () => {
    const { caller } = await initTest(2);
    await expect(caller.federation.getConfig()).rejects.toThrow(
      'Only the instance owner'
    );
  });

  test('a non-instance-owner cannot CHANGE federation config', async () => {
    const { caller } = await initTest(2);
    await expect(
      caller.federation.setConfig({ enabled: true, domain: 'evil.example' })
    ).rejects.toThrow('Only the instance owner');
  });

  test('a non-instance-owner cannot add a peer instance', async () => {
    const { caller } = await initTest(2);
    await expect(
      caller.federation.addInstance({ remoteUrl: 'http://peer.example' })
    ).rejects.toThrow('Only the instance owner');
  });
});

describe('federatable toggle is server-owner + instance-policy gated', () => {
  test('the instance owner can federate their own server regardless of the slider', async () => {
    config.federation.allowUserFederatableServers = false;
    const { caller } = await initTest(1);

    await caller.others.updateSettings({ serverId: 1, federatable: true });

    const [row] = await getTestDb()
      .select()
      .from(servers)
      .where(eq(servers.id, 1));
    expect(row!.federatable).toBe(true);
  });

  test('a non-owner (no MANAGE_SETTINGS) cannot make a server federatable', async () => {
    // user 2 is a plain member of the first server.
    const { caller } = await initTest(2);
    await expect(
      caller.others.updateSettings({ serverId: 1, federatable: true })
    ).rejects.toThrow();
  });

  test('a server owner who is NOT the instance owner is blocked while the slider is off', async () => {
    config.federation.allowUserFederatableServers = false;
    const { caller } = await initTest(2);

    // user 2 owns this new server (all permissions) but not the instance.
    const server2 = await caller.servers.create({ name: 'User2 Server' });

    await expect(
      caller.others.updateSettings({ serverId: server2.id, federatable: true })
    ).rejects.toThrow('has not allowed');
  });

  test('a server owner CAN make their own server federatable once the slider is on', async () => {
    config.federation.allowUserFederatableServers = true;
    const { caller } = await initTest(2);

    const server2 = await caller.servers.create({ name: 'User2 Server B' });
    await caller.others.updateSettings({
      serverId: server2.id,
      federatable: true
    });

    const [row] = await getTestDb()
      .select()
      .from(servers)
      .where(eq(servers.id, server2.id));
    expect(row!.federatable).toBe(true);

    config.federation.allowUserFederatableServers = false;
  });
});
