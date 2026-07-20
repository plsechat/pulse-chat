import { ChannelType } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { and, eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import {
  channelReadStates,
  channels,
  invites,
  messages,
  servers
} from '../../db/schema';

/**
 * Build a second server owned by user 1 that user 2 has NOT joined:
 * discoverable as requested, the public TEXT channel from servers.create,
 * one extra private channel, and one seeded message from user 1. Called
 * inside each test (not beforeEach) so it doesn't compete with the global
 * per-test TRUNCATE.
 */
const createPreviewTarget = async (
  ownerCaller: Awaited<ReturnType<typeof initTest>>['caller'],
  { discoverable = true } = {}
) => {
  const tdb = getTestDb();
  const server = await ownerCaller.servers.create({ name: 'Preview Target' });

  if (discoverable) {
    await tdb
      .update(servers)
      .set({ discoverable: true })
      .where(eq(servers.id, server.id));
  }

  const [publicChannel] = await tdb
    .select()
    .from(channels)
    .where(
      and(eq(channels.serverId, server.id), eq(channels.type, ChannelType.TEXT))
    )
    .limit(1);

  const [privateChannel] = await tdb
    .insert(channels)
    .values({
      type: ChannelType.TEXT,
      name: 'private-stuff',
      private: true,
      position: 1,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      publicId: randomUUIDv7(),
      serverId: server.id,
      createdAt: Date.now()
    })
    .returning();

  await tdb.insert(messages).values({
    channelId: publicChannel!.id,
    userId: 1,
    content: 'preview-visible message',
    createdAt: Date.now()
  });

  return {
    server,
    publicChannel: publicChannel!,
    privateChannel: privateChannel!
  };
};

describe('server preview', () => {
  test('preview of a discoverable server returns public channels only', async () => {
    const { caller: owner } = await initTest(1);
    const target = await createPreviewTarget(owner);
    const { caller, ctx } = await initTest(2);

    const preview = await caller.servers.preview({
      serverId: target.server.id
    });

    expect(preview.serverId).toBe(target.server.publicId);
    expect(preview.serverDbId).toBe(target.server.id);
    expect(preview.serverName).toBe('Preview Target');
    expect(preview.inviteCode).toBeNull();
    expect(preview.memberCount).toBe(1);

    const channelIds = preview.channels.map((c) => c.id);
    expect(channelIds).toContain(target.publicChannel.id);
    expect(channelIds).not.toContain(target.privateChannel.id);
    // The per-channel file token is a secret — must not reach previewers
    for (const channel of preview.channels) {
      expect(channel).not.toHaveProperty('fileAccessToken');
    }
    // Roles are for name colors only — permission matrix stays private
    expect(preview.roles.length).toBeGreaterThan(0);
    for (const role of preview.roles) {
      expect(role.permissions).toHaveLength(0);
    }

    expect(ctx.previewServerId).toBe(target.server.id);
  });

  test('preview via a valid invite works and does NOT consume a use', async () => {
    const { caller: owner } = await initTest(1);
    const target = await createPreviewTarget(owner, { discoverable: false });
    await owner.invites.add({
      serverId: target.server.id,
      code: 'preview-invite',
      maxUses: 3
    });

    const { caller, ctx } = await initTest(2);
    const preview = await caller.servers.preview({
      inviteCode: 'preview-invite'
    });

    expect(preview.serverDbId).toBe(target.server.id);
    expect(preview.inviteCode).toBe('preview-invite');
    expect(ctx.previewServerId).toBe(target.server.id);

    const [invite] = await getTestDb()
      .select()
      .from(invites)
      .where(eq(invites.code, 'preview-invite'))
      .limit(1);
    expect(invite!.uses).toBe(0);
  });

  test('preview of a non-discoverable server without invite is refused', async () => {
    const { caller: owner } = await initTest(1);
    const target = await createPreviewTarget(owner, { discoverable: false });
    const { caller, ctx } = await initTest(2);

    await expect(
      caller.servers.preview({ serverId: target.server.id })
    ).rejects.toThrow('not discoverable');
    expect(ctx.previewServerId).toBeUndefined();
  });

  test('expired and exhausted invites are refused without consuming a use', async () => {
    const { caller: owner } = await initTest(1);
    const target = await createPreviewTarget(owner, { discoverable: false });
    await owner.invites.add({
      serverId: target.server.id,
      code: 'stale-invite',
      maxUses: 1,
      expiresAt: Date.now() - 1000
    });

    const { caller } = await initTest(2);

    await expect(
      caller.servers.preview({ inviteCode: 'stale-invite' })
    ).rejects.toThrow('expired');

    const tdb = getTestDb();
    await tdb
      .update(invites)
      .set({ expiresAt: null, uses: 1 })
      .where(eq(invites.code, 'stale-invite'));

    await expect(
      caller.servers.preview({ inviteCode: 'stale-invite' })
    ).rejects.toThrow('maximum uses');
  });

  test('input must carry exactly one of serverId / inviteCode', async () => {
    const { caller: owner } = await initTest(1);
    const target = await createPreviewTarget(owner);
    const { caller } = await initTest(2);

    await expect(caller.servers.preview({})).rejects.toThrow();
    await expect(
      caller.servers.preview({ serverId: target.server.id, inviteCode: 'x' })
    ).rejects.toThrow();
  });

  test('preview by an existing member is refused', async () => {
    const { caller: owner } = await initTest(1);
    const target = await createPreviewTarget(owner);

    await expect(
      owner.servers.preview({ serverId: target.server.id })
    ).rejects.toThrow('already a member');
  });

  test('get-messages in preview returns messages + authors and creates NO read-state row', async () => {
    const { caller: owner } = await initTest(1);
    const target = await createPreviewTarget(owner);
    const { caller } = await initTest(2);

    await caller.servers.preview({ serverId: target.server.id });

    const result = await caller.messages.get({
      channelId: target.publicChannel.id,
      cursor: null,
      limit: 50
    });

    expect(result.messages.map((m) => m.content)).toContain(
      'preview-visible message'
    );
    expect(result.authors).toBeDefined();
    expect(result.authors!.map((a) => a.id)).toContain(1);

    const readStates = await getTestDb()
      .select()
      .from(channelReadStates)
      .where(
        and(
          eq(channelReadStates.channelId, target.publicChannel.id),
          eq(channelReadStates.userId, 2)
        )
      );
    expect(readStates).toHaveLength(0);
  });

  test('get-messages on a private channel in preview is refused', async () => {
    const { caller: owner } = await initTest(1);
    const target = await createPreviewTarget(owner);
    const { caller } = await initTest(2);

    await caller.servers.preview({ serverId: target.server.id });

    await expect(
      caller.messages.get({
        channelId: target.privateChannel.id,
        cursor: null,
        limit: 50
      })
    ).rejects.toThrow('Insufficient channel permissions');
  });

  test('writes are refused in preview (send, mark-as-read, typing)', async () => {
    const { caller: owner } = await initTest(1);
    const target = await createPreviewTarget(owner);
    const { caller } = await initTest(2);

    await caller.servers.preview({ serverId: target.server.id });

    await expect(
      caller.messages.send({
        channelId: target.publicChannel.id,
        content: 'not allowed',
        files: []
      })
    ).rejects.toThrow('Insufficient channel permissions');

    await expect(
      caller.channels.markAsRead({ channelId: target.publicChannel.id })
    ).rejects.toThrow('read-only');

    await expect(
      caller.messages.signalTyping({ channelId: target.publicChannel.id })
    ).rejects.toThrow('read-only');
  });

  test('member-roster queries are refused in preview', async () => {
    const { caller: owner } = await initTest(1);
    const target = await createPreviewTarget(owner);
    const { caller } = await initTest(2);

    await caller.servers.preview({ serverId: target.server.id });

    await expect(
      caller.channels.getVisibleUsers({ channelId: target.publicChannel.id })
    ).rejects.toThrow('read-only');
    await expect(
      caller.channels.getVisibleUserDescriptors({
        channelId: target.publicChannel.id
      })
    ).rejects.toThrow('read-only');
  });

  test('joining the server after preview clears preview state and restores normal flow', async () => {
    const { caller: owner } = await initTest(1);
    const target = await createPreviewTarget(owner, { discoverable: false });
    await owner.invites.add({
      serverId: target.server.id,
      code: 'join-after-preview'
    });

    const { caller, ctx } = await initTest(2);
    await caller.servers.preview({ inviteCode: 'join-after-preview' });
    expect(ctx.previewServerId).toBe(target.server.id);

    await caller.servers.join({ inviteCode: 'join-after-preview' });

    // Switching onto the joined server clears the preview carve-out
    const { handshakeHash } = await caller.others.handshake();
    const bootstrap = await caller.others.joinServer({
      handshakeHash,
      serverId: target.server.id
    });
    expect(bootstrap.serverDbId).toBe(target.server.id);
    expect(ctx.previewServerId).toBeUndefined();

    // Member flow works again: writes allowed, no preview-only authors
    await caller.messages.send({
      channelId: target.publicChannel.id,
      content: 'member now',
      files: []
    });
    const result = await caller.messages.get({
      channelId: target.publicChannel.id,
      cursor: null,
      limit: 50
    });
    expect(result.messages.map((m) => m.content)).toContain('member now');
    expect(result.authors).toBeUndefined();
  });
});
