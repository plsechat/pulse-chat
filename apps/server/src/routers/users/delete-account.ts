import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { servers, users } from '../../db/schema';
import { executeAccountDeletion } from '../../utils/account-deletion';
import { authBackend } from '../../utils/auth';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

/**
 * Self-service account deletion: name + password confirmation on top of
 * the shared anonymize-tombstone core (utils/account-deletion.ts, also
 * used by admin.deleteUser).
 */
const deleteAccountRoute = protectedProcedure
  .input(
    z.object({
      /** Must match the account's display name exactly. */
      confirmName: z.string().min(1).max(64),
      /** Required for password accounts; OIDC-only accounts omit it. */
      password: z.string().max(128).optional()
    })
  )
  .mutation(async ({ ctx, input }) => {
    const [user] = await db
      .select({
        name: users.name,
        supabaseId: users.supabaseId,
        deletedAt: users.deletedAt
      })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);

    invariant(user && !user.deletedAt, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    invariant(input.confirmName === user.name, {
      code: 'BAD_REQUEST',
      message: 'The name you typed does not match your account name.'
    });

    // Owned servers block deletion regardless of credentials — surface
    // that BEFORE demanding a password (the core re-checks atomically).
    const owned = await db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.ownerId, ctx.userId));

    invariant(owned.length === 0, {
      code: 'FORBIDDEN',
      message: `You still own ${owned.length === 1 ? 'a server' : 'servers'} (${owned
        .map((s) => s.name)
        .join(
          ', '
        )}). Transfer ownership or delete ${owned.length === 1 ? 'it' : 'them'} first.`
    });

    // Password challenge, mirroring update-password: password accounts
    // must re-prove possession; OIDC-only accounts confirm by name
    // alone (they have no password here to check).
    const { data: authUserData } = await authBackend.getUserById(
      user.supabaseId
    );
    const providers = (authUserData.user?.identities ?? [])
      .map((i) => i.provider)
      .filter((p): p is string => typeof p === 'string');

    if (authUserData.user?.email && providers.includes('email')) {
      invariant(input.password, {
        code: 'BAD_REQUEST',
        message: 'Password is required to delete this account.'
      });

      const { error: signInError } = await authBackend.signInWithPassword({
        email: authUserData.user.email,
        password: input.password
      });

      invariant(!signInError, {
        code: 'UNAUTHORIZED',
        message: 'Password is incorrect.'
      });
    }

    await executeAccountDeletion(ctx.userId, ctx.getUserWs);
  });

export { deleteAccountRoute };
