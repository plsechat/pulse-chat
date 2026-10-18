import { ChannelPermission, ChannelType, ServerEvents } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  createTestCategory,
  createTestChannel,
  createTestServer,
  createTestUser
} from '../../__tests__/fixtures';
import { getCaller, initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { publishChannel } from '../../db/publishers';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { channels } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { pubsub } from '../../utils/pubsub';

const capturePublishes = () => {
  const published: { userIds: unknown; topic: string; payload: unknown }[] = [];
  const original = pubsub.publishFor.bind(pubsub);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pubsub as any).publishFor = (userIds: unknown, topic: string, payload: unknown) => {
    published.push({ userIds, topic, payload });
    return original(userIds as never, topic as never, payload as never);
  };
  return {
    published,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pubsub as any).publishFor = original;
    }
  };
};

const recipientsOf = (e: { userIds: unknown }): number[] =>
  Array.isArray(e.userIds) ? (e.userIds as number[]) : [e.userIds as number];

describe('channels.getPermissions', () => {
  test('is scoped to the active server and gated on MANAGE_CHANNELS', async () => {
    const serverB = await createTestServer({ name: 'B', ownerId: 3 });
    const categoryB = await createTestCategory({ serverId: serverB });
    const channelB = await createTestChannel({ serverId: serverB, categoryId: categoryB });

    const owner = await initTest(1);
    await expect(
      owner.caller.channels.getPermissions({ channelId: channelB })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const matrix = await owner.caller.channels.getPermissions({ channelId: 1 });
    expect(matrix.rolePermissions).toEqual([]);
    expect(matrix.userPermissions).toEqual([]);

    const member = await initTest(2);
    await expect(
      member.caller.channels.getPermissions({ channelId: 1 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('no active server means no permissions', () => {
  test('a connection without an active server cannot read public channels or list users', async () => {
    const lonely = await createTestUser({ name: 'lonely' });
    const { caller, ctx } = await getCaller(lonely);
    const { handshakeHash } = await caller.others.handshake();
    const initial = await caller.others.joinServer({ handshakeHash });
    expect(initial.serverDbId).toBe(0);
    expect(ctx.activeServerId).toBeUndefined();

    await expect(
      caller.messages.get({ channelId: 1, cursor: null, limit: 50 })
    ).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
    await expect(caller.users.getAll()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await ctx.hasPermission('SEND_MESSAGES' as never)).toBe(false);
    expect(await ctx.hasChannelPermission(1, ChannelPermission.VIEW_CHANNEL)).toBe(false);
  });
});

describe('overrides apply to public channels', () => {
  test('a role deny on SEND_MESSAGES blocks sending while VIEW still works', async () => {
    const owner = await initTest(1);
    await owner.caller.channels.updatePermissions({
      channelId: 1,
      roleId: 2,
      permissions: [ChannelPermission.VIEW_CHANNEL]
    });

    const member = await initTest(2);
    expect(member.initialData.channelPermissions[1]!.permissions.VIEW_CHANNEL).toBe(true);
    expect(member.initialData.channelPermissions[1]!.permissions.SEND_MESSAGES).toBe(false);

    await expect(
      member.caller.messages.send({ channelId: 1, content: 'blocked', files: [] })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const page = await member.caller.messages.get({ channelId: 1, cursor: null, limit: 50 });
    expect(page.messages.length).toBeGreaterThan(0);

    // Owner bypass is unchanged.
    await owner.caller.messages.send({ channelId: 1, content: 'owner', files: [] });

    // Fan-out honours the deny: the default-role members are not SEND
    // recipients, the owner always is.
    const senders = await getAffectedUserIdsForChannel(1, {
      permission: ChannelPermission.SEND_MESSAGES
    });
    expect(senders).toEqual([1]);
    const viewers = await getAffectedUserIdsForChannel(1, {
      permission: ChannelPermission.VIEW_CHANNEL
    });
    expect(viewers.sort()).toEqual([1, 2, 3]);
  });

  test('a user allow beats a role deny; a public channel without overrides allows everything', async () => {
    const owner = await initTest(1);
    await owner.caller.channels.updatePermissions({
      channelId: 1,
      roleId: 2,
      permissions: [ChannelPermission.VIEW_CHANNEL]
    });
    await owner.caller.channels.updatePermissions({
      channelId: 1,
      userId: 2,
      permissions: [ChannelPermission.VIEW_CHANNEL, ChannelPermission.SEND_MESSAGES]
    });

    const member = await initTest(2);
    await member.caller.messages.send({ channelId: 1, content: 'allowed', files: [] });

    const other = await initTest(3);
    await expect(
      other.caller.messages.send({ channelId: 1, content: 'blocked', files: [] })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const fresh = await createTestChannel({ serverId: 1, categoryId: 1, name: 'fresh' });
    expect(await other.ctx.hasChannelPermission(fresh, ChannelPermission.SEND_MESSAGES)).toBe(true);
  });
});

describe('channel publishing', () => {
  test('a private channel reaches only its viewers and never carries the file access token', async () => {
    const privateId = await createTestChannel({ serverId: 1, categoryId: 1, name: 'secret' });
    await getTestDb().update(channels).set({ private: true }).where(eq(channels.id, privateId));
    const [row] = await getTestDb()
      .select({ token: channels.fileAccessToken })
      .from(channels)
      .where(eq(channels.id, privateId));

    const capture = capturePublishes();
    try {
      await publishChannel(privateId, 'create');
      await publishChannel(1, 'update');
    } finally {
      capture.restore();
    }

    const create = capture.published.find((e) => e.topic === ServerEvents.CHANNEL_CREATE)!;
    expect(create).toBeDefined();
    expect(recipientsOf(create)).toEqual([1]);
    expect((create.payload as { fileAccessToken: string }).fileAccessToken).toBe('');
    expect((create.payload as { fileAccessToken: string }).fileAccessToken).not.toBe(row!.token);

    const update = capture.published.find((e) => e.topic === ServerEvents.CHANNEL_UPDATE)!;
    expect(recipientsOf(update).sort()).toEqual([1, 2, 3]);
    expect((update.payload as { fileAccessToken: string }).fileAccessToken).toBe('');
  });

  test('flipping a channel private removes it from non-viewers live; an override grant hands it back', async () => {
    const owner = await initTest(1);
    const id = await createTestChannel({ serverId: 1, categoryId: 1, name: 'flip' });
    await getTestDb().update(channels).set({ private: true }).where(eq(channels.id, id));

    // The update fan-out: viewers (owner only) get the row, the rest of
    // the members are told the channel is gone for them.
    let capture = capturePublishes();
    try {
      await publishChannel(id, 'update');
    } finally {
      capture.restore();
    }
    const update = capture.published.find((e) => e.topic === ServerEvents.CHANNEL_UPDATE)!;
    expect(recipientsOf(update)).toEqual([1]);
    const gone = capture.published.find((e) => e.topic === ServerEvents.CHANNEL_DELETE)!;
    expect(recipientsOf(gone).sort()).toEqual([2, 3]);
    expect(gone.payload).toBe(id);

    // Granting user 2 VIEW via an override re-syncs visibility: user 2
    // receives the channel (CHANNEL_CREATE), user 3 is still told it is gone.
    capture = capturePublishes();
    try {
      await owner.caller.channels.updatePermissions({
        channelId: id,
        userId: 2,
        permissions: [ChannelPermission.VIEW_CHANNEL]
      });
    } finally {
      capture.restore();
    }
    const create = capture.published.find((e) => e.topic === ServerEvents.CHANNEL_CREATE)!;
    expect(recipientsOf(create).sort()).toEqual([1, 2]);
    const stillGone = capture.published.find((e) => e.topic === ServerEvents.CHANNEL_DELETE)!;
    expect(recipientsOf(stillGone)).toEqual([3]);
  });

  test('join and channels.get projections do not expose the token', async () => {
    const { caller, initialData } = await initTest(1);
    for (const channel of initialData.channels) {
      expect(channel.fileAccessToken).toBe('');
    }
    const channel = await caller.channels.get({ channelId: 1 });
    expect(channel.fileAccessToken).toBe('');
  });
});

describe('voice runtimes follow their channels', () => {
  test('only voice channels get a runtime; deleting a category tears them down', async () => {
    const { caller } = await initTest(1);
    const categoryId = await caller.categories.add({ serverId: 1, name: 'Temp' });

    const textId = await caller.channels.add({
      type: ChannelType.TEXT,
      name: 'text',
      categoryId,
      serverId: 1
    });
    expect(VoiceRuntime.findById(textId)).toBeUndefined();

    const voiceId = await caller.channels.add({
      type: ChannelType.VOICE,
      name: 'voice',
      categoryId,
      serverId: 1
    });
    expect(VoiceRuntime.findById(voiceId)).toBeDefined();

    const capture = capturePublishes();
    try {
      await caller.categories.delete({ categoryId });
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      capture.restore();
    }

    expect(VoiceRuntime.findById(voiceId)).toBeUndefined();
    const deletes = capture.published
      .filter((e) => e.topic === ServerEvents.CHANNEL_DELETE)
      .map((e) => e.payload);
    expect(deletes.sort()).toEqual([textId, voiceId].sort());
    expect(capture.published.some((e) => e.topic === ServerEvents.CATEGORY_DELETE)).toBe(true);
    expect(
      await getTestDb().select().from(channels).where(eq(channels.categoryId, categoryId))
    ).toEqual([]);
  });
});
