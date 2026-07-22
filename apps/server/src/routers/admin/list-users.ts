import { count, desc, ilike } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { users } from '../../db/schema';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * Instance user directory: every account on the instance — including
 * banned users, federated shadows, and deleted tombstones — so the
 * operator can see exactly what exists, not just live memberships.
 */
const listUsersRoute = instanceOwnerProcedure
  .input(
    z.object({
      search: z.string().max(64).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50)
    })
  )
  .query(async ({ input }) => {
    const where = input.search
      ? ilike(users.name, `%${input.search}%`)
      : undefined;

    const rows = await db
      .select({
        id: users.id,
        publicId: users.publicId,
        name: users.name,
        banned: users.banned,
        banReason: users.banReason,
        bannedAt: users.bannedAt,
        deletedAt: users.deletedAt,
        isFederated: users.isFederated,
        createdAt: users.createdAt
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(input.limit)
      .offset(input.offset);

    const [total] = await db
      .select({ value: count() })
      .from(users)
      .where(where);

    return { users: rows, total: total?.value ?? 0 };
  });

export { listUsersRoute };
