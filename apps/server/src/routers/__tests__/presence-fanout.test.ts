import { UserStatus } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { describe, expect, test } from 'bun:test';
import { db } from '../../db';
import { getPresenceInterestedIds } from '../../db/queries/servers';
import {
  dmChannelMembers,
  dmChannels,
  friendships,
  serverMembers,
  users
} from '../../db/schema';
import { initTest } from '../../__tests__/helpers';

// A user with NO server membership — isolates the DM/friend legs of the
// presence union from the co-member leg.
const insertBareUser = async () => {
  const suffix = randomUUIDv7();
  const [user] = await db
    .insert(users)
    .values({
      supabaseId: `presence-supa-${suffix}`,
      name: `PresenceUser-${suffix.slice(0, 8)}`,
      publicId: `presence-pid-${suffix}`,
      createdAt: Date.now()
    })
    .returning();
  return user!;
};

const insertFriendship = async (userId: number, friendId: number) => {
  await db.insert(friendships).values({
    userId,
    friendId,
    createdAt: Date.now()
  });
};

const insertDmChannelBetween = async (userId1: number, userId2: number) => {
  const now = Date.now();
  const [channel] = await db
    .insert(dmChannels)
    .values({ createdAt: now })
    .returning();
  await db.insert(dmChannelMembers).values([
    { dmChannelId: channel!.id, userId: userId1, createdAt: now },
    { dmChannelId: channel!.id, userId: userId2, createdAt: now }
  ]);
  return channel!;
};

describe('getPresenceInterestedIds', () => {
  test('unions server co-members, DM partners, and friends without self', async () => {
    await initTest();

    // Friend and DM partner share NO server with user 1 — before the
    // fan-out fix they never received presence events at all.
    const friend = await insertBareUser();
    const dmPartner = await insertBareUser();
    const coMember = await insertBareUser();

    await insertFriendship(1, friend.id);
    await insertDmChannelBetween(1, dmPartner.id);
    await db.insert(serverMembers).values({
      userId: coMember.id,
      serverId: 1,
      nickname: null,
      joinedAt: Date.now()
    });

    const ids = await getPresenceInterestedIds(1);

    expect(ids).toContain(friend.id);
    expect(ids).toContain(dmPartner.id);
    expect(ids).toContain(coMember.id);
    expect(ids).not.toContain(1);
  });

  test('deduplicates a user who is both friend and co-member', async () => {
    await initTest();

    const both = await insertBareUser();
    await insertFriendship(both.id, 1); // reversed direction on purpose
    await db.insert(serverMembers).values({
      userId: both.id,
      serverId: 1,
      nickname: null,
      joinedAt: Date.now()
    });

    const ids = await getPresenceInterestedIds(1);

    expect(ids.filter((id) => id === both.id)).toHaveLength(1);
  });
});

describe('presence riders on DM/friend projections', () => {
  test('dms.getChannels attaches a status to every member', async () => {
    const { caller } = await initTest();
    const partner = await insertBareUser();
    const channel = await insertDmChannelBetween(1, partner.id);

    const channels = await caller.dms.getChannels();
    const dm = channels.find((c) => c.id === channel.id);

    expect(dm).toBeDefined();
    for (const member of dm!.members) {
      // No live WS connections exist in tests, so the rider resolves to
      // OFFLINE — the point is the field is PRESENT (undefined was the
      // bug: the client collapses a missing status to offline forever).
      expect(member.status).toBe(UserStatus.OFFLINE);
    }
  });

  test('friends.getAll attaches a status to every friend', async () => {
    const { caller } = await initTest();
    const friend = await insertBareUser();
    await insertFriendship(1, friend.id);

    const friends = await caller.friends.getAll();
    const entry = friends.find((f) => f.id === friend.id);

    expect(entry).toBeDefined();
    expect(entry!.status).toBe(UserStatus.OFFLINE);
  });
});
