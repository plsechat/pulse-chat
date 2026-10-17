import type { PluginContext, TPluginCapability } from '@pulse/plugin-sdk';
import { isPluginActionError } from '@pulse/plugin-sdk';
import {
  AutomodRuleType,
  ChannelPermission,
  ChannelType,
  MAX_MESSAGE_CONTENT_LENGTH,
  ServerEvents
} from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import dns from 'dns/promises';
import { and, eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'path';
import {
  createTestCategory,
  createTestChannel,
  createTestUser,
  insertOtherServer
} from '../../__tests__/fixtures';
import { getTestDb } from '../../__tests__/mock-db';
import {
  automodRules,
  channelUserPermissions,
  channels,
  files,
  messageFiles,
  messageReactions,
  messages,
  pluginMessageLinks,
  servers,
  users
} from '../../db/schema';
import { PLUGINS_PATH, PUBLIC_PATH } from '../../helpers/paths';
import { VoiceRuntime } from '../../runtimes/voice';
import { _resetCacheForTests } from '../../utils/federation-allowlist';
import { _resetFederationRateLimit } from '../../utils/federation-fetch';
import { pubsub } from '../../utils/pubsub';
import { createEventActions, type TEventQueries } from '../actions/events';
import { eventBus } from '../event-bus';
import { pluginManager } from '..';

/**
 * `ctx.actions.*` and `ctx.fetch` as a plugin sees them: every suite
 * loads a throwaway plugin through the real loader (so createContext,
 * capabilities and the event bus are the production ones) and drives
 * the context it stashed. Fan-out is asserted on `pubsub.publishFor`
 * the way notes.test.ts does; outbound traffic is stubbed per test and
 * restored in afterEach (the preload fails the run on a leak).
 */

declare global {
  // eslint-disable-next-line no-var
  var __pluginActionCtx: Record<string, PluginContext> | undefined;
}

const TEXT_CHANNEL_ID = 1;
const VOICE_CHANNEL_ID = 2;
const SEEDED_MESSAGE_ID = 1;
const OWNER_ID = 1;
const MEMBER_ROLE_ID = 2;

const STASH_SOURCE = `
  export const onLoad = (ctx) => {
    globalThis.__pluginActionCtx ??= {};
    globalThis.__pluginActionCtx[ctx.path.split('/').pop()] = ctx;
  };
`;

const loadPlugin = async (
  id: string,
  options: { capabilities?: TPluginCapability[] } = {}
): Promise<{ ctx: PluginContext; cleanup: () => Promise<void> }> => {
  const dir = path.join(PLUGINS_PATH, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      pulse: {
        entry: 'index.js',
        author: 'test',
        description: 'actions test plugin',
        sdk: '^0.2',
        ...(options.capabilities ? { capabilities: options.capabilities } : {})
      }
    })
  );
  await fs.writeFile(path.join(dir, 'index.js'), STASH_SOURCE);

  const cleanup = async () => {
    await pluginManager.unload(id);
    await fs.rm(dir, { recursive: true, force: true });
    delete globalThis.__pluginActionCtx?.[id];
  };

  await pluginManager.togglePlugin(id, true);
  const ctx = globalThis.__pluginActionCtx?.[id];

  if (!pluginManager.isPluginLoaded(id) || !ctx) {
    const info = await pluginManager.getPluginInfo(id);
    await cleanup();
    throw new Error(`fixture did not load: ${info.loadError}`);
  }

  return { ctx, cleanup };
};

/** Rejection code + message of an action, or a failing expectation. */
const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (isPluginActionError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected the action to reject');
};

type PublishCall = [number | number[], string, unknown];

const published = (spy: { mock: { calls: unknown[][] } }, topic: ServerEvents) =>
  (spy.mock.calls as PublishCall[])
    .filter(([, t]) => t === topic)
    .map(([recipients, , payload]) => ({
      recipients: Array.isArray(recipients) ? recipients : [recipients],
      payload
    }));

/** Collects every bus emit of `events` while `run` executes. */
const collect = async (
  events: Parameters<typeof eventBus.on>[0][],
  run: () => Promise<unknown>
) => {
  const received: { event: string; payload: unknown }[] = [];
  const handlers = events.map((event) => {
    const handler = (payload: unknown) => {
      received.push({ event, payload });
    };
    eventBus.on(event, handler);
    return { event, handler };
  });
  try {
    await run();
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    for (const { event, handler } of handlers) eventBus.off(event, handler);
  }
  return received;
};

const messageById = async (id: number) => {
  const [row] = await getTestDb()
    .select()
    .from(messages)
    .where(eq(messages.id, id))
    .limit(1);
  return row;
};

const linksOf = (pluginId: string) =>
  getTestDb()
    .select()
    .from(pluginMessageLinks)
    .where(eq(pluginMessageLinks.pluginId, pluginId));

/** PNG header + a little payload: enough for the magic sniff and a real mime. */
const pngBytes = () =>
  new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ...Array.from({ length: 32 }, (_, i) => i)
  ]);

const stubOutbound = (
  respond: (url: string, init?: BunFetchRequestInit) => Response
) => {
  spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
  spyOn(dns, 'resolve6').mockRejectedValue(new Error('ENODATA'));
  const calls: { url: string; init: BunFetchRequestInit | undefined }[] = [];
  spyOn(globalThis, 'fetch').mockImplementation((async (
    url: string | URL | Request,
    init?: BunFetchRequestInit
  ) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  }) as unknown as typeof fetch);
  return calls;
};

afterEach(() => {
  mock.restore();
  _resetFederationRateLimit();
  _resetCacheForTests();
});

describe('actions.messages.post', () => {
  test('posts under the instance owner with the persona in metadata, links the externalId, fans out and emits', async () => {
    const id = 'act-post-basic';
    const { ctx, cleanup } = await loadPlugin(id);

    try {
      const spy = spyOn(pubsub, 'publishFor');
      let messageId = 0;
      const events = await collect(['message:created'], async () => {
        ({ messageId } = await ctx.actions.messages.post({
          channelId: TEXT_CHANNEL_ID,
          content: 'hello from the bridge',
          author: { name: 'Bridge Bot', avatarUrl: '/public/bot.png' },
          externalId: 'upstream-1'
        }));
      });

      const row = await messageById(messageId);
      expect(row).toMatchObject({
        userId: OWNER_ID,
        channelId: TEXT_CHANNEL_ID,
        content: 'hello from the bridge',
        e2ee: false,
        webhookId: null
      });
      expect(row?.metadata).toEqual([
        {
          url: '',
          title: 'Bridge Bot',
          siteName: 'plugin',
          description: id,
          mediaType: 'webhook',
          images: ['/public/bot.png']
        }
      ]);

      const links = await linksOf(id);
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ externalId: 'upstream-1', messageId, channelId: TEXT_CHANNEL_ID });

      const fanout = published(spy, ServerEvents.NEW_MESSAGE);
      expect(fanout).toHaveLength(1);
      expect((fanout[0]!.payload as { id: number }).id).toBe(messageId);
      expect(fanout[0]!.recipients).toEqual(expect.arrayContaining([1, 2, 3]));

      expect(events).toEqual([
        {
          event: 'message:created',
          payload: {
            messageId,
            channelId: TEXT_CHANNEL_ID,
            userId: OWNER_ID,
            content: 'hello from the bridge',
            pluginId: id
          }
        }
      ]);
    } finally {
      await cleanup();
    }
  });

  test('the same externalId posted twice returns the first message instead of a duplicate; no externalId mints a reserved one', async () => {
    const id = 'act-post-dedupe';
    const { ctx, cleanup } = await loadPlugin(id);

    try {
      const first = await ctx.actions.messages.post({
        channelId: TEXT_CHANNEL_ID,
        content: 'once',
        externalId: 'dup'
      });
      const second = await ctx.actions.messages.post({
        channelId: TEXT_CHANNEL_ID,
        content: 'twice — must not land',
        externalId: 'dup'
      });
      expect(second.messageId).toBe(first.messageId);

      const anonymous = await ctx.actions.messages.post({
        channelId: TEXT_CHANNEL_ID,
        content: 'no external id'
      });

      const links = await linksOf(id);
      expect(links).toHaveLength(2);
      expect(links.find((l) => l.messageId === anonymous.messageId)?.externalId).toMatch(
        /^__auto:/
      );

      const rows = await getTestDb()
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.channelId, TEXT_CHANNEL_ID));
      // The seeded message plus the two distinct plugin posts.
      expect(rows).toHaveLength(3);
    } finally {
      await cleanup();
    }
  });

  test('refuses encrypted, voice and forum channels and an unknown one, with typed errors', async () => {
    const { ctx, cleanup } = await loadPlugin('act-post-refusals');

    try {
      const e2eeChannelId = await createTestChannel({ serverId: 1, categoryId: 1, e2ee: true });
      const forumChannelId = await createTestChannel({
        serverId: 1,
        categoryId: 1,
        type: ChannelType.FORUM
      });

      const encrypted = await rejection(
        ctx.actions.messages.post({ channelId: e2eeChannelId, content: 'plaintext' })
      );
      expect(encrypted.code).toBe('BAD_REQUEST');
      expect(encrypted.message).toContain('encrypted');

      const voice = await rejection(
        ctx.actions.messages.post({ channelId: VOICE_CHANNEL_ID, content: 'x' })
      );
      expect(voice).toEqual({
        code: 'BAD_REQUEST',
        message: 'Voice channels do not support text messages'
      });

      const forum = await rejection(
        ctx.actions.messages.post({ channelId: forumChannelId, content: 'x' })
      );
      expect(forum.code).toBe('BAD_REQUEST');
      expect(forum.message).toContain('createThread');

      expect(
        await rejection(ctx.actions.messages.post({ channelId: 999_999, content: 'x' }))
      ).toEqual({ code: 'NOT_FOUND', message: 'Channel not found' });

      const rows = await getTestDb()
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.channelId, e2eeChannelId));
      expect(rows).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test('bounds: content cap, author name, avatar url, externalId length and reserved prefix, attachments count, ids', async () => {
    const { ctx, cleanup } = await loadPlugin('act-post-bounds');

    try {
      const cases: [unknown, string][] = [
        [{ channelId: TEXT_CHANNEL_ID, content: 'x'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 1) }, 'content'],
        [{ channelId: TEXT_CHANNEL_ID, content: '   ' }, 'content or at least one attachment'],
        [{ channelId: TEXT_CHANNEL_ID, content: 'x', author: { name: '  ' } }, 'author.name'],
        [{ channelId: TEXT_CHANNEL_ID, content: 'x', author: { name: 'a'.repeat(81) } }, 'author.name'],
        [
          { channelId: TEXT_CHANNEL_ID, content: 'x', author: { name: 'a', avatarUrl: 'ftp://x/y.png' } },
          'author.avatarUrl'
        ],
        [{ channelId: TEXT_CHANNEL_ID, content: 'x', externalId: 'e'.repeat(257) }, 'externalId'],
        [{ channelId: TEXT_CHANNEL_ID, content: 'x', externalId: '__mine' }, 'externalId'],
        [
          {
            channelId: TEXT_CHANNEL_ID,
            content: 'x',
            attachments: Array.from({ length: 11 }, (_, i) => ({ fileId: i + 1 }))
          },
          'attachments'
        ],
        [{ channelId: 0, content: 'x' }, 'channelId'],
        [{ channelId: TEXT_CHANNEL_ID, content: 'x', replyToId: -1 }, 'replyToId']
      ];

      for (const [input, needle] of cases) {
        const error = await rejection(
          ctx.actions.messages.post(input as Parameters<typeof ctx.actions.messages.post>[0])
        );
        expect(error.code).toBe('BAD_REQUEST');
        expect(error.message).toContain(needle);
      }
    } finally {
      await cleanup();
    }
  });

  test('a reply must target a message of the same channel', async () => {
    const { ctx, cleanup } = await loadPlugin('act-post-reply');

    try {
      const otherChannelId = await createTestChannel({ serverId: 1, categoryId: 1 });

      const cross = await rejection(
        ctx.actions.messages.post({
          channelId: otherChannelId,
          content: 'reply',
          replyToId: SEEDED_MESSAGE_ID
        })
      );
      expect(cross).toEqual({
        code: 'BAD_REQUEST',
        message: 'Reply target not found in this channel'
      });

      const { messageId } = await ctx.actions.messages.post({
        channelId: TEXT_CHANNEL_ID,
        content: 'reply',
        replyToId: SEEDED_MESSAGE_ID
      });
      expect((await messageById(messageId))?.replyToId).toBe(SEEDED_MESSAGE_ID);
    } finally {
      await cleanup();
    }
  });

  test('attachments: files the plugin uploaded attach; someone else\'s or an unknown file do not', async () => {
    const { ctx, cleanup } = await loadPlugin('act-post-attachments');

    try {
      const uploaded = await ctx.actions.files.upload({
        bytes: new TextEncoder().encode('attached text'),
        filename: 'note.txt'
      });

      const spy = spyOn(pubsub, 'publishFor');
      const { messageId } = await ctx.actions.messages.post({
        channelId: TEXT_CHANNEL_ID,
        content: '',
        attachments: [{ fileId: uploaded.id }, { fileId: uploaded.id }]
      });

      const attached = await getTestDb()
        .select()
        .from(messageFiles)
        .where(eq(messageFiles.messageId, messageId));
      expect(attached).toHaveLength(1);
      expect((await messageById(messageId))?.content).toBeNull();

      const [fanout] = published(spy, ServerEvents.NEW_MESSAGE);
      expect((fanout!.payload as { files: unknown[] }).files).toHaveLength(1);

      const [foreign] = await getTestDb()
        .insert(files)
        .values({
          name: `${randomUUIDv7()}.txt`,
          originalName: 'theirs.txt',
          md5: 'x',
          userId: 2,
          size: 1,
          mimeType: 'text/plain',
          extension: '.txt',
          createdAt: Date.now()
        })
        .returning({ id: files.id });

      const notMine = await rejection(
        ctx.actions.messages.post({
          channelId: TEXT_CHANNEL_ID,
          content: 'x',
          attachments: [{ fileId: foreign!.id }]
        })
      );
      expect(notMine.code).toBe('FORBIDDEN');

      const unknown = await rejection(
        ctx.actions.messages.post({
          channelId: TEXT_CHANNEL_ID,
          content: 'x',
          attachments: [{ fileId: 999_999 }]
        })
      );
      expect(unknown).toEqual({ code: 'NOT_FOUND', message: 'Attachment not found' });
    } finally {
      await cleanup();
    }
  });

  test('auto-moderation runs with the owner as the accountable user and blocks like the webhook path', async () => {
    const { ctx, cleanup } = await loadPlugin('act-post-automod');

    try {
      await getTestDb()
        .insert(automodRules)
        .values({
          serverId: 1,
          name: 'no-forbidden',
          type: AutomodRuleType.KEYWORD_FILTER,
          enabled: true,
          config: { keywords: ['forbidden'] },
          actions: [{ type: 'log' }],
          createdBy: 1,
          createdAt: Date.now()
        });

      const blocked = await rejection(
        ctx.actions.messages.post({ channelId: TEXT_CHANNEL_ID, content: 'this is FORBIDDEN' })
      );
      expect(blocked).toEqual({ code: 'FORBIDDEN', message: 'Message blocked by auto-moderation' });

      await expect(
        ctx.actions.messages.post({ channelId: TEXT_CHANNEL_ID, content: 'this is fine' })
      ).resolves.toMatchObject({ messageId: expect.any(Number) });
    } finally {
      await cleanup();
    }
  });
});

describe('actions.messages.edit / delete — ownership', () => {
  test('a plugin edits and deletes its own posts (by messageId or externalId) with the user routes\' fan-out', async () => {
    const id = 'act-own-edit';
    const { ctx, cleanup } = await loadPlugin(id);

    try {
      const { messageId } = await ctx.actions.messages.post({
        channelId: TEXT_CHANNEL_ID,
        content: 'v1',
        externalId: 'ext'
      });

      const spy = spyOn(pubsub, 'publishFor');
      const events = await collect(['message:updated', 'message:deleted'], async () => {
        await ctx.actions.messages.edit({ externalId: 'ext', content: 'v2' });
        expect(await messageById(messageId)).toMatchObject({ content: 'v2', edited: true });

        await ctx.actions.messages.edit({ messageId, content: 'v3' });
        expect((await messageById(messageId))?.content).toBe('v3');

        await ctx.actions.messages.delete({ messageId });
      });

      expect(await messageById(messageId)).toBeUndefined();
      expect(await linksOf(id)).toHaveLength(0);

      const updates = published(spy, ServerEvents.MESSAGE_UPDATE);
      expect(updates).toHaveLength(2);
      expect((updates[1]!.payload as { content: string }).content).toBe('v3');
      expect(published(spy, ServerEvents.MESSAGE_DELETE)).toEqual([
        { recipients: expect.arrayContaining([1, 2, 3]), payload: { messageId, channelId: TEXT_CHANNEL_ID } }
      ]);

      expect(events.map((e) => e.event)).toEqual([
        'message:updated',
        'message:updated',
        'message:deleted'
      ]);
      expect(events[0]!.payload).toEqual({
        messageId,
        channelId: TEXT_CHANNEL_ID,
        userId: OWNER_ID,
        content: 'v2',
        pluginId: id
      });
    } finally {
      await cleanup();
    }
  });

  test('without moderate-messages a foreign message is FORBIDDEN; an unknown ref is NOT_FOUND; content is bounded', async () => {
    const { ctx, cleanup } = await loadPlugin('act-foreign-edit');

    try {
      expect(
        (await rejection(ctx.actions.messages.edit({ messageId: SEEDED_MESSAGE_ID, content: 'x' }))).code
      ).toBe('FORBIDDEN');
      expect(
        (await rejection(ctx.actions.messages.delete({ messageId: SEEDED_MESSAGE_ID }))).code
      ).toBe('FORBIDDEN');
      expect(
        (await rejection(ctx.actions.messages.react({ messageId: SEEDED_MESSAGE_ID, emoji: '👍' }))).code
      ).toBe('FORBIDDEN');
      expect((await messageById(SEEDED_MESSAGE_ID))?.content).toBe('Test message');

      expect(await rejection(ctx.actions.messages.edit({ externalId: 'nope', content: 'x' }))).toEqual({
        code: 'NOT_FOUND',
        message: 'Message not found'
      });
      expect((await rejection(ctx.actions.messages.delete({ messageId: 999_999 }))).code).toBe(
        'NOT_FOUND'
      );

      const { messageId } = await ctx.actions.messages.post({ channelId: TEXT_CHANNEL_ID, content: 'mine' });
      expect((await rejection(ctx.actions.messages.edit({ messageId, content: '' }))).code).toBe(
        'BAD_REQUEST'
      );
      expect(
        (
          await rejection(
            ctx.actions.messages.edit({ messageId, content: 'x'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 1) })
          )
        ).code
      ).toBe('BAD_REQUEST');
      expect(
        (await rejection(ctx.actions.messages.edit({ messageId: 1, externalId: 'both', content: 'x' } as never)))
          .code
      ).toBe('BAD_REQUEST');
    } finally {
      await cleanup();
    }
  });

  test('with capabilities: ["moderate-messages"] a plugin edits, reacts to and deletes any message', async () => {
    const { ctx, cleanup } = await loadPlugin('act-moderator', {
      capabilities: ['moderate-messages']
    });

    try {
      expect((await pluginManager.getPluginInfo('act-moderator')).capabilities).toEqual([
        'moderate-messages'
      ]);

      await ctx.actions.messages.edit({ messageId: SEEDED_MESSAGE_ID, content: 'moderated' });
      expect((await messageById(SEEDED_MESSAGE_ID))?.content).toBe('moderated');

      await ctx.actions.messages.react({ messageId: SEEDED_MESSAGE_ID, emoji: '👀' });
      const reactions = await getTestDb()
        .select()
        .from(messageReactions)
        .where(eq(messageReactions.messageId, SEEDED_MESSAGE_ID));
      expect(reactions).toHaveLength(1);

      await ctx.actions.messages.delete({ messageId: SEEDED_MESSAGE_ID });
      expect(await messageById(SEEDED_MESSAGE_ID)).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  test('a manifest with an unknown capability is refused at getPluginInfo', async () => {
    const id = 'act-bad-capability';
    const dir = path.join(PLUGINS_PATH, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: id,
        version: '1.0.0',
        pulse: { entry: 'index.js', author: 't', description: 'd', capabilities: ['rule-the-world'] }
      })
    );
    await fs.writeFile(path.join(dir, 'index.js'), STASH_SOURCE);

    try {
      await expect(pluginManager.getPluginInfo(id)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('actions.messages.react', () => {
  test('adds and removes a reaction under the owner, idempotently, with MESSAGE_UPDATE fan-out and message:reaction', async () => {
    const id = 'act-react';
    const { ctx, cleanup } = await loadPlugin(id);

    try {
      const { messageId } = await ctx.actions.messages.post({ channelId: TEXT_CHANNEL_ID, content: 'react me' });
      const spy = spyOn(pubsub, 'publishFor');

      const events = await collect(['message:reaction'], async () => {
        await ctx.actions.messages.react({ messageId, emoji: '👍' });
        // Replaying "added" must not toggle it off.
        await ctx.actions.messages.react({ messageId, emoji: '👍' });
        await ctx.actions.messages.react({ messageId, emoji: '👍', remove: true });
        await ctx.actions.messages.react({ messageId, emoji: '👍', remove: true });
      });

      const reactionsAfter = await getTestDb()
        .select()
        .from(messageReactions)
        .where(eq(messageReactions.messageId, messageId));
      expect(reactionsAfter).toHaveLength(0);

      const updates = published(spy, ServerEvents.MESSAGE_UPDATE);
      expect(updates).toHaveLength(2);
      expect((updates[0]!.payload as { reactions: { userId: number; emoji: string }[] }).reactions).toEqual([
        expect.objectContaining({ userId: OWNER_ID, emoji: '👍' })
      ]);
      expect((updates[1]!.payload as { reactions: unknown[] }).reactions).toEqual([]);

      expect(events).toEqual([
        {
          event: 'message:reaction',
          payload: { messageId, channelId: TEXT_CHANNEL_ID, userId: OWNER_ID, emoji: '👍', added: true, pluginId: id }
        },
        {
          event: 'message:reaction',
          payload: { messageId, channelId: TEXT_CHANNEL_ID, userId: OWNER_ID, emoji: '👍', added: false, pluginId: id }
        }
      ]);

      expect(
        (await rejection(ctx.actions.messages.react({ messageId, emoji: 'x'.repeat(65) }))).code
      ).toBe('BAD_REQUEST');
    } finally {
      await cleanup();
    }
  });
});

describe('actions.channels', () => {
  test('list returns the server\'s channels in the plugin shape and is scoped by server', async () => {
    const { ctx, cleanup } = await loadPlugin('act-channels-list');

    try {
      const otherServerId = (await insertOtherServer()).id;
      await createTestChannel({ serverId: otherServerId, name: 'elsewhere' });

      const listed = await ctx.actions.channels.list(1);
      expect(listed.map((c) => c.name)).toEqual(['General', 'Voice']);
      expect(listed[0]).toEqual({
        id: TEXT_CHANNEL_ID,
        publicId: expect.any(String),
        serverId: 1,
        name: 'General',
        type: 'TEXT',
        categoryId: 1,
        parentChannelId: null,
        topic: 'General text channel',
        private: false,
        e2ee: false,
        archived: false,
        position: 0
      });
      expect(listed[1]!.type).toBe('VOICE');

      expect((await rejection(ctx.actions.channels.list(0))).code).toBe('BAD_REQUEST');
      expect((await rejection(ctx.actions.channels.list(999_999))).code).toBe('NOT_FOUND');
    } finally {
      await cleanup();
    }
  });

  test('create appends to the category, publishes CHANNEL_CREATE, logs activity; voice gets a runtime; bounds and scope hold', async () => {
    const { ctx, cleanup } = await loadPlugin('act-channels-create');

    try {
      const spy = spyOn(pubsub, 'publishFor');

      const text = await ctx.actions.channels.create({
        serverId: 1,
        name: 'bridge-feed',
        type: 'TEXT',
        topic: 'mirrored'
      });
      expect(text).toMatchObject({
        type: 'TEXT',
        name: 'bridge-feed',
        categoryId: 1,
        serverId: 1,
        topic: 'mirrored',
        position: 1
      });

      const creates = published(spy, ServerEvents.CHANNEL_CREATE);
      expect(creates).toHaveLength(1);
      expect((creates[0]!.payload as { id: number }).id).toBe(text.id);
      expect(creates[0]!.recipients).toEqual(expect.arrayContaining([1, 2, 3]));

      const voice = await ctx.actions.channels.create({
        serverId: 1,
        name: 'raid-voice',
        type: 'VOICE',
        categoryId: 2
      });
      expect(voice.type).toBe('VOICE');
      expect(VoiceRuntime.findById(voice.id)).toBeDefined();

      const otherServerId = (await insertOtherServer()).id;
      const foreignCategoryId = await createTestCategory({ serverId: otherServerId });
      expect(
        await rejection(
          ctx.actions.channels.create({ serverId: 1, name: 'x', type: 'TEXT', categoryId: foreignCategoryId })
        )
      ).toEqual({ code: 'NOT_FOUND', message: 'Category not found' });
      expect(
        (await rejection(ctx.actions.channels.create({ serverId: 1, name: 'x'.repeat(25), type: 'TEXT' }))).code
      ).toBe('BAD_REQUEST');
      expect(
        (await rejection(ctx.actions.channels.create({ serverId: 1, name: 'x', type: 'FORUM' as 'TEXT' }))).code
      ).toBe('BAD_REQUEST');
      expect(
        (await rejection(ctx.actions.channels.create({ serverId: 999_999, name: 'x', type: 'TEXT' }))).code
      ).toBe('NOT_FOUND');
    } finally {
      await cleanup();
    }
  });

  test('createThread from a message links it, publishes THREAD_CREATE to viewers, emits thread:created; a second thread is CONFLICT', async () => {
    const id = 'act-threads';
    const { ctx, cleanup } = await loadPlugin(id);

    try {
      const spy = spyOn(pubsub, 'publishFor');
      let thread!: Awaited<ReturnType<typeof ctx.actions.channels.createThread>>;

      const events = await collect(['thread:created'], async () => {
        thread = await ctx.actions.channels.createThread({
          channelId: TEXT_CHANNEL_ID,
          parentMessageId: SEEDED_MESSAGE_ID,
          name: 'discussion'
        });
      });

      expect(thread).toMatchObject({ type: 'THREAD', parentChannelId: TEXT_CHANNEL_ID, name: 'discussion' });
      expect((await messageById(SEEDED_MESSAGE_ID))?.threadId).toBe(thread.id);

      const created = published(spy, ServerEvents.THREAD_CREATE);
      expect(created).toHaveLength(1);
      expect(created[0]!.payload).toEqual({
        id: thread.id,
        name: 'discussion',
        messageCount: 0,
        lastMessageAt: null,
        archived: false,
        parentChannelId: TEXT_CHANNEL_ID,
        creatorId: OWNER_ID
      });
      expect(published(spy, ServerEvents.MESSAGE_UPDATE)).toHaveLength(1);

      expect(events).toEqual([
        {
          event: 'thread:created',
          payload: {
            threadId: thread.id,
            parentChannelId: TEXT_CHANNEL_ID,
            serverId: 1,
            name: 'discussion',
            creatorId: OWNER_ID,
            parentMessageId: SEEDED_MESSAGE_ID,
            pluginId: id
          }
        }
      ]);

      expect(
        (
          await rejection(
            ctx.actions.channels.createThread({
              channelId: TEXT_CHANNEL_ID,
              parentMessageId: SEEDED_MESSAGE_ID,
              name: 'again'
            })
          )
        ).code
      ).toBe('CONFLICT');

      // Without a message: a standalone thread under the text channel.
      const standalone = await ctx.actions.channels.createThread({ channelId: TEXT_CHANNEL_ID, name: 'free' });
      expect(standalone.parentChannelId).toBe(TEXT_CHANNEL_ID);

      expect(
        (await rejection(ctx.actions.channels.createThread({ channelId: VOICE_CHANNEL_ID, name: 'x' }))).code
      ).toBe('BAD_REQUEST');
      const otherChannelId = await createTestChannel({ serverId: 1, categoryId: 1 });
      expect(
        (
          await rejection(
            ctx.actions.channels.createThread({
              channelId: otherChannelId,
              parentMessageId: SEEDED_MESSAGE_ID,
              name: 'x'
            })
          )
        ).code
      ).toBe('NOT_FOUND');
      expect(
        (await rejection(ctx.actions.channels.createThread({ channelId: TEXT_CHANNEL_ID, name: 'x'.repeat(101) })))
          .code
      ).toBe('BAD_REQUEST');
    } finally {
      await cleanup();
    }
  });

  test('a thread under a private parent copies the parent\'s overrides so only its viewers get it', async () => {
    const { ctx, cleanup } = await loadPlugin('act-private-thread');

    try {
      const tdb = getTestDb();
      const privateChannelId = await createTestChannel({ serverId: 1, categoryId: 1, name: 'secret' });
      await tdb.update(channels).set({ private: true }).where(eq(channels.id, privateChannelId));
      await tdb.insert(channelUserPermissions).values({
        channelId: privateChannelId,
        userId: 2,
        permission: ChannelPermission.VIEW_CHANNEL,
        allow: true,
        createdAt: Date.now()
      });

      const spy = spyOn(pubsub, 'publishFor');
      const thread = await ctx.actions.channels.createThread({ channelId: privateChannelId, name: 'inner' });

      expect(thread.private).toBe(true);
      const copied = await tdb
        .select()
        .from(channelUserPermissions)
        .where(
          and(eq(channelUserPermissions.channelId, thread.id), eq(channelUserPermissions.userId, 2))
        );
      expect(copied).toHaveLength(1);

      const [created] = published(spy, ServerEvents.THREAD_CREATE);
      expect([...created!.recipients].sort()).toEqual([1, 2]);
    } finally {
      await cleanup();
    }
  });
});

describe('actions.members.list', () => {
  test('returns id, publicId, name, nickname?, avatarUrl? and this server\'s roles — nothing else', async () => {
    const { ctx, cleanup } = await loadPlugin('act-members');

    try {
      const tdb = getTestDb();
      const [avatar] = await tdb
        .insert(files)
        .values({
          name: `${randomUUIDv7()}.png`,
          originalName: 'me.png',
          md5: 'x',
          userId: 2,
          size: 1,
          mimeType: 'image/png',
          extension: '.png',
          createdAt: Date.now()
        })
        .returning({ id: files.id, name: files.name });
      await tdb.update(users).set({ avatarId: avatar!.id }).where(eq(users.id, 2));
      const { serverMembers } = await import('../../db/schema');
      await tdb
        .update(serverMembers)
        .set({ nickname: 'Nick' })
        .where(and(eq(serverMembers.serverId, 1), eq(serverMembers.userId, 2)));
      // A tombstoned account is not someone a plugin can address.
      await tdb.update(users).set({ deletedAt: Date.now() }).where(eq(users.id, 3));
      // A role in ANOTHER server the member also belongs to must not leak.
      const otherServerId = (await insertOtherServer()).id;
      const { createTestRole, createTestServerMember, grantTestUserRole } = await import(
        '../../__tests__/fixtures'
      );
      const foreignRoleId = await createTestRole({ serverId: otherServerId, name: 'Elsewhere' });
      await createTestServerMember({ serverId: otherServerId, userId: 2 });
      await grantTestUserRole(2, foreignRoleId);

      const members = await ctx.actions.members.list(1);
      expect(members.map((m) => m.id)).toEqual([1, 2]);
      expect(members[0]).toEqual({
        id: 1,
        publicId: expect.any(String),
        name: 'Test Owner',
        roles: [{ id: 1, name: 'Owner' }]
      });
      expect(members[1]).toEqual({
        id: 2,
        publicId: expect.any(String),
        name: 'Test User',
        nickname: 'Nick',
        avatarUrl: `/public/${avatar!.name}`,
        roles: [{ id: MEMBER_ROLE_ID, name: 'Member' }]
      });
      for (const member of members) {
        expect(Object.keys(member).sort()).toEqual(
          expect.not.arrayContaining(['email', 'supabaseId', '_identity', 'federatedPublicId'])
        );
      }

      expect((await rejection(ctx.actions.members.list(0))).code).toBe('BAD_REQUEST');
      expect((await rejection(ctx.actions.members.list(999_999))).code).toBe('NOT_FOUND');
    } finally {
      await cleanup();
    }
  });

  test('a freshly created user outside the server is not listed, and a new member appears', async () => {
    const { ctx, cleanup } = await loadPlugin('act-members-scope');

    try {
      const outsiderId = await createTestUser({ name: 'outsider' });
      expect((await ctx.actions.members.list(1)).some((m) => m.id === outsiderId)).toBe(false);

      const { createTestServerMember } = await import('../../__tests__/fixtures');
      await createTestServerMember({ serverId: 1, userId: outsiderId });
      const joined = (await ctx.actions.members.list(1)).find((m) => m.id === outsiderId);
      expect(joined).toMatchObject({ name: 'outsider', roles: [] });
    } finally {
      await cleanup();
    }
  });
});

describe('actions.files.upload', () => {
  test('from bytes: stored under the owner, on disk under its public name, with the upload route\'s gates', async () => {
    const { ctx, cleanup } = await loadPlugin('act-upload-bytes');

    try {
      const ref = await ctx.actions.files.upload({ bytes: pngBytes(), filename: 'shot.png' });
      expect(ref).toEqual({
        id: expect.any(Number),
        name: expect.stringMatching(/\.png$/),
        originalName: 'shot.png',
        url: `/public/${ref.name}`,
        size: pngBytes().byteLength,
        mimeType: 'image/png'
      });
      const [row] = await getTestDb().select().from(files).where(eq(files.id, ref.id));
      expect(row).toMatchObject({ userId: OWNER_ID, encrypted: false });
      expect(await fs.stat(path.join(PUBLIC_PATH, ref.name))).toBeTruthy();

      // Extension from the mime when the name has none; a blocked one is refused.
      const named = await ctx.actions.files.upload({
        bytes: pngBytes().buffer as ArrayBuffer,
        filename: 'avatar',
        mime: 'image/png'
      });
      expect(named.name).toMatch(/\.png$/);
      expect(
        (await rejection(ctx.actions.files.upload({ bytes: pngBytes(), filename: 'evil.html' }))).message
      ).toContain('.html is not allowed');

      expect(
        (await rejection(ctx.actions.files.upload({ bytes: new Uint8Array(0), filename: 'empty.bin' }))).code
      ).toBe('BAD_REQUEST');
      expect(
        (await rejection(ctx.actions.files.upload({ filename: 'nothing.bin' }))).message
      ).toContain('exactly one of bytes or url');
      expect(
        (
          await rejection(
            ctx.actions.files.upload({ bytes: pngBytes(), url: 'https://x.example/a.png', filename: 'both.png' })
          )
        ).code
      ).toBe('BAD_REQUEST');

      await getTestDb().update(servers).set({ storageUploadMaxFileSize: 8 }).where(eq(servers.id, 1));
      expect(
        (await rejection(ctx.actions.files.upload({ bytes: pngBytes(), filename: 'big.png' }))).message
      ).toContain('maximum allowed size');

      await getTestDb().update(servers).set({ storageUploadEnabled: false }).where(eq(servers.id, 1));
      expect(
        (await rejection(ctx.actions.files.upload({ bytes: new Uint8Array([1]), filename: 'x.bin' }))).code
      ).toBe('FORBIDDEN');
    } finally {
      await cleanup();
    }
  });

  test('from a URL: fetched through the hardened client (pinned address, Host header, no redirects) and capped', async () => {
    const { ctx, cleanup } = await loadPlugin('act-upload-url');

    try {
      const body = pngBytes();
      const calls = stubOutbound(
        () =>
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': String(body.byteLength) }
          })
      );

      const ref = await ctx.actions.files.upload({
        url: 'https://cdn.example/avatars/bot.png',
        filename: 'bot.png'
      });
      expect(ref.size).toBe(body.byteLength);
      expect(ref.mimeType).toBe('image/png');

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://93.184.216.34/avatars/bot.png');
      expect(new Headers(calls[0]!.init?.headers).get('host')).toBe('cdn.example');
      expect(calls[0]!.init?.redirect).toBe('manual');
    } finally {
      await cleanup();
    }
  });

  test('from a URL: private targets never dial; redirects, non-2xx and oversize bodies are refused', async () => {
    const { ctx, cleanup } = await loadPlugin('act-upload-url-refusals');

    try {
      const calls = stubOutbound((url) => {
        if (url.includes('/redirect')) {
          return new Response(null, { status: 302, headers: { Location: 'http://10.0.0.1/' } });
        }
        if (url.includes('/missing')) return new Response('nope', { status: 404 });
        return new Response(new Uint8Array(64), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' }
        });
      });

      const loopback = await rejection(
        ctx.actions.files.upload({ url: 'http://127.0.0.1:9971/x.bin', filename: 'x.bin' })
      );
      expect(loopback.code).toBe('BAD_REQUEST');
      expect(loopback.message).toContain('Private/internal');
      expect(calls).toHaveLength(0);

      expect(
        (await rejection(ctx.actions.files.upload({ url: 'https://cdn.example/redirect', filename: 'r.bin' })))
          .message
      ).toContain('Refusing redirect');
      expect(
        (await rejection(ctx.actions.files.upload({ url: 'https://cdn.example/missing', filename: 'm.bin' })))
          .message
      ).toContain('upstream answered 404');

      await getTestDb().update(servers).set({ storageUploadMaxFileSize: 16 }).where(eq(servers.id, 1));
      expect(
        (await rejection(ctx.actions.files.upload({ url: 'https://cdn.example/big.bin', filename: 'b.bin' })))
          .message
      ).toContain('maximum allowed size');

      expect(
        (await rejection(ctx.actions.files.upload({ url: 'ftp://cdn.example/a', filename: 'a.bin' }))).code
      ).toBe('BAD_REQUEST');
    } finally {
      await cleanup();
    }
  });
});

describe('ctx.fetch', () => {
  test('dials through the hardened client: pinned address, Host + caller headers, method and body, bounded read', async () => {
    const { ctx, cleanup } = await loadPlugin('act-fetch');

    try {
      const calls = stubOutbound(
        () =>
          new Response(JSON.stringify({ ok: 1 }), {
            status: 201,
            headers: { 'content-type': 'application/json', 'x-up': 'yes' }
          })
      );

      const response = await ctx.fetch('https://api.example/v1/thing?x=1', {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: '{"a":1}'
      });

      expect(response).toMatchObject({ ok: true, status: 201, headers: expect.objectContaining({ 'x-up': 'yes' }) });
      expect(await response.json()).toEqual({ ok: 1 });
      expect(await response.text()).toBe('{"ok":1}');

      expect(calls[0]!.url).toBe('https://93.184.216.34/v1/thing?x=1');
      expect(calls[0]!.init?.method).toBe('POST');
      expect(calls[0]!.init?.body).toBe('{"a":1}');
      const sent = new Headers(calls[0]!.init?.headers);
      expect(sent.get('host')).toBe('api.example');
      expect(sent.get('authorization')).toBe('Bearer t');
      expect(calls[0]!.init?.redirect).toBe('manual');
      expect(calls[0]!.init?.tls?.serverName).toBe('api.example');
    } finally {
      await cleanup();
    }
  });

  test('refuses private targets without dialling, redirects, bad schemes, oversize bodies and out-of-range options', async () => {
    const { ctx, cleanup } = await loadPlugin('act-fetch-refusals');

    try {
      const calls = stubOutbound((url) =>
        url.includes('/go')
          ? new Response(null, { status: 301, headers: { Location: 'http://169.254.169.254/' } })
          : new Response('x'.repeat(2048), { status: 200 })
      );

      const privateTarget = await rejection(ctx.fetch('http://192.168.1.1/admin'));
      expect(privateTarget.code).toBe('BAD_REQUEST');
      expect(calls).toHaveLength(0);

      expect((await rejection(ctx.fetch('https://api.example/go'))).message).toContain('Refusing redirect');
      expect((await rejection(ctx.fetch('file:///etc/passwd'))).code).toBe('BAD_REQUEST');

      const capped = await ctx.fetch('https://api.example/big', { maxBytes: 1024 });
      await expect(capped.text()).rejects.toThrow('exceeded 1024 bytes');

      expect((await rejection(ctx.fetch('https://api.example/x', { timeoutMs: 0 }))).code).toBe('BAD_REQUEST');
      expect((await rejection(ctx.fetch('https://api.example/x', { maxBytes: 65 * 1024 * 1024 }))).code).toBe(
        'BAD_REQUEST'
      );
      expect((await rejection(ctx.fetch('https://api.example/x', { method: 'get' }))).code).toBe('BAD_REQUEST');
    } finally {
      await cleanup();
    }
  });
});

describe('actions.events', () => {
  const fakeQueries = () => {
    const calls: { name: string; args: unknown[] }[] = [];
    const event = {
      id: 7,
      serverId: 1,
      title: 'Raid',
      description: null,
      gameTag: null,
      startsAt: 1,
      endsAt: 2,
      hostId: null,
      roles: [],
      maxParticipants: null,
      announceChannelId: null,
      voiceChannelId: null,
      status: 'scheduled' as const
    };
    const queries: TEventQueries = {
      createEvent: async (...args) => {
        calls.push({ name: 'createEvent', args });
        return event;
      },
      updateEvent: async (...args) => {
        calls.push({ name: 'updateEvent', args });
        return { ...event, title: 'Renamed' };
      },
      cancelEvent: async (...args) => {
        calls.push({ name: 'cancelEvent', args });
      }
    };
    return { calls, queries };
  };

  test('create / update / cancel validate, then call the scheduler queries with a plugin actor', async () => {
    const { calls, queries } = fakeQueries();
    const actions = createEventActions('raid-bot', async () => queries);
    const startsAt = Date.now() + 3_600_000;

    const created = await actions.create({
      serverId: 1,
      title: 'Raid night',
      startsAt,
      endsAt: startsAt + 7_200_000,
      roles: [{ key: 'dps', label: 'DPS', cap: 14, color: '#ff5c6c' }]
    });
    expect(created.id).toBe(7);
    expect(calls[0]).toEqual({
      name: 'createEvent',
      args: [
        {
          serverId: 1,
          title: 'Raid night',
          startsAt,
          endsAt: startsAt + 7_200_000,
          roles: [{ key: 'dps', label: 'DPS', cap: 14, color: '#ff5c6c' }],
          hostId: null,
          actor: { kind: 'plugin', pluginId: 'raid-bot' }
        }
      ]
    });

    const updated = await actions.update(7, { title: 'Renamed' });
    expect(updated.title).toBe('Renamed');
    expect(calls[1]).toEqual({
      name: 'updateEvent',
      args: [7, { title: 'Renamed' }, { kind: 'plugin', pluginId: 'raid-bot' }]
    });

    await actions.cancel(7);
    expect(calls[2]).toEqual({ name: 'cancelEvent', args: [7, { kind: 'plugin', pluginId: 'raid-bot' }] });
  });

  test('bounds are enforced before anything is loaded', async () => {
    let loads = 0;
    const actions = createEventActions('raid-bot', async () => {
      loads++;
      return fakeQueries().queries;
    });
    const base = { serverId: 1, startsAt: 10, endsAt: 20, roles: [{ key: 'k', label: 'L', cap: null, color: null }] };

    expect((await rejection(actions.create({ ...base, title: '' }))).code).toBe('BAD_REQUEST');
    expect((await rejection(actions.create({ ...base, title: 't'.repeat(121) }))).code).toBe('BAD_REQUEST');
    expect((await rejection(actions.create({ ...base, title: 't', endsAt: 5 }))).message).toContain(
      'endsAt must be after startsAt'
    );
    expect(
      (await rejection(actions.create({ ...base, title: 't', endsAt: 10 + 25 * 3_600_000 }))).code
    ).toBe('BAD_REQUEST');
    expect((await rejection(actions.create({ ...base, title: 't', roles: [] }))).code).toBe('BAD_REQUEST');
    expect(
      (
        await rejection(
          actions.create({ ...base, title: 't', roles: Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, label: 'L', cap: null, color: null })) })
        )
      ).code
    ).toBe('BAD_REQUEST');
    expect(
      (await rejection(actions.create({ ...base, title: 't', roles: [{ key: 'k', label: 'L', cap: 0, color: null }] })))
        .code
    ).toBe('BAD_REQUEST');
    expect(
      (await rejection(actions.create({ ...base, title: 't', roles: [{ key: 'k', label: 'L', cap: null, color: 'red' }] })))
        .code
    ).toBe('BAD_REQUEST');
    expect((await rejection(actions.create({ ...base, title: 't', maxParticipants: 501 }))).code).toBe(
      'BAD_REQUEST'
    );
    expect((await rejection(actions.update(0, { title: 'x' }))).code).toBe('BAD_REQUEST');
    expect((await rejection(actions.update(1, { startsAt: 5, endsAt: 1 }))).code).toBe('BAD_REQUEST');
    expect((await rejection(actions.cancel(-1))).code).toBe('BAD_REQUEST');
    expect(loads).toBe(0);
  });

  test('a missing or partial scheduler module answers UNAVAILABLE', async () => {
    const throwing = createEventActions('p', async () => {
      throw new Error('Cannot find module');
    });
    const partial = createEventActions('p', async () => ({ createEvent: fakeQueries().queries.createEvent }));
    const input = {
      serverId: 1,
      title: 't',
      startsAt: 10,
      endsAt: 20,
      roles: [{ key: 'k', label: 'L', cap: null, color: null }]
    };

    expect(await rejection(throwing.create(input))).toEqual({
      code: 'UNAVAILABLE',
      message: 'Scheduled events are not available on this server'
    });
    expect((await rejection(partial.cancel(1))).code).toBe('UNAVAILABLE');
  });

  test('through a loaded plugin the real scheduler creates, updates and cancels an event', async () => {
    const { ctx, cleanup } = await loadPlugin('act-events-real');

    try {
      const startsAt = Date.now() + 3_600_000;
      const created = await ctx.actions.events.create({
        serverId: 1,
        title: 'Plugin raid',
        startsAt,
        endsAt: startsAt + 3_600_000,
        roles: [{ key: 'dps', label: 'DPS', cap: null, color: null }]
      });
      // No asymmetric matcher on an object reused below: bun's
      // toMatchObject writes `expect.any()` back into the received value.
      expect(typeof created.id).toBe('number');
      expect(created).toMatchObject({ serverId: 1, title: 'Plugin raid', status: 'scheduled' });

      const updated = await ctx.actions.events.update(created.id, { title: 'Plugin raid II' });
      expect(updated.title).toBe('Plugin raid II');

      await ctx.actions.events.cancel(created.id);
      const { events: eventsTable } = await import('../../db/schema');
      const [row] = await getTestDb().select().from(eventsTable).where(eq(eventsTable.id, created.id));
      expect(row?.status).toBe('cancelled');
    } finally {
      await cleanup();
    }
  });
});
