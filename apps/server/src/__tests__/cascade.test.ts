import { ChannelType } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq, ne } from 'drizzle-orm';
import {
  activityLog,
  categories,
  channelReadStates,
  channelRolePermissions,
  channels,
  channelUserPermissions,
  dmChannelMembers,
  dmChannels,
  dmE2eeSenderKeys,
  dmMessages,
  e2eeSenderKeys,
  emojis,
  federationInstances,
  files,
  invites,
  logins,
  messageFiles,
  messageReactions,
  messages,
  nameplates,
  reports,
  rolePermissions,
  roles,
  servers,
  settings,
  userBlocks,
  userIdentityKeys,
  userKeyBackups,
  userNotes,
  userOneTimePreKeys,
  userRoles,
  users,
  userSignedPreKeys,
  webhooks
} from '../db/schema';
import { tdb } from './setup';

// servers.owner_id is ON DELETE RESTRICT (0032): the seeded owner cannot
// be hard-deleted while server 1 points at them, so the user-cascade
// cases below pick a member instead.
const seededOwnerId = async () => {
  const [server] = await tdb
    .select({ ownerId: servers.ownerId })
    .from(servers)
    .where(eq(servers.id, 1));
  return server!.ownerId!;
};

// Drizzle wraps the postgres error; the SQLSTATE lives on `.cause`.
const pgErrorCode = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (err) {
    let cur: unknown = err;
    for (let depth = 0; cur && depth < 4; depth++) {
      const code = (cur as { code?: string }).code;
      if (code) return code;
      cur = (cur as { cause?: unknown }).cause;
    }
    return 'unknown';
  }
  return 'no-error';
};

const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

/** Two distinct non-owner members (the seed has exactly two). */
const twoNonOwnerUserIds = async (): Promise<[number, number]> => {
  const ownerId = await seededOwnerId();
  const rows = await tdb
    .select({ id: users.id })
    .from(users)
    .where(ne(users.id, ownerId))
    .orderBy(users.id)
    .limit(2);
  return [rows[0]!.id, rows[1]!.id];
};

const insertFile = async (userId: number, name: string) => {
  const [file] = await tdb
    .insert(files)
    .values({
      name,
      originalName: name,
      md5: `md5-${name}`,
      userId,
      size: 10,
      mimeType: 'image/png',
      extension: 'png',
      createdAt: Date.now()
    })
    .returning();
  return file!;
};

const insertReport = async (
  overrides: Partial<typeof reports.$inferInsert> &
    Pick<typeof reports.$inferInsert, 'targetUserId' | 'reporterId'>
) => {
  const [row] = await tdb
    .insert(reports)
    .values({
      kind: 'user',
      reason: 'spam',
      audience: 'instance',
      createdAt: Date.now(),
      ...overrides
    })
    .returning();
  return row!;
};

const nonOwnerUserId = async () => {
  const ownerId = await seededOwnerId();
  const [user] = await tdb
    .select({ id: users.id })
    .from(users)
    .where(ne(users.id, ownerId))
    .orderBy(users.id)
    .limit(1);
  return user!.id;
};

describe('database cascades', async () => {
  test('initial data is seeded correctly', async () => {
    const messageRows = await tdb.select().from(messages);
    const channelRows = await tdb.select().from(channels);
    const categoriesRows = await tdb.select().from(categories);
    const userRows = await tdb.select().from(users);
    const roleRows = await tdb.select().from(roles);

    expect(messageRows.length).toBeGreaterThan(0);
    expect(channelRows.length).toBeGreaterThan(0);
    expect(categoriesRows.length).toBeGreaterThan(0);
    expect(userRows.length).toBeGreaterThan(0);
    expect(roleRows.length).toBeGreaterThan(0);
  });

  test('deleting a channel cascades to messages', async () => {
    const channelsBefore = await tdb.select().from(channels);
    const messagesBefore = await tdb.select().from(messages);

    expect(messagesBefore.length).toBeGreaterThan(0);

    await tdb.delete(channels).where(eq(channels.id, channelsBefore[0]!.id));

    const messagesAfter = await tdb.select().from(messages);
    expect(messagesAfter.length).toBe(0);
  });

  test('deleting a category cascades to channels and messages', async () => {
    const categoriesBefore = await tdb.select().from(categories);
    const channelsBefore = await tdb.select().from(channels);

    const channelsInCategory = channelsBefore.filter(
      (ch) => ch.categoryId === categoriesBefore[0]!.id
    );

    await tdb
      .delete(categories)
      .where(eq(categories.id, categoriesBefore[0]!.id));

    const channelsAfter = await tdb.select().from(channels);
    expect(channelsAfter.length).toBe(
      channelsBefore.length - channelsInCategory.length
    );

    const messagesAfter = await tdb.select().from(messages);
    expect(messagesAfter.length).toBe(0);
  });

  test('deleting a user cascades to messages, logins, invites, activity logs', async () => {
    const userId = await nonOwnerUserId();
    const channelsBefore = await tdb.select().from(channels);

    await tdb.insert(messages).values({
      userId,
      channelId: channelsBefore[0]!.id,
      content: 'by the member',
      createdAt: Date.now()
    });

    await tdb.insert(logins).values({
      userId,
      ip: '127.0.0.1',
      createdAt: Date.now()
    });

    await tdb.insert(invites).values({
      code: 'TEST123',
      creatorId: userId,
      serverId: 1,
      createdAt: Date.now()
    });

    await tdb.insert(activityLog).values({
      userId,
      type: 'TEST',
      createdAt: Date.now()
    });

    const loginsBefore = await tdb.select().from(logins);
    const invitesBefore = await tdb.select().from(invites);
    const activityLogBefore = await tdb.select().from(activityLog);
    const messagesBefore = await tdb
      .select()
      .from(messages)
      .where(eq(messages.userId, userId));

    expect(loginsBefore.length).toBeGreaterThan(0);
    expect(invitesBefore.length).toBeGreaterThan(0);
    expect(activityLogBefore.length).toBeGreaterThan(0);
    expect(messagesBefore.length).toBeGreaterThan(0);

    await tdb.delete(users).where(eq(users.id, userId));

    const loginsAfter = await tdb.select().from(logins);
    const invitesAfter = await tdb.select().from(invites);
    const activityLogAfter = await tdb.select().from(activityLog);
    const messagesAfter = await tdb
      .select()
      .from(messages)
      .where(eq(messages.userId, userId));

    expect(loginsAfter.length).toBe(0);
    expect(invitesAfter.length).toBe(0);
    expect(activityLogAfter.length).toBe(0);
    expect(messagesAfter.length).toBe(0);
  });

  test('deleting a user that owns a server is refused by the owner FK', async () => {
    const ownerId = await seededOwnerId();

    expect(
      await pgErrorCode(tdb.delete(users).where(eq(users.id, ownerId)).execute())
    ).toBe(FOREIGN_KEY_VIOLATION);

    const [owner] = await tdb.select().from(users).where(eq(users.id, ownerId));
    expect(owner).toBeDefined();
    const [server] = await tdb.select().from(servers).where(eq(servers.id, 1));
    expect(server!.ownerId).toBe(ownerId);
  });

  test('deleting a user cascades to their files', async () => {
    const userId = await nonOwnerUserId();

    const [file] = await tdb
      .insert(files)
      .values({
        name: 'owned.txt',
        originalName: 'owned.txt',
        md5: 'owned123',
        userId,
        size: 100,
        mimeType: 'text/plain',
        extension: 'txt',
        createdAt: Date.now()
      })
      .returning();

    await tdb.delete(users).where(eq(users.id, userId));

    const filesAfter = await tdb
      .select()
      .from(files)
      .where(eq(files.id, file!.id));
    expect(filesAfter.length).toBe(0);
  });

  test('deleting a user cascades to user_roles', async () => {
    const userId = await nonOwnerUserId();

    const userRolesBefore = await tdb
      .select()
      .from(userRoles)
      .where(eq(userRoles.userId, userId));

    expect(userRolesBefore.length).toBeGreaterThan(0);

    await tdb.delete(users).where(eq(users.id, userId));

    const userRolesAfter = await tdb
      .select()
      .from(userRoles)
      .where(eq(userRoles.userId, userId));

    expect(userRolesAfter.length).toBe(0);
  });

  test('deleting a role cascades to user_roles and role_permissions', async () => {
    const rolesBefore = await tdb.select().from(roles);
    const roleId = rolesBefore[0]!.id;

    const rolePermissionsBefore = await tdb
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId));

    const userRolesBefore = await tdb
      .select()
      .from(userRoles)
      .where(eq(userRoles.roleId, roleId));

    expect(rolePermissionsBefore.length).toBeGreaterThan(0);
    expect(userRolesBefore.length).toBeGreaterThan(0);

    await tdb.delete(roles).where(eq(roles.id, roleId));

    const rolePermissionsAfter = await tdb
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId));

    const userRolesAfter = await tdb
      .select()
      .from(userRoles)
      .where(eq(userRoles.roleId, roleId));

    expect(rolePermissionsAfter.length).toBe(0);
    expect(userRolesAfter.length).toBe(0);
  });

  test('deleting a role cascades to channel_role_permissions', async () => {
    const rolesBefore = await tdb.select().from(roles);
    const channelsBefore = await tdb.select().from(channels);
    const roleId = rolesBefore[0]!.id;
    const channelId = channelsBefore[0]!.id;

    await tdb.insert(channelRolePermissions).values({
      channelId,
      roleId,
      permission: 'TEST_PERMISSION',
      allow: true,
      createdAt: Date.now()
    });

    const channelRolePermsBefore = await tdb
      .select()
      .from(channelRolePermissions)
      .where(eq(channelRolePermissions.roleId, roleId));

    expect(channelRolePermsBefore.length).toBeGreaterThan(0);

    await tdb.delete(roles).where(eq(roles.id, roleId));

    const channelRolePermsAfter = await tdb
      .select()
      .from(channelRolePermissions)
      .where(eq(channelRolePermissions.roleId, roleId));

    expect(channelRolePermsAfter.length).toBe(0);
  });

  test('deleting a channel cascades to channel_role_permissions and channel_user_permissions', async () => {
    const channelsBefore = await tdb.select().from(channels);
    const rolesBefore = await tdb.select().from(roles);
    const usersBefore = await tdb.select().from(users);
    const channelId = channelsBefore[0]!.id;

    await tdb.insert(channelRolePermissions).values({
      channelId,
      roleId: rolesBefore[0]!.id,
      permission: 'TEST_PERMISSION',
      allow: true,
      createdAt: Date.now()
    });

    await tdb.insert(channelUserPermissions).values({
      channelId,
      userId: usersBefore[0]!.id,
      permission: 'TEST_PERMISSION',
      allow: true,
      createdAt: Date.now()
    });

    const channelRolePermsBefore = await tdb
      .select()
      .from(channelRolePermissions)
      .where(eq(channelRolePermissions.channelId, channelId));

    const channelUserPermsBefore = await tdb
      .select()
      .from(channelUserPermissions)
      .where(eq(channelUserPermissions.channelId, channelId));

    expect(channelRolePermsBefore.length).toBeGreaterThan(0);
    expect(channelUserPermsBefore.length).toBeGreaterThan(0);

    await tdb.delete(channels).where(eq(channels.id, channelId));

    const channelRolePermsAfter = await tdb
      .select()
      .from(channelRolePermissions)
      .where(eq(channelRolePermissions.channelId, channelId));

    const channelUserPermsAfter = await tdb
      .select()
      .from(channelUserPermissions)
      .where(eq(channelUserPermissions.channelId, channelId));

    expect(channelRolePermsAfter.length).toBe(0);
    expect(channelUserPermsAfter.length).toBe(0);
  });

  test('deleting a channel cascades to channel_read_states', async () => {
    const channelsBefore = await tdb.select().from(channels);
    const usersBefore = await tdb.select().from(users);
    const channelId = channelsBefore[0]!.id;
    const userId = usersBefore[0]!.id;

    await tdb.insert(channelReadStates).values({
      channelId,
      userId,
      lastReadAt: Date.now()
    });

    const readStatesBefore = await tdb
      .select()
      .from(channelReadStates)
      .where(eq(channelReadStates.channelId, channelId));

    expect(readStatesBefore.length).toBeGreaterThan(0);

    await tdb.delete(channels).where(eq(channels.id, channelId));

    const readStatesAfter = await tdb
      .select()
      .from(channelReadStates)
      .where(eq(channelReadStates.channelId, channelId));

    expect(readStatesAfter.length).toBe(0);
  });

  test('deleting a user cascades to channel_read_states and channel_user_permissions', async () => {
    const channelsBefore = await tdb.select().from(channels);
    const userId = await nonOwnerUserId();

    await tdb.insert(channelReadStates).values({
      channelId: channelsBefore[0]!.id,
      userId,
      lastReadAt: Date.now()
    });

    await tdb.insert(channelUserPermissions).values({
      channelId: channelsBefore[0]!.id,
      userId,
      permission: 'TEST_PERMISSION',
      allow: true,
      createdAt: Date.now()
    });

    const readStatesBefore = await tdb
      .select()
      .from(channelReadStates)
      .where(eq(channelReadStates.userId, userId));

    const channelUserPermsBefore = await tdb
      .select()
      .from(channelUserPermissions)
      .where(eq(channelUserPermissions.userId, userId));

    expect(readStatesBefore.length).toBeGreaterThan(0);
    expect(channelUserPermsBefore.length).toBeGreaterThan(0);

    await tdb.delete(users).where(eq(users.id, userId));

    const readStatesAfter = await tdb
      .select()
      .from(channelReadStates)
      .where(eq(channelReadStates.userId, userId));

    const channelUserPermsAfter = await tdb
      .select()
      .from(channelUserPermissions)
      .where(eq(channelUserPermissions.userId, userId));

    expect(readStatesAfter.length).toBe(0);
    expect(channelUserPermsAfter.length).toBe(0);
  });

  test('deleting a message cascades to message_files and message_reactions', async () => {
    const messagesBefore = await tdb.select().from(messages);
    const usersBefore = await tdb.select().from(users);
    const messageId = messagesBefore[0]!.id;

    const [file] = await tdb
      .insert(files)
      .values({
        name: 'test.txt',
        originalName: 'test.txt',
        md5: 'test123',
        userId: usersBefore[0]!.id,
        size: 100,
        mimeType: 'text/plain',
        extension: 'txt',
        createdAt: Date.now()
      })
      .returning();

    await tdb.insert(messageFiles).values({
      messageId,
      fileId: file!.id,
      createdAt: Date.now()
    });

    await tdb.insert(messageReactions).values({
      messageId,
      userId: usersBefore[0]!.id,
      emoji: '👍',
      createdAt: Date.now()
    });

    const messageFilesBefore = await tdb
      .select()
      .from(messageFiles)
      .where(eq(messageFiles.messageId, messageId));

    const messageReactionsBefore = await tdb
      .select()
      .from(messageReactions)
      .where(eq(messageReactions.messageId, messageId));

    expect(messageFilesBefore.length).toBeGreaterThan(0);
    expect(messageReactionsBefore.length).toBeGreaterThan(0);

    await tdb.delete(messages).where(eq(messages.id, messageId));

    const messageFilesAfter = await tdb
      .select()
      .from(messageFiles)
      .where(eq(messageFiles.messageId, messageId));

    const messageReactionsAfter = await tdb
      .select()
      .from(messageReactions)
      .where(eq(messageReactions.messageId, messageId));

    expect(messageFilesAfter.length).toBe(0);
    expect(messageReactionsAfter.length).toBe(0);
  });

  test('deleting a file cascades to message_files and emojis', async () => {
    const usersBefore = await tdb.select().from(users);
    const messagesBefore = await tdb.select().from(messages);

    const [file] = await tdb
      .insert(files)
      .values({
        name: 'test2.txt',
        originalName: 'test2.txt',
        md5: 'test456',
        userId: usersBefore[0]!.id,
        size: 100,
        mimeType: 'text/plain',
        extension: 'txt',
        createdAt: Date.now()
      })
      .returning();

    await tdb.insert(messageFiles).values({
      messageId: messagesBefore[0]!.id,
      fileId: file!.id,
      createdAt: Date.now()
    });

    await tdb.insert(emojis).values({
      name: 'test_emoji',
      fileId: file!.id,
      userId: usersBefore[0]!.id,
      serverId: 1,
      createdAt: Date.now()
    });

    const messageFilesBefore = await tdb
      .select()
      .from(messageFiles)
      .where(eq(messageFiles.fileId, file!.id));

    const emojisBefore = await tdb
      .select()
      .from(emojis)
      .where(eq(emojis.fileId, file!.id));

    expect(messageFilesBefore.length).toBeGreaterThan(0);
    expect(emojisBefore.length).toBeGreaterThan(0);

    await tdb.delete(files).where(eq(files.id, file!.id));

    const messageFilesAfter = await tdb
      .select()
      .from(messageFiles)
      .where(eq(messageFiles.fileId, file!.id));

    const emojisAfter = await tdb
      .select()
      .from(emojis)
      .where(eq(emojis.fileId, file!.id));

    expect(messageFilesAfter.length).toBe(0);
    expect(emojisAfter.length).toBe(0);
  });

  test('deleting a user cascades to emojis and message_reactions', async () => {
    const messagesBefore = await tdb.select().from(messages);
    const userId = await nonOwnerUserId();

    const [file] = await tdb
      .insert(files)
      .values({
        name: 'emoji.png',
        originalName: 'emoji.png',
        md5: 'emoji123',
        userId,
        size: 100,
        mimeType: 'image/png',
        extension: 'png',
        createdAt: Date.now()
      })
      .returning();

    await tdb.insert(emojis).values({
      name: 'user_emoji',
      fileId: file!.id,
      userId,
      serverId: 1,
      createdAt: Date.now()
    });

    await tdb.insert(messageReactions).values({
      messageId: messagesBefore[0]!.id,
      userId,
      emoji: '🔥',
      createdAt: Date.now()
    });

    const emojisBefore = await tdb
      .select()
      .from(emojis)
      .where(eq(emojis.userId, userId));

    const messageReactionsBefore = await tdb
      .select()
      .from(messageReactions)
      .where(eq(messageReactions.userId, userId));

    expect(emojisBefore.length).toBeGreaterThan(0);
    expect(messageReactionsBefore.length).toBeGreaterThan(0);

    await tdb.delete(users).where(eq(users.id, userId));

    const emojisAfter = await tdb
      .select()
      .from(emojis)
      .where(eq(emojis.userId, userId));

    const messageReactionsAfter = await tdb
      .select()
      .from(messageReactions)
      .where(eq(messageReactions.userId, userId));

    expect(emojisAfter.length).toBe(0);
    expect(messageReactionsAfter.length).toBe(0);
  });

  test('deleting a parent channel cascades to its threads', async () => {
    const channelsBefore = await tdb.select().from(channels);
    const parent = channelsBefore[0]!;

    const [thread] = await tdb
      .insert(channels)
      .values({
        type: ChannelType.THREAD,
        name: 'thread',
        position: 0,
        fileAccessToken: crypto.randomUUID(),
        fileAccessTokenUpdatedAt: Date.now(),
        publicId: crypto.randomUUID(),
        serverId: parent.serverId,
        parentChannelId: parent.id,
        createdAt: Date.now()
      })
      .returning();

    await tdb.delete(channels).where(eq(channels.id, parent.id));

    const threadsAfter = await tdb
      .select()
      .from(channels)
      .where(eq(channels.id, thread!.id));
    expect(threadsAfter.length).toBe(0);
  });

  test('deleting a replied-to message nulls reply_to_id on the reply', async () => {
    const messagesBefore = await tdb.select().from(messages);
    const target = messagesBefore[0]!;

    const [reply] = await tdb
      .insert(messages)
      .values({
        userId: target.userId,
        channelId: target.channelId,
        content: 'reply',
        replyToId: target.id,
        createdAt: Date.now()
      })
      .returning();

    await tdb.delete(messages).where(eq(messages.id, target.id));

    const [replyAfter] = await tdb
      .select()
      .from(messages)
      .where(eq(messages.id, reply!.id));
    expect(replyAfter).toBeDefined();
    expect(replyAfter!.replyToId).toBeNull();
  });

  test('deleting a webhook nulls webhook_id on its messages', async () => {
    const messagesBefore = await tdb.select().from(messages);
    const channelsBefore = await tdb.select().from(channels);
    const seeded = messagesBefore[0]!;

    const [webhook] = await tdb
      .insert(webhooks)
      .values({
        name: 'hook',
        channelId: channelsBefore[0]!.id,
        token: crypto.randomUUID(),
        createdBy: seeded.userId,
        serverId: channelsBefore[0]!.serverId,
        createdAt: Date.now()
      })
      .returning();

    const [message] = await tdb
      .insert(messages)
      .values({
        userId: seeded.userId,
        channelId: channelsBefore[0]!.id,
        content: 'from webhook',
        webhookId: webhook!.id,
        createdAt: Date.now()
      })
      .returning();

    await tdb.delete(webhooks).where(eq(webhooks.id, webhook!.id));

    const [messageAfter] = await tdb
      .select()
      .from(messages)
      .where(eq(messages.id, message!.id));
    expect(messageAfter).toBeDefined();
    expect(messageAfter!.webhookId).toBeNull();
  });

  test('deleting a replied-to DM message nulls reply_to_id on the reply', async () => {
    const userId = await nonOwnerUserId();

    const [channel] = await tdb
      .insert(dmChannels)
      .values({ createdAt: Date.now() })
      .returning();

    const [target] = await tdb
      .insert(dmMessages)
      .values({
        userId,
        dmChannelId: channel!.id,
        content: 'target',
        createdAt: Date.now()
      })
      .returning();

    const [reply] = await tdb
      .insert(dmMessages)
      .values({
        userId,
        dmChannelId: channel!.id,
        content: 'reply',
        replyToId: target!.id,
        createdAt: Date.now()
      })
      .returning();

    await tdb.delete(dmMessages).where(eq(dmMessages.id, target!.id));

    const [replyAfter] = await tdb
      .select()
      .from(dmMessages)
      .where(eq(dmMessages.id, reply!.id));
    expect(replyAfter).toBeDefined();
    expect(replyAfter!.replyToId).toBeNull();
  });

  test('deleting a federation instance nulls federated_instance_id on its shadow users', async () => {
    const [instance] = await tdb
      .insert(federationInstances)
      .values({
        domain: 'peer.example',
        status: 'active',
        direction: 'outbound',
        createdAt: Date.now()
      })
      .returning();

    const [shadow] = await tdb
      .insert(users)
      .values({
        name: 'shadow',
        supabaseId: `shadow-${crypto.randomUUID()}`,
        publicId: crypto.randomUUID(),
        isFederated: true,
        federatedInstanceId: instance!.id,
        federatedUsername: 'shadow',
        createdAt: Date.now()
      })
      .returning();

    await tdb
      .delete(federationInstances)
      .where(eq(federationInstances.id, instance!.id));

    const [shadowAfter] = await tdb
      .select()
      .from(users)
      .where(eq(users.id, shadow!.id));
    expect(shadowAfter).toBeDefined();
    expect(shadowAfter!.federatedInstanceId).toBeNull();
  });

  // ─── A10-15: nameplates → files, user_blocks, reports, e2ee_* ──────────

  test('deleting a file cascades to the nameplate that uses it', async () => {
    const ownerId = await seededOwnerId();
    const file = await insertFile(ownerId, 'plate.png');
    const [plate] = await tdb
      .insert(nameplates)
      .values({ serverId: 1, name: 'plate', fileId: file.id, createdAt: Date.now() })
      .returning();

    await tdb.delete(files).where(eq(files.id, file.id));

    expect(
      await tdb.select().from(nameplates).where(eq(nameplates.id, plate!.id))
    ).toHaveLength(0);
  });

  test('deleting a server cascades to its nameplates but leaves the file row', async () => {
    const ownerId = await seededOwnerId();
    const file = await insertFile(ownerId, 'plate-server.png');
    const [otherServer] = await tdb
      .insert(servers)
      .values({
        name: 'Plate Server',
        publicId: crypto.randomUUID(),
        allowNewUsers: true,
        storageUploadEnabled: true,
        storageQuota: 0,
        storageUploadMaxFileSize: 0,
        storageSpaceQuotaByUser: 0,
        storageOverflowAction: 'block',
        enablePlugins: false,
        createdAt: Date.now()
      })
      .returning();
    const [plate] = await tdb
      .insert(nameplates)
      .values({
        serverId: otherServer!.id,
        name: 'plate',
        fileId: file.id,
        createdAt: Date.now()
      })
      .returning();

    await tdb.delete(servers).where(eq(servers.id, otherServer!.id));

    expect(
      await tdb.select().from(nameplates).where(eq(nameplates.id, plate!.id))
    ).toHaveLength(0);
    expect(await tdb.select().from(files).where(eq(files.id, file.id))).toHaveLength(1);
  });

  test('deleting a user cascades to user_blocks as blocker AND as blocked', async () => {
    const ownerId = await seededOwnerId();
    const [a, b] = await twoNonOwnerUserIds();
    const now = Date.now();
    await tdb.insert(userBlocks).values([
      { blockerId: a, blockedUserId: b, createdAt: now },
      { blockerId: b, blockedUserId: a, createdAt: now },
      { blockerId: ownerId, blockedUserId: a, createdAt: now },
      { blockerId: ownerId, blockedUserId: b, createdAt: now }
    ]);

    await tdb.delete(users).where(eq(users.id, a));

    const left = await tdb.select().from(userBlocks);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ blockerId: ownerId, blockedUserId: b });
  });

  test('user_blocks refuses a duplicate (blocker, blocked) pair', async () => {
    const [a, b] = await twoNonOwnerUserIds();
    await tdb.insert(userBlocks).values({ blockerId: a, blockedUserId: b, createdAt: 1 });

    expect(
      await pgErrorCode(
        tdb
          .insert(userBlocks)
          .values({ blockerId: a, blockedUserId: b, createdAt: 2 })
          .execute()
      )
    ).toBe(UNIQUE_VIOLATION);
  });

  test('deleting a user cascades to user_notes as author AND as target', async () => {
    const ownerId = await seededOwnerId();
    const [a, b] = await twoNonOwnerUserIds();
    const now = Date.now();
    await tdb.insert(userNotes).values([
      { authorId: a, targetUserId: b, content: 'a->b', createdAt: now },
      { authorId: b, targetUserId: a, content: 'b->a', createdAt: now },
      { authorId: ownerId, targetUserId: b, content: 'o->b', createdAt: now }
    ]);

    await tdb.delete(users).where(eq(users.id, a));

    const left = await tdb.select().from(userNotes);
    expect(left).toHaveLength(1);
    expect(left[0]!.content).toBe('o->b');
  });

  test('deleting the reporter or the target user cascades the report', async () => {
    const ownerId = await seededOwnerId();
    const [a, b] = await twoNonOwnerUserIds();
    const byA = await insertReport({ reporterId: a, targetUserId: ownerId });
    const aboutA = await insertReport({ reporterId: ownerId, targetUserId: a });
    const unrelated = await insertReport({ reporterId: ownerId, targetUserId: b });

    await tdb.delete(users).where(eq(users.id, a));

    const left = await tdb.select({ id: reports.id }).from(reports);
    expect(left.map((r) => r.id)).toEqual([unrelated.id]);
    expect(left.map((r) => r.id)).not.toContain(byA.id);
    expect(left.map((r) => r.id)).not.toContain(aboutA.id);
  });

  test('deleting the reported channel message nulls target_message_id; the report survives', async () => {
    const [target] = await tdb.select().from(messages);
    const [a, b] = await twoNonOwnerUserIds();
    const report = await insertReport({
      kind: 'message',
      reporterId: a,
      targetUserId: b,
      targetMessageId: target!.id,
      serverId: 1,
      audience: 'server',
      contentSnapshot: target!.content
    });

    await tdb.delete(messages).where(eq(messages.id, target!.id));

    const [after] = await tdb.select().from(reports).where(eq(reports.id, report.id));
    expect(after).toBeDefined();
    expect(after!.targetMessageId).toBeNull();
    expect(after!.contentSnapshot).toBe(target!.content);
  });

  test('deleting the reported DM message nulls target_dm_message_id; the report survives', async () => {
    const [a, b] = await twoNonOwnerUserIds();
    const [channel] = await tdb.insert(dmChannels).values({ createdAt: Date.now() }).returning();
    const [dm] = await tdb
      .insert(dmMessages)
      .values({ userId: b, dmChannelId: channel!.id, content: 'dm', createdAt: Date.now() })
      .returning();
    const report = await insertReport({
      kind: 'dm_message',
      reporterId: a,
      targetUserId: b,
      targetDmMessageId: dm!.id,
      contentSnapshot: 'dm'
    });

    await tdb.delete(dmMessages).where(eq(dmMessages.id, dm!.id));

    const [after] = await tdb.select().from(reports).where(eq(reports.id, report.id));
    expect(after).toBeDefined();
    expect(after!.targetDmMessageId).toBeNull();
  });

  test('deleting the context server nulls server_id; deleting the resolver/escalator nulls those', async () => {
    const ownerId = await seededOwnerId();
    const [a, b] = await twoNonOwnerUserIds();
    const [otherServer] = await tdb
      .insert(servers)
      .values({
        name: 'Report Server',
        publicId: crypto.randomUUID(),
        allowNewUsers: true,
        storageUploadEnabled: true,
        storageQuota: 0,
        storageUploadMaxFileSize: 0,
        storageSpaceQuotaByUser: 0,
        storageOverflowAction: 'block',
        enablePlugins: false,
        createdAt: Date.now()
      })
      .returning();
    const report = await insertReport({
      reporterId: ownerId,
      targetUserId: b,
      serverId: otherServer!.id,
      audience: 'server',
      status: 'resolved',
      resolvedBy: a,
      resolvedAt: Date.now(),
      escalatedBy: a,
      escalationReason: 'manual',
      escalatedAt: Date.now()
    });

    await tdb.delete(servers).where(eq(servers.id, otherServer!.id));
    await tdb.delete(users).where(eq(users.id, a));

    const [after] = await tdb.select().from(reports).where(eq(reports.id, report.id));
    expect(after).toBeDefined();
    expect(after!.serverId).toBeNull();
    expect(after!.resolvedBy).toBeNull();
    expect(after!.escalatedBy).toBeNull();
    expect(after!.status).toBe('resolved');
  });

  test('deleting a channel cascades to e2ee_sender_keys', async () => {
    const ownerId = await seededOwnerId();
    const [a] = await twoNonOwnerUserIds();
    const [channel] = await tdb.select().from(channels);
    await tdb.insert(e2eeSenderKeys).values({
      channelId: channel!.id,
      fromUserId: ownerId,
      toUserId: a,
      senderKeyId: 1,
      distributionMessage: 'skdm',
      createdAt: Date.now()
    });

    await tdb.delete(channels).where(eq(channels.id, channel!.id));

    expect(await tdb.select().from(e2eeSenderKeys)).toHaveLength(0);
  });

  test('deleting a user cascades to e2ee_sender_keys as sender AND as recipient', async () => {
    const ownerId = await seededOwnerId();
    const [a, b] = await twoNonOwnerUserIds();
    const [channel] = await tdb.select().from(channels);
    const now = Date.now();
    await tdb.insert(e2eeSenderKeys).values([
      { channelId: channel!.id, fromUserId: a, toUserId: b, senderKeyId: 1, distributionMessage: 'a->b', createdAt: now },
      { channelId: channel!.id, fromUserId: b, toUserId: a, senderKeyId: 1, distributionMessage: 'b->a', createdAt: now },
      { channelId: channel!.id, fromUserId: ownerId, toUserId: b, senderKeyId: 1, distributionMessage: 'o->b', createdAt: now }
    ]);

    await tdb.delete(users).where(eq(users.id, a));

    const left = await tdb.select().from(e2eeSenderKeys);
    expect(left).toHaveLength(1);
    expect(left[0]!.distributionMessage).toBe('o->b');
  });

  test('e2ee_sender_keys refuses a duplicate (channel, from, to, senderKeyId) chain row', async () => {
    const ownerId = await seededOwnerId();
    const [a] = await twoNonOwnerUserIds();
    const [channel] = await tdb.select().from(channels);
    const row = {
      channelId: channel!.id,
      fromUserId: ownerId,
      toUserId: a,
      senderKeyId: 2,
      distributionMessage: 'skdm',
      createdAt: Date.now()
    };
    await tdb.insert(e2eeSenderKeys).values(row);

    expect(await pgErrorCode(tdb.insert(e2eeSenderKeys).values(row).execute())).toBe(
      UNIQUE_VIOLATION
    );
    // A new chain id for the same pair is a distinct row.
    await tdb.insert(e2eeSenderKeys).values({ ...row, senderKeyId: 3 });
    expect(await tdb.select().from(e2eeSenderKeys)).toHaveLength(2);
  });

  test('deleting a DM channel cascades to members, messages and dm_e2ee_sender_keys', async () => {
    const [a, b] = await twoNonOwnerUserIds();
    const now = Date.now();
    const [channel] = await tdb
      .insert(dmChannels)
      .values({ ownerId: a, isGroup: true, e2ee: true, createdAt: now })
      .returning();
    await tdb.insert(dmChannelMembers).values([
      { dmChannelId: channel!.id, userId: a, createdAt: now },
      { dmChannelId: channel!.id, userId: b, createdAt: now }
    ]);
    await tdb.insert(dmMessages).values({
      userId: a,
      dmChannelId: channel!.id,
      content: 'ciphertext',
      e2ee: true,
      createdAt: now
    });
    await tdb.insert(dmE2eeSenderKeys).values({
      dmChannelId: channel!.id,
      fromUserId: a,
      toUserId: b,
      senderKeyId: 1,
      distributionMessage: 'skdm',
      createdAt: now
    });

    await tdb.delete(dmChannels).where(eq(dmChannels.id, channel!.id));

    expect(
      await tdb
        .select()
        .from(dmChannelMembers)
        .where(eq(dmChannelMembers.dmChannelId, channel!.id))
    ).toHaveLength(0);
    expect(
      await tdb.select().from(dmMessages).where(eq(dmMessages.dmChannelId, channel!.id))
    ).toHaveLength(0);
    expect(await tdb.select().from(dmE2eeSenderKeys)).toHaveLength(0);
  });

  test('deleting a user cascades to dm_e2ee_sender_keys in both roles', async () => {
    const ownerId = await seededOwnerId();
    const [a, b] = await twoNonOwnerUserIds();
    const now = Date.now();
    const [channel] = await tdb
      .insert(dmChannels)
      .values({ ownerId, isGroup: true, e2ee: true, createdAt: now })
      .returning();
    await tdb.insert(dmE2eeSenderKeys).values([
      { dmChannelId: channel!.id, fromUserId: a, toUserId: b, senderKeyId: 1, distributionMessage: 'a->b', createdAt: now },
      { dmChannelId: channel!.id, fromUserId: b, toUserId: a, senderKeyId: 1, distributionMessage: 'b->a', createdAt: now },
      { dmChannelId: channel!.id, fromUserId: ownerId, toUserId: b, senderKeyId: 1, distributionMessage: 'o->b', createdAt: now }
    ]);

    await tdb.delete(users).where(eq(users.id, a));

    const left = await tdb.select().from(dmE2eeSenderKeys);
    expect(left).toHaveLength(1);
    expect(left[0]!.distributionMessage).toBe('o->b');
  });

  test('deleting a user cascades to identity key, signed pre-keys, one-time pre-keys and key backup', async () => {
    const [a, b] = await twoNonOwnerUserIds();
    const now = Date.now();
    await tdb.insert(userIdentityKeys).values([
      { userId: a, identityPublicKey: 'ik-a', registrationId: 1, createdAt: now },
      { userId: b, identityPublicKey: 'ik-b', registrationId: 2, createdAt: now }
    ]);
    await tdb.insert(userSignedPreKeys).values([
      { userId: a, keyId: 1, publicKey: 'spk-a', signature: 'sig', createdAt: now },
      { userId: b, keyId: 1, publicKey: 'spk-b', signature: 'sig', createdAt: now }
    ]);
    await tdb.insert(userOneTimePreKeys).values([
      { userId: a, keyId: 1, publicKey: 'otp-a-1', createdAt: now },
      { userId: a, keyId: 2, publicKey: 'otp-a-2', createdAt: now },
      { userId: b, keyId: 1, publicKey: 'otp-b-1', createdAt: now }
    ]);
    await tdb.insert(userKeyBackups).values([
      { userId: a, encryptedData: 'blob-a', createdAt: now, updatedAt: now },
      { userId: b, encryptedData: 'blob-b', createdAt: now, updatedAt: now }
    ]);

    await tdb.delete(users).where(eq(users.id, a));

    expect((await tdb.select().from(userIdentityKeys)).map((r) => r.userId)).toEqual([b]);
    expect((await tdb.select().from(userSignedPreKeys)).map((r) => r.userId)).toEqual([b]);
    expect((await tdb.select().from(userOneTimePreKeys)).map((r) => r.userId)).toEqual([b]);
    expect((await tdb.select().from(userKeyBackups)).map((r) => r.userId)).toEqual([b]);
  });

  test('pre-key tables refuse a duplicate (user, keyId)', async () => {
    const [a] = await twoNonOwnerUserIds();
    const now = Date.now();
    await tdb.insert(userSignedPreKeys).values({ userId: a, keyId: 7, publicKey: 'spk', signature: 's', createdAt: now });
    await tdb.insert(userOneTimePreKeys).values({ userId: a, keyId: 7, publicKey: 'otp', createdAt: now });

    expect(
      await pgErrorCode(
        tdb
          .insert(userSignedPreKeys)
          .values({ userId: a, keyId: 7, publicKey: 'spk2', signature: 's', createdAt: now })
          .execute()
      )
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await pgErrorCode(
        tdb
          .insert(userOneTimePreKeys)
          .values({ userId: a, keyId: 7, publicKey: 'otp2', createdAt: now })
          .execute()
      )
    ).toBe(UNIQUE_VIOLATION);
  });

  test('settings is keyed by server_id', async () => {
    const [existing] = await tdb.select().from(settings);

    expect(
      await pgErrorCode(
        tdb
          .insert(settings)
          .values({ ...existing!, name: 'duplicate' })
          .execute()
      )
    ).toBe(UNIQUE_VIOLATION);

    const rows = await tdb.select().from(settings);
    expect(rows.length).toBe(1);
  });
});
