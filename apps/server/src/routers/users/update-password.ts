import { ActivityLogType } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { users } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { supabaseAdmin } from '../../utils/supabase';
import { protectedProcedure } from '../../utils/trpc';

const updatePasswordRoute = protectedProcedure
  .input(
    z.object({
      currentPassword: z.string().min(4).max(128),
      newPassword: z.string().min(4).max(128),
      confirmNewPassword: z.string().min(4).max(128)
    })
  )
  .mutation(async ({ ctx, input }) => {
    const [user] = await db
      .select({
        supabaseId: users.supabaseId
      })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);

    invariant(user, {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

    // Verify current password via Supabase Auth
    const { data: supabaseUser } = await supabaseAdmin.auth.admin.getUserById(
      user.supabaseId
    );

    invariant(supabaseUser?.user?.email, {
      code: 'NOT_FOUND',
      message: 'User not found in auth system'
    });

    // Reject OAuth-only accounts (Google, GitHub, etc) before touching
    // signInWithPassword. Without this gate, a federated user hitting
    // the endpoint directly would get a misleading "current password
    // incorrect" error from Supabase rather than the truthful "your
    // account doesn't have a password to change."
    const providers = (supabaseUser.user.identities ?? [])
      .map((i) => i.provider)
      .filter((p): p is string => typeof p === 'string');
    if (!providers.includes('email')) {
      const linked = providers.length ? providers.join(', ') : 'an external provider';
      ctx.throwValidationError(
        'currentPassword',
        `Your account signs in through ${linked} — change your password there instead.`
      );
    }

    const { error: signInError } =
      await supabaseAdmin.auth.signInWithPassword({
        email: supabaseUser.user.email,
        password: input.currentPassword
      });

    if (signInError) {
      ctx.throwValidationError(
        'currentPassword',
        'Current password is incorrect'
      );
    }

    if (input.newPassword !== input.confirmNewPassword) {
      ctx.throwValidationError(
        'confirmNewPassword',
        'New password and confirmation do not match'
      );
    }

    // Update password via Supabase Auth
    const { error: updateError } =
      await supabaseAdmin.auth.admin.updateUserById(user.supabaseId, {
        password: input.newPassword
      });

    if (updateError) {
      ctx.throwValidationError(
        'newPassword',
        'Failed to update password'
      );
    }

    enqueueActivityLog({
      type: ActivityLogType.USER_UPDATED_PASSWORD,
      userId: ctx.user.id
    });
  });

export { updatePasswordRoute };
