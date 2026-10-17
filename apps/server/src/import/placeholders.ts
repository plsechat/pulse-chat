import { randomUUIDv7 } from 'bun';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { removeFile } from '../db/mutations/files';
import { publishUser } from '../db/publishers';
import { findExternalIdentity } from '../db/queries/import-jobs';
import { addServerMember } from '../db/queries/servers';
import {
  events,
  eventSignups,
  externalIdentities,
  messages,
  serverMembers,
  userRoles,
  users
} from '../db/schema';
import { logger } from '../logger';
import { boundText, BOUNDS } from './mapping';

/**
 * Placeholder authors. An imported member is a users row that cannot
 * sign in (its auth-side id carries a prefix no auth backend ever
 * issues) plus an external_identities row that remembers who they are
 * on the source service. When the real person later signs in through
 * the matching OAuth provider, `claimExternalIdentity` moves everything
 * the placeholder authored onto their account and deletes the
 * placeholder — once, inside one transaction.
 *
 * Tables the claim touches, in order:
 *   messages.user_id / pinned_by / forwarded_from_user_id → real user
 *   events.host_id → real user (an imported event hosted by them)
 *   event_signups.user_id → real user (a signup the real user already
 *     has for the same event wins; the placeholder's is dropped)
 *   server_members → real user (a membership the real user already
 *     holds wins; the placeholder's is dropped)
 *   user_roles → copied onto the real user, conflicts ignored
 *   external_identities.user_id → real user, placeholder = false
 *   users (placeholder row) → deleted; its avatar file removed from disk
 */

const PLACEHOLDER_AUTH_PREFIX = 'placeholder:';

type TProviderIdentity = { provider: string; externalId: string };

const placeholderAuthId = (identity: TProviderIdentity): string =>
  `${PLACEHOLDER_AUTH_PREFIX}${identity.provider}:${identity.externalId}`;

const isPlaceholderAuthId = (supabaseId: string): boolean =>
  supabaseId.startsWith(PLACEHOLDER_AUTH_PREFIX);

type TEnsurePlaceholderInput = TProviderIdentity & {
  displayName: string;
  avatarUrl: string | null;
};

/**
 * The user id content from this external identity is attributed to: a
 * real account that already claimed it, an existing placeholder, or a
 * new placeholder minted here. `created` tells the caller to fan the
 * new member out.
 */
const ensurePlaceholderUser = async (
  input: TEnsurePlaceholderInput
): Promise<{ userId: number; placeholder: boolean; created: boolean }> => {
  const existing = await findExternalIdentity(input.provider, input.externalId);
  if (existing) {
    return { userId: existing.userId, placeholder: existing.placeholder, created: false };
  }

  const now = Date.now();
  const name = boundText(input.displayName, BOUNDS.userName, 'Imported member');

  const created = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        supabaseId: placeholderAuthId(input),
        name,
        publicId: randomUUIDv7(),
        createdAt: now,
        lastLoginAt: now
      })
      .onConflictDoNothing()
      .returning({ id: users.id });

    if (!user) return undefined;

    const [identity] = await tx
      .insert(externalIdentities)
      .values({
        provider: input.provider,
        externalId: input.externalId,
        userId: user.id,
        displayName: name,
        avatarUrl: input.avatarUrl,
        placeholder: true,
        createdAt: now
      })
      .onConflictDoNothing()
      .returning({ id: externalIdentities.id });

    if (!identity) {
      // A concurrent caller won the identity index; drop our user row.
      await tx.delete(users).where(eq(users.id, user.id));
      return undefined;
    }

    return user.id;
  });

  if (created !== undefined) {
    return { userId: created, placeholder: true, created: true };
  }

  const raced = await findExternalIdentity(input.provider, input.externalId);
  if (!raced) {
    throw new Error(`Placeholder for ${input.provider}:${input.externalId} conflicted but no row exists`);
  }

  return { userId: raced.userId, placeholder: raced.placeholder, created: false };
};

/** Membership + roles for a placeholder in the imported server. */
const addPlaceholderToServer = async (
  serverId: number,
  userId: number,
  roleIds: number[]
): Promise<void> => {
  await addServerMember(serverId, userId);

  if (roleIds.length > 0) {
    const now = Date.now();
    await db
      .insert(userRoles)
      .values(roleIds.map((roleId) => ({ userId, roleId, createdAt: now })))
      .onConflictDoNothing();
  }
};

/**
 * The claim. Returns the servers whose rosters changed (for the
 * caller's fan-out) or null when there was nothing to claim — no
 * identity row, or one that already points at a real account. A real
 * account signing in for the first time with an identity nobody
 * imported gets a non-placeholder row, so a LATER import attributes
 * its messages to them directly.
 */
const claimExternalIdentity = async (
  identity: TProviderIdentity,
  realUserId: number
): Promise<{ placeholderUserId: number; serverIds: number[] } | null> => {
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(externalIdentities)
      .where(
        and(
          eq(externalIdentities.provider, identity.provider),
          eq(externalIdentities.externalId, identity.externalId)
        )
      )
      .for('update')
      .limit(1);

    const now = Date.now();

    if (!row) {
      await tx
        .insert(externalIdentities)
        .values({
          provider: identity.provider,
          externalId: identity.externalId,
          userId: realUserId,
          placeholder: false,
          createdAt: now
        })
        .onConflictDoNothing();
      return null;
    }

    if (!row.placeholder || row.userId === realUserId) return null;

    const placeholderId = row.userId;

    const [placeholder] = await tx
      .select({ id: users.id, avatarId: users.avatarId, supabaseId: users.supabaseId })
      .from(users)
      .where(eq(users.id, placeholderId))
      .limit(1);

    // The identity row says placeholder but the user row is not one:
    // never move a real account's content. Re-point the identity only.
    if (!placeholder || !isPlaceholderAuthId(placeholder.supabaseId)) {
      await tx
        .update(externalIdentities)
        .set({ userId: realUserId, placeholder: false })
        .where(eq(externalIdentities.id, row.id));
      return null;
    }

    await tx
      .update(messages)
      .set({ userId: realUserId })
      .where(eq(messages.userId, placeholderId));
    await tx
      .update(messages)
      .set({ pinnedBy: realUserId })
      .where(eq(messages.pinnedBy, placeholderId));
    await tx
      .update(messages)
      .set({ forwardedFromUserId: realUserId })
      .where(eq(messages.forwardedFromUserId, placeholderId));

    await tx
      .update(events)
      .set({ hostId: realUserId })
      .where(eq(events.hostId, placeholderId));

    await tx.delete(eventSignups).where(
      and(
        eq(eventSignups.userId, placeholderId),
        inArray(
          eventSignups.eventId,
          tx
            .select({ eventId: eventSignups.eventId })
            .from(eventSignups)
            .where(eq(eventSignups.userId, realUserId))
        )
      )
    );
    await tx
      .update(eventSignups)
      .set({ userId: realUserId })
      .where(eq(eventSignups.userId, placeholderId));

    const memberships = await tx
      .select({ serverId: serverMembers.serverId })
      .from(serverMembers)
      .where(eq(serverMembers.userId, placeholderId));
    const serverIds = memberships.map((m) => m.serverId);

    if (serverIds.length > 0) {
      await tx.delete(serverMembers).where(
        and(
          eq(serverMembers.userId, placeholderId),
          inArray(
            serverMembers.serverId,
            tx
              .select({ serverId: serverMembers.serverId })
              .from(serverMembers)
              .where(eq(serverMembers.userId, realUserId))
          )
        )
      );
      await tx
        .update(serverMembers)
        .set({ userId: realUserId })
        .where(eq(serverMembers.userId, placeholderId));
    }

    await tx.execute(sql`
      INSERT INTO user_roles (user_id, role_id, created_at)
      SELECT ${realUserId}, role_id, ${now} FROM user_roles WHERE user_id = ${placeholderId}
      ON CONFLICT DO NOTHING
    `);

    await tx
      .update(externalIdentities)
      .set({ userId: realUserId, placeholder: false })
      .where(eq(externalIdentities.id, row.id));

    await tx.delete(users).where(eq(users.id, placeholderId));

    return { placeholderUserId: placeholderId, serverIds, avatarId: placeholder.avatarId };
  });

  if (!result) return null;

  // The users cascade dropped the files row; the bytes on disk are
  // ours to remove. Best effort — a stray file is not worth failing a
  // sign-in over.
  if (result.avatarId) {
    await removeFile(result.avatarId).catch(() => undefined);
  }

  for (const serverId of result.serverIds) {
    void publishUser(result.placeholderUserId, 'delete', { scopeServerId: serverId });
    void publishUser(realUserId, 'update', { scopeServerId: serverId });
  }

  logger.info(
    '[import] identity %s:%s claimed by user %d (placeholder %d, %d server(s))',
    identity.provider,
    identity.externalId,
    realUserId,
    result.placeholderUserId,
    result.serverIds.length
  );

  return { placeholderUserId: result.placeholderUserId, serverIds: result.serverIds };
};

/**
 * The provider identity carried by an OAuth sign-in, or null. The
 * Supabase-mediated providers put the provider's issuer and the
 * user's id on the token's user metadata; only the one provider the
 * import knows (discord) is recognised, by issuer host, never by a
 * free-text claim.
 */
const providerIdentityFromAuth = (identity: {
  metadata?: Record<string, unknown>;
}): TProviderIdentity | null => {
  const meta = identity.metadata;
  if (!meta) return null;

  const iss = typeof meta.iss === 'string' ? meta.iss : '';
  const externalId =
    typeof meta.provider_id === 'string'
      ? meta.provider_id
      : typeof meta.sub === 'string'
        ? meta.sub
        : '';

  if (!/^\d{5,32}$/.test(externalId)) return null;

  let host = '';
  try {
    host = new URL(iss).hostname;
  } catch {
    return null;
  }

  if (host === 'discord.com' || host.endsWith('.discord.com')) {
    return { provider: 'discord', externalId };
  }

  return null;
};

export type { TProviderIdentity };
export {
  addPlaceholderToServer,
  claimExternalIdentity,
  ensurePlaceholderUser,
  isPlaceholderAuthId,
  PLACEHOLDER_AUTH_PREFIX,
  providerIdentityFromAuth
};
