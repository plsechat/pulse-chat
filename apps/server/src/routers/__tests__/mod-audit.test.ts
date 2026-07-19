import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { ActivityLogType } from '@pulse/shared';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { invites, serverMembers } from '../../db/schema';

/**
 * Mod-view audit log + invite attribution (Join Method). Seeded user 1 is
 * the operator of server 1; user 2 is a plain member.
 */
describe('mod audit log', () => {
  test('mod actions land in getInfo auditLog, server-scoped', async () => {
    // Users materialize on first login — user 2 must exist before the
    // admin route can resolve + log them.
    await initTest(2);
    const { caller } = await initTest(1);

    await caller.users.setUserNickname({ userId: 2, nickname: 'AuditNick' });

    // The activity log writes through an async queue — poll the read
    // path instead of sleeping a fixed amount.
    let entry: { type: string; serverId: number | null } | undefined;
    for (let i = 0; i < 20 && !entry; i++) {
      const info = await caller.users.getInfo({ userId: 2 });
      entry = info.auditLog.find(
        (e) => e.type === ActivityLogType.USER_NICKNAME_SET
      );
      if (!entry) await new Promise((r) => setTimeout(r, 50));
    }

    expect(entry).toBeDefined();
    expect(entry!.serverId).toBe(1);
    const details = entry as unknown as {
      details: { nickname: string; setBy: number };
    };
    expect(details.details).toMatchObject({ nickname: 'AuditNick', setBy: 1 });
  });

  test('joining via invite records the invite on the membership', async () => {
    const { caller: owner } = await initTest(1);
    const server2 = await owner.servers.create({ name: 'Audit Server' });
    const invite = await owner.invites.add({
      serverId: server2.id,
      code: 'audit-invite-code'
    });

    const { caller: joiner } = await initTest(2);
    await joiner.servers.join({ inviteCode: 'audit-invite-code' });

    const tdb = getTestDb();
    const [member] = await tdb
      .select({ inviteId: serverMembers.inviteId })
      .from(serverMembers)
      .where(
        and(
          eq(serverMembers.serverId, server2.id),
          eq(serverMembers.userId, 2)
        )
      )
      .limit(1);

    expect(member?.inviteId).toBe(invite.id);
  });

  test('getInfo joinMethod resolves invite code and inviter', async () => {
    const { caller } = await initTest(1);

    // Attribute user 2's membership of server 1 to an invite created by
    // user 1 (written directly — the seeded membership predates invites).
    const tdb = getTestDb();
    const [invite] = await tdb
      .insert(invites)
      .values({
        code: 'joinmethod-code',
        creatorId: 1,
        serverId: 1,
        uses: 1,
        createdAt: Date.now()
      })
      .returning({ id: invites.id });
    await tdb
      .update(serverMembers)
      .set({ inviteId: invite!.id })
      .where(
        and(eq(serverMembers.serverId, 1), eq(serverMembers.userId, 2))
      );

    const info = await caller.users.getInfo({ userId: 2 });
    expect(info.joinMethod).toMatchObject({
      inviteCode: 'joinmethod-code',
      inviterId: 1
    });
    expect(info.joinMethod?.inviterName).toBeTruthy();
  });
});
