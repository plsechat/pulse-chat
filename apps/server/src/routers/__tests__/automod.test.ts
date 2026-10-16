import { AutomodRuleType, ChannelType } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  createEmptyTextChannel,
  createTestChannel,
  createTestRole,
  insertOtherServer
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { automodRules, channels, messages } from '../../db/schema';

const keywordRule = (name: string, keyword: string) => ({
  name,
  type: AutomodRuleType.KEYWORD_FILTER,
  config: { keywords: [keyword] },
  actions: [{ type: 'log' as const }]
});

describe('automod router', () => {
  describe('authorization', () => {
    test('every CRUD route needs MANAGE_AUTOMOD', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);

      const rule = await owner.automod.createRule(keywordRule('r', 'x'));

      await expect(
        member.automod.createRule(keywordRule('nope', 'x'))
      ).rejects.toThrow('Insufficient permissions');
      await expect(member.automod.listRules()).rejects.toThrow(
        'Insufficient permissions'
      );
      await expect(
        member.automod.updateRule({ ruleId: rule!.id, name: 'renamed' })
      ).rejects.toThrow('Insufficient permissions');
      await expect(
        member.automod.toggleRule({ ruleId: rule!.id, enabled: false })
      ).rejects.toThrow('Insufficient permissions');
      await expect(
        member.automod.deleteRule({ ruleId: rule!.id })
      ).rejects.toThrow('Insufficient permissions');
    });

    test('update/toggle/delete never touch a rule of another server', async () => {
      const tdb = getTestDb();
      const { caller } = await initTest(1);
      const other = await insertOtherServer();

      const [foreign] = await tdb
        .insert(automodRules)
        .values({
          serverId: other.id,
          name: 'foreign',
          type: AutomodRuleType.KEYWORD_FILTER,
          config: { keywords: ['x'] },
          actions: [],
          createdBy: 1,
          createdAt: Date.now()
        })
        .returning();

      expect(
        await caller.automod.updateRule({ ruleId: foreign!.id, name: 'hijack' })
      ).toBeUndefined();
      expect(
        await caller.automod.toggleRule({ ruleId: foreign!.id, enabled: false })
      ).toBeUndefined();
      await caller.automod.deleteRule({ ruleId: foreign!.id });

      const [still] = await tdb
        .select()
        .from(automodRules)
        .where(eq(automodRules.id, foreign!.id));
      expect(still!.name).toBe('foreign');
      expect(still!.enabled).toBe(true);

      const listed = await caller.automod.listRules();
      expect(listed.find((r) => r.id === foreign!.id)).toBeUndefined();
    });
  });

  describe('input bounds', () => {
    test('rejects a catastrophic regex pattern', async () => {
      const { caller } = await initTest(1);

      await expect(
        caller.automod.createRule({
          name: 'redos',
          type: AutomodRuleType.KEYWORD_FILTER,
          config: { regexPatterns: ['(a+)+$'] },
          actions: []
        })
      ).rejects.toThrow();
    });

    test('rejects oversized action and exemption lists and bad ids', async () => {
      const { caller } = await initTest(1);

      await expect(
        caller.automod.createRule({
          ...keywordRule('too-many-actions', 'x'),
          actions: Array.from({ length: 51 }, () => ({ type: 'log' as const }))
        })
      ).rejects.toThrow();

      await expect(
        caller.automod.createRule({
          ...keywordRule('too-many-exempt', 'x'),
          exemptChannelIds: Array.from({ length: 51 }, (_, i) => i + 1)
        })
      ).rejects.toThrow();

      await expect(
        caller.automod.createRule({
          ...keywordRule('bad-duration', 'x'),
          actions: [{ type: 'timeout_user', duration: -1 }]
        })
      ).rejects.toThrow();

      await expect(
        caller.automod.updateRule({ ruleId: 0, name: 'x' })
      ).rejects.toThrow();
    });
  });

  describe('cross-server references', () => {
    test('alert channel in another server is not found', async () => {
      const { caller } = await initTest(1);
      const other = await insertOtherServer();
      const foreignChannel = await createTestChannel({ serverId: other.id });

      await expect(
        caller.automod.createRule({
          ...keywordRule('alert-foreign', 'x'),
          actions: [{ type: 'alert_channel', channelId: foreignChannel }]
        })
      ).rejects.toThrow('Alert channel not found');

      const rule = await caller.automod.createRule(keywordRule('ok', 'x'));
      await expect(
        caller.automod.updateRule({
          ruleId: rule!.id,
          actions: [{ type: 'alert_channel', channelId: foreignChannel }]
        })
      ).rejects.toThrow('Alert channel not found');
    });

    test('alert channel must be a text channel', async () => {
      const { caller } = await initTest(1);
      const voice = await createTestChannel({
        serverId: 1,
        type: ChannelType.VOICE
      });

      await expect(
        caller.automod.createRule({
          ...keywordRule('alert-voice', 'x'),
          actions: [{ type: 'alert_channel', channelId: voice }]
        })
      ).rejects.toThrow('Alert channel must be a text channel');
    });

    test('exempt role / channel of another server is not found', async () => {
      const { caller } = await initTest(1);
      const other = await insertOtherServer();
      const foreignChannel = await createTestChannel({ serverId: other.id });
      const foreignRole = await createTestRole({ serverId: other.id });

      await expect(
        caller.automod.createRule({
          ...keywordRule('exempt-channel', 'x'),
          exemptChannelIds: [foreignChannel]
        })
      ).rejects.toThrow('Exempt channel not found');

      await expect(
        caller.automod.createRule({
          ...keywordRule('exempt-role', 'x'),
          exemptRoleIds: [foreignRole]
        })
      ).rejects.toThrow('Exempt role not found');

      // Own-server references are accepted.
      const ownRole = await createTestRole({ serverId: 1 });
      const own = await caller.automod.createRule({
        ...keywordRule('exempt-own', 'x'),
        exemptRoleIds: [ownRole],
        exemptChannelIds: [1]
      });
      expect(own!.exemptRoleIds).toEqual([ownRole]);
    });
  });

  describe('enforcement', () => {
    test('a keyword rule blocks a send and posts the alert as the rule creator', async () => {
      const tdb = getTestDb();
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const alertChannel = await createEmptyTextChannel('automod-alerts');

      await owner.automod.createRule({
        ...keywordRule('no-pineapple', 'pineapple'),
        actions: [{ type: 'alert_channel', channelId: alertChannel.id }]
      });

      await expect(
        member.messages.send({ channelId: 1, content: 'pineapple pizza' })
      ).rejects.toThrow('Message blocked by auto-moderation');

      const blocked = await tdb
        .select()
        .from(messages)
        .where(eq(messages.content, 'pineapple pizza'));
      expect(blocked).toHaveLength(0);

      const alerts = await tdb
        .select()
        .from(messages)
        .where(eq(messages.channelId, alertChannel.id));
      expect(alerts).toHaveLength(1);
      // Authored by the rule's creator (user 1), never the offender.
      expect(alerts[0]!.userId).toBe(1);
      expect(alerts[0]!.editable).toBe(false);
      expect(alerts[0]!.content).toContain('no-pineapple');
      expect(alerts[0]!.content).toContain('<@2>');
    });

    test('a disabled rule does not block', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);

      const rule = await owner.automod.createRule(
        keywordRule('off', 'pineapple')
      );
      await owner.automod.toggleRule({ ruleId: rule!.id, enabled: false });

      await member.messages.send({ channelId: 1, content: 'pineapple ok' });
    });

    test('an alert channel that left the server at execute time is skipped', async () => {
      const tdb = getTestDb();
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const alertChannel = await createEmptyTextChannel('automod-moved');

      await owner.automod.createRule({
        ...keywordRule('moved', 'pineapple'),
        actions: [{ type: 'alert_channel', channelId: alertChannel.id }]
      });

      // Simulate the stored id no longer pointing inside the server.
      const other = await insertOtherServer();
      await tdb
        .update(channels)
        .set({ serverId: other.id })
        .where(eq(channels.id, alertChannel.id));

      await expect(
        member.messages.send({ channelId: 1, content: 'pineapple again' })
      ).rejects.toThrow('Message blocked by auto-moderation');

      const alerts = await tdb
        .select()
        .from(messages)
        .where(eq(messages.channelId, alertChannel.id));
      expect(alerts).toHaveLength(0);
    });

    test('editing cannot introduce blocked content', async () => {
      const tdb = getTestDb();
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const alertChannel = await createEmptyTextChannel('automod-edit');

      const messageId = await member.messages.send({
        channelId: 1,
        content: 'innocent'
      });

      await owner.automod.createRule({
        ...keywordRule('edit-rule', 'pineapple'),
        actions: [{ type: 'alert_channel', channelId: alertChannel.id }]
      });

      await expect(
        member.messages.edit({ messageId, content: 'now pineapple' })
      ).rejects.toThrow('Message blocked by auto-moderation');

      const [row] = await tdb
        .select()
        .from(messages)
        .where(eq(messages.id, messageId));
      expect(row!.content).toBe('innocent');

      const alerts = await tdb
        .select()
        .from(messages)
        .where(eq(messages.channelId, alertChannel.id));
      expect(alerts).toHaveLength(1);
    });
  });
});
