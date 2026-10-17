import { ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { createTestChannel, insertOtherServer } from '../../__tests__/fixtures';
import { getTestDb } from '../../__tests__/mock-db';
import { externalIdentities, serverMembers, users } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';
import { getPublicUsersByIds } from '../../db/queries/users';
import { getPluginActorUserId, isPluginActorAuthId } from '../actor';

/**
 * The per-plugin actor account (plugins/actor.ts): minted on first use
 * under the placeholder mechanism, named after the manifest, a member
 * of each server the plugin acts in, never the instance owner — so the
 * owner is notified of a bridged post like any other member.
 */

const OWNER_ID = 1;

const tdb = () => getTestDb();

const identityOf = async (pluginId: string) => {
  const [row] = await tdb()
    .select()
    .from(externalIdentities)
    .where(
      and(eq(externalIdentities.provider, `plugin:${pluginId}`), eq(externalIdentities.externalId, pluginId))
    );
  return row;
};

const memberRows = async (serverId: number, userId: number) =>
  tdb()
    .select()
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));

afterEach(() => {
  mock.restore();
});

describe('plugin actor account', () => {
  test('first use mints one account per plugin, named after the manifest, that can never sign in', async () => {
    const actorId = await getPluginActorUserId({ pluginId: 'status-bot', name: 'Status Bot' });
    expect(actorId).not.toBe(OWNER_ID);

    const [user] = await tdb().select().from(users).where(eq(users.id, actorId));
    expect(user).toMatchObject({ name: 'Status Bot', isFederated: false, banned: false });
    expect(user!.supabaseId).toBe('plugin:status-bot');
    expect(isPluginActorAuthId(user!.supabaseId)).toBe(true);
    expect(/^[0-9a-f-]{36}$/.test(user!.supabaseId)).toBe(false);

    const identity = await identityOf('status-bot');
    expect(identity).toMatchObject({ userId: actorId, placeholder: false, displayName: 'Status Bot' });

    // The same plugin resolves to the same account; another plugin gets its own.
    expect(await getPluginActorUserId({ pluginId: 'status-bot', name: 'Status Bot' })).toBe(actorId);
    const other = await getPluginActorUserId({ pluginId: 'other-bot', name: 'Other' });
    expect(other).not.toBe(actorId);
    expect(await tdb().select().from(users).where(eq(users.supabaseId, 'plugin:status-bot'))).toHaveLength(1);
  });

  test('a renamed manifest renames the account; a call without a name leaves it alone', async () => {
    const actorId = await getPluginActorUserId({ pluginId: 'renamed', name: 'First Name' });
    await getPluginActorUserId({ pluginId: 'renamed' });
    expect((await tdb().select().from(users).where(eq(users.id, actorId)))[0]!.name).toBe('First Name');

    await getPluginActorUserId({ pluginId: 'renamed', name: 'Second Name' });
    expect((await tdb().select().from(users).where(eq(users.id, actorId)))[0]!.name).toBe('Second Name');
  });

  test('acting in a server joins it once and tells the roster; other servers are untouched', async () => {
    const otherServer = await insertOtherServer();
    await createTestChannel({ serverId: otherServer.id, name: 'elsewhere' });
    const spy = spyOn(pubsub, 'publishFor');

    const actorId = await getPluginActorUserId({ pluginId: 'joiner', name: 'Joiner', serverId: 1 });
    expect(await memberRows(1, actorId)).toHaveLength(1);
    expect(await memberRows(otherServer.id, actorId)).toHaveLength(0);

    // The roster learns about the new member, scoped to that server.
    for (let i = 0; i < 100 && !spy.mock.calls.some(([, event]) => event === ServerEvents.USER_CREATE); i++) {
      await Bun.sleep(5);
    }
    const creates = spy.mock.calls.filter(([, event]) => event === ServerEvents.USER_CREATE);
    expect(creates).toHaveLength(1);
    expect(creates[0]![2]).toMatchObject({ id: actorId });

    // A second action in the same server is a no-op on membership.
    await getPluginActorUserId({ pluginId: 'joiner', name: 'Joiner', serverId: 1 });
    expect(await memberRows(1, actorId)).toHaveLength(1);
    expect(spy.mock.calls.filter(([, event]) => event === ServerEvents.USER_CREATE)).toHaveLength(1);

    await getPluginActorUserId({ pluginId: 'joiner', name: 'Joiner', serverId: otherServer.id });
    expect(await memberRows(otherServer.id, actorId)).toHaveLength(1);
  });

  test('the public projection labels the actor as a system account; people carry no flag', async () => {
    const actorId = await getPluginActorUserId({ pluginId: 'labelled-bot', name: 'Labelled Bot' });
    const projected = await getPublicUsersByIds([actorId, OWNER_ID]);
    expect(projected.get(actorId)).toMatchObject({ name: 'Labelled Bot', system: true });
    expect(projected.get(OWNER_ID)).toBeDefined();
    expect('system' in projected.get(OWNER_ID)!).toBe(false);
  });

  test('a name is bounded to the users.name cap and never empty', async () => {
    const long = 'x'.repeat(100);
    const actorId = await getPluginActorUserId({ pluginId: 'long-name', name: long });
    expect((await tdb().select().from(users).where(eq(users.id, actorId)))[0]!.name).toBe('x'.repeat(32));

    const blank = await getPluginActorUserId({ pluginId: 'blank-name', name: '   ' });
    expect((await tdb().select().from(users).where(eq(users.id, blank)))[0]!.name).toBe('blank-name');
  });
});
