import { describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'path';
import { Permission, ServerEvents } from '@pulse/shared';
import { createTestRole, grantTestUserRole, insertMemberUser } from '../../__tests__/fixtures';
import { initTest, waitUntil } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { messages, servers } from '../../db/schema';
import { PLUGINS_PATH } from '../../helpers/paths';
import { pluginManager } from '../../plugins';
import { pubsub } from '../../utils/pubsub';

/**
 * A slash command typed into the composer that names a registered
 * command but cannot run here is refused with the reason, never posted
 * as plain text (which reads as the command silently failing). Unknown
 * slash text stays an ordinary message.
 */

const PLUGIN_ID = 'watch-together';
const PACKAGE_DIR = path.resolve(process.cwd(), '..', '..', 'packages', 'plugins', PLUGIN_ID);
const COMMAND = '/watch https://cdn.example.com/clips/intro.mp4';

const installRealPlugin = async () => {
  const dir = path.join(PLUGINS_PATH, PLUGIN_ID);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  const built = await Bun.build({
    entrypoints: [path.join(PACKAGE_DIR, 'src', 'index.ts')],
    outdir: path.join(dir, 'dist'),
    target: 'bun',
    format: 'esm'
  });
  expect(built.success).toBe(true);
  await fs.copyFile(path.join(PACKAGE_DIR, 'package.json'), path.join(dir, 'package.json'));
  return async () => {
    await pluginManager.togglePlugin(PLUGIN_ID, false);
    await fs.rm(dir, { recursive: true, force: true });
  };
};

const messageCount = async () =>
  (await getTestDb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, 1))).length;

describe('slash commands in the composer', () => {
  test("the command line's state update never overtakes the row it belongs to", async () => {
    // `/watch pause` with nothing playing is refused by the plugin at
    // once, so its failed state used to be published before the pending
    // row had reached the viewers — who drop an update for a message they
    // do not have and keep showing "Running".
    const cleanup = await installRealPlugin();
    const spy = spyOn(pubsub, 'publishFor');
    try {
      await pluginManager.togglePlugin(PLUGIN_ID, true);
      await getTestDb().update(servers).set({ enablePlugins: true }).where(eq(servers.id, 1));
      const { caller: owner } = await initTest(1);
      await owner.messages.send({ channelId: 1, content: '/watch pause' });

      const isCommandRow = (payload: unknown) =>
        typeof (payload as { content?: unknown })?.content === 'string' &&
        (payload as { content: string }).content.includes('data-subcommand="pause"');
      const indexOf = (event: ServerEvents, status: string) =>
        spy.mock.calls.findIndex(
          ([, name, payload]) =>
            name === event &&
            isCommandRow(payload) &&
            (payload as { content: string }).content.includes(`data-status='${status}'`)
        );

      await waitUntil(async () => indexOf(ServerEvents.MESSAGE_UPDATE, 'failed') !== -1);
      const created = indexOf(ServerEvents.NEW_MESSAGE, 'pending');
      const failed = indexOf(ServerEvents.MESSAGE_UPDATE, 'failed');
      expect(created).not.toBe(-1);
      expect(created).toBeLessThan(failed);
    } finally {
      spy.mockRestore();
      await cleanup();
    }
  });

  test('a known command is refused with the reason when the community has plugins off or the member lacks the permission; unknown slash text posts', async () => {
    const cleanup = await installRealPlugin();
    try {
      await pluginManager.togglePlugin(PLUGIN_ID, true);
      expect(pluginManager.hasCommand(PLUGIN_ID, 'watch')).toBe(true);
      const tdb = getTestDb();

      // The owner holds the permission; the community has plugins off.
      await tdb.update(servers).set({ enablePlugins: false }).where(eq(servers.id, 1));
      const { caller: owner } = await initTest(1);
      const before = await messageCount();
      await expect(owner.messages.send({ channelId: 1, content: COMMAND })).rejects.toThrow(
        'turned off in this community'
      );
      expect(await messageCount()).toBe(before);

      // Text that merely starts with a slash is a message like any other.
      await owner.messages.send({ channelId: 1, content: '/shrug' });
      expect(await messageCount()).toBe(before + 1);

      // Plugins on; a plain member without EXECUTE_PLUGIN_COMMANDS.
      await tdb.update(servers).set({ enablePlugins: true }).where(eq(servers.id, 1));
      const member = await insertMemberUser();
      // May post, may not run commands.
      const posters = await createTestRole({
        serverId: 1,
        name: 'Posters',
        permissions: [Permission.SEND_MESSAGES]
      });
      await grantTestUserRole(member.id, posters);
      const { caller: memberCaller } = await initTest(member.id);
      await expect(memberCaller.messages.send({ channelId: 1, content: COMMAND })).rejects.toThrow(
        'permission to run plugin commands'
      );
      expect(await messageCount()).toBe(before + 1);
    } finally {
      await cleanup();
    }
  });
});
