import { Permission } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  createTestRole,
  grantTestUserRole,
  insertOtherServer
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { TRUNCATE_ALL_SQL } from '../../__tests__/truncate';
import { DEFAULT_ROSTER_TEMPLATES } from '../../db/queries/events';
import { eventRosterTemplates } from '../../db/schema';
import { seedDatabase } from '../../db/seed';

const roles = [
  { key: 'tank', label: 'Tank', cap: 2, color: '#60a5fa' },
  { key: 'dps', label: 'DPS', cap: null, color: null }
];

const templatesOf = (serverId: number) =>
  getTestDb()
    .select()
    .from(eventRosterTemplates)
    .where(eq(eventRosterTemplates.serverId, serverId))
    .orderBy(eventRosterTemplates.id);

describe('events.templates', () => {
  test('CRUD, bounded and unique per server', async () => {
    const { caller } = await initTest(1);

    const created = await caller.events.templates.create({ name: 'Ten man', roles });
    expect(created.serverId).toBe(1);
    expect(created.roles).toEqual(roles);

    await expect(
      caller.events.templates.create({ name: 'Ten man', roles })
    ).rejects.toThrow('already exists');
    await expect(
      caller.events.templates.create({ name: 'x'.repeat(61), roles })
    ).rejects.toThrow();
    await expect(
      caller.events.templates.create({ name: '', roles })
    ).rejects.toThrow();
    await expect(
      caller.events.templates.create({ name: 'Empty', roles: [] })
    ).rejects.toThrow();
    await expect(
      caller.events.templates.create({
        name: 'Dup',
        roles: [roles[0]!, { ...roles[0]! }]
      })
    ).rejects.toThrow('unique');

    const other = await caller.events.templates.create({ name: 'Twenty', roles });
    await expect(
      caller.events.templates.update({ templateId: other.id, name: 'Ten man' })
    ).rejects.toThrow('already exists');

    const updated = await caller.events.templates.update({
      templateId: other.id,
      name: 'Twenty-five',
      roles: [roles[0]!]
    });
    expect(updated.name).toBe('Twenty-five');
    expect(updated.roles).toEqual([roles[0]!]);

    const listed = await caller.events.templates.list();
    expect(listed.map((t) => t.name)).toEqual(['Ten man', 'Twenty-five']);

    await caller.events.templates.delete({ templateId: created.id });
    expect((await caller.events.templates.list()).map((t) => t.id)).toEqual([other.id]);
    await expect(
      caller.events.templates.delete({ templateId: created.id })
    ).rejects.toThrow('Template not found');
  });

  test('mutations need MANAGE_EVENTS; listing is for every member', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const { caller: manager } = await initTest(3);
    const roleId = await createTestRole({
      serverId: 1,
      name: 'Raid lead',
      permissions: [Permission.MANAGE_EVENTS]
    });
    await grantTestUserRole(3, roleId);

    const template = await owner.events.templates.create({ name: 'Ten man', roles });

    await expect(member.events.templates.create({ name: 'No', roles })).rejects.toThrow(
      'Insufficient permissions'
    );
    await expect(
      member.events.templates.update({ templateId: template.id, name: 'No' })
    ).rejects.toThrow('Insufficient permissions');
    await expect(
      member.events.templates.delete({ templateId: template.id })
    ).rejects.toThrow('Insufficient permissions');
    expect((await member.events.templates.list()).map((t) => t.id)).toEqual([template.id]);

    const byManager = await manager.events.templates.create({ name: 'Lead', roles });
    expect(byManager.name).toBe('Lead');
  });

  test('another server\'s template is not found and never listed', async () => {
    const { caller } = await initTest(1);
    const other = await insertOtherServer();
    const [foreign] = await getTestDb()
      .insert(eventRosterTemplates)
      .values({ serverId: other.id, name: 'foreign', roles, createdAt: Date.now() })
      .returning();

    await expect(
      caller.events.templates.update({ templateId: foreign!.id, name: 'hijack' })
    ).rejects.toThrow('Template not found');
    await expect(
      caller.events.templates.delete({ templateId: foreign!.id })
    ).rejects.toThrow('Template not found');
    expect(await caller.events.templates.list()).toEqual([]);
    expect((await templatesOf(other.id))[0]!.name).toBe('foreign');
  });

  describe('default templates', () => {
    test('a created server starts with the three stock rosters', async () => {
      const { caller } = await initTest(1);
      const server = await caller.servers.create({ name: 'Guild' });

      const rows = await templatesOf(server.id);
      expect(rows.map((t) => ({ name: t.name, roles: t.roles }))).toEqual(
        DEFAULT_ROSTER_TEMPLATES
      );
      expect(rows.map((t) => t.name)).toEqual(['Classic raid', 'Small group', 'Flex']);
      expect(rows[0]!.roles).toEqual([
        { key: 'tank', label: 'Tank', cap: 2, color: '#60a5fa' },
        { key: 'healer', label: 'Healer', cap: 4, color: '#5ee29a' },
        { key: 'dps', label: 'DPS', cap: 14, color: '#ff5c6c' }
      ]);
      expect(rows[2]!.roles).toEqual([{ key: 'flex', label: 'Flex', cap: null, color: '#ffb454' }]);
    });

    test('the bootstrap seed inserts them for the first server', async () => {
      // The per-test seed is the lightweight test fixture; the real
      // first-boot seed only runs on an empty instance, so give it one.
      // The next test's reset re-seeds the fixture as usual.
      const tdb = getTestDb();
      await tdb.execute(TRUNCATE_ALL_SQL);

      await seedDatabase();

      const rows = await templatesOf(1);
      expect(rows.map((t) => t.name)).toEqual(['Classic raid', 'Small group', 'Flex']);
    });
  });
});
