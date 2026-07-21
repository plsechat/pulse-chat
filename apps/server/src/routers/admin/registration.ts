import { z } from 'zod';
import { db } from '../../db';
import { settings } from '../../db/schema';
import {
  isRegistrationDisabled,
  isRegistrationMethodEnabled
} from '../../utils/env';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * Instance registration controls. `allowNewUsers` lives on the
 * single-row instance settings table and gates /register (a valid
 * invite remains the break-glass path). The per-method switches and
 * the global REGISTRATION_DISABLED kill-switch are environment
 * configuration — surfaced read-only so the operator can see the
 * effective policy in one place.
 */
const getRegistrationRoute = instanceOwnerProcedure.query(async () => {
  const [row] = await db
    .select({ allowNewUsers: settings.allowNewUsers })
    .from(settings)
    .limit(1);

  return {
    allowNewUsers: row?.allowNewUsers ?? false,
    // Environment-level policy, read-only from here.
    registrationDisabledByEnv: isRegistrationDisabled(),
    methods: {
      password: isRegistrationMethodEnabled('password'),
      oidc: isRegistrationMethodEnabled('oidc'),
      social: isRegistrationMethodEnabled('social')
    }
  };
});

const setRegistrationRoute = instanceOwnerProcedure
  .input(
    z.object({
      allowNewUsers: z.boolean()
    })
  )
  .mutation(async ({ input }) => {
    await db.update(settings).set({ allowNewUsers: input.allowNewUsers });
  });

export { getRegistrationRoute, setRegistrationRoute };
