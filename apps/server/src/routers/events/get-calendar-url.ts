import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { servers, users } from '../../db/schema';
import { buildCalendarPath } from '../../http/events-ics';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

/**
 * The caller's personal subscription URL for the active server's
 * calendar feed. The token is bound to this user and this server, so a
 * shared link only ever exposes a calendar the sharer could read.
 */
const getCalendarUrlRoute = serverProcedure().query(async ({ ctx }) => {
  const [[server], [user]] = await Promise.all([
    db
      .select({ publicId: servers.publicId })
      .from(servers)
      .where(eq(servers.id, ctx.activeServerId))
      .limit(1),
    db
      .select({ publicId: users.publicId })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1)
  ]);

  invariant(server && user, { code: 'NOT_FOUND', message: 'Server not found' });

  const path = buildCalendarPath(server.publicId, user.publicId);
  // Absolute when the operator declared PUBLIC_URL (the same source the
  // HTTP layer uses for its own origin); otherwise the client prefixes
  // its origin, which is the API origin.
  const base = process.env.PUBLIC_URL?.trim();
  let url = path;

  if (base) {
    try {
      url = new URL(path, base).toString();
    } catch {
      url = path;
    }
  }

  return { path, url };
});

export { getCalendarUrlRoute };
