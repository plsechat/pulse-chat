/**
 * Per-connection permission caches, reachable by user id.
 *
 * Every WebSocket context (utils/wss.ts createContext) keeps a lazy cache
 * of the user row, the servers it checked and the role / channel
 * permission sets. A route that changes ANOTHER user's standing — an
 * ownership transfer makes the new owner bypass every check — must be
 * able to drop that user's caches on every connection they hold, not
 * just the caller's. Contexts register their invalidator here under
 * (userId, connection token) and the socket close handler removes it.
 *
 * Lives in its own module because wss.ts imports the app router: a route
 * importing wss.ts back would be a cycle.
 */
const invalidatorsByUserId = new Map<number, Map<string, () => void>>();

const registerPermissionCacheInvalidator = (
  userId: number,
  token: string,
  invalidate: () => void
) => {
  let byToken = invalidatorsByUserId.get(userId);
  if (!byToken) {
    byToken = new Map();
    invalidatorsByUserId.set(userId, byToken);
  }
  byToken.set(token, invalidate);
};

const unregisterPermissionCacheInvalidator = (userId: number, token: string) => {
  const byToken = invalidatorsByUserId.get(userId);
  if (!byToken) return;
  byToken.delete(token);
  if (byToken.size === 0) invalidatorsByUserId.delete(userId);
};

/** Drop the cached permissions on every live connection of `userId`. */
const invalidatePermissionCacheForUser = (userId: number) => {
  const byToken = invalidatorsByUserId.get(userId);
  if (!byToken) return;
  for (const invalidate of byToken.values()) invalidate();
};

/**
 * Drop the cached permissions on EVERY live connection. Role and channel
 * override edits change what other members may do; their connections must
 * not keep serving the old answer until they reconnect. Caches are lazy,
 * so the cost is one re-read per connection on its next check.
 */
const invalidateAllPermissionCaches = () => {
  for (const byToken of invalidatorsByUserId.values()) {
    for (const invalidate of byToken.values()) invalidate();
  }
};

export {
  invalidateAllPermissionCaches,
  invalidatePermissionCacheForUser,
  registerPermissionCacheInvalidator,
  unregisterPermissionCacheInvalidator
};
