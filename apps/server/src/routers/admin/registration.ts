import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { settings } from '../../db/schema';
import {
  isDirectoryExposed,
  setDirectoryExposed
} from '../../utils/directory-config';
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
 * effective policy in one place. The directory exposure switch sits
 * here too: whether federated peers may read this instance's public
 * directory is the other "who gets in" policy the owner sets.
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
    },
    directory: {
      // The stored switch, and whether it has any effect right now.
      exposed: config.federation.exposeDirectory,
      federationEnabled: config.federation.enabled,
      effective: isDirectoryExposed()
    }
  };
});

const setRegistrationRoute = instanceOwnerProcedure
  .input(
    z.object({
      allowNewUsers: z.boolean().optional(),
      exposeDirectory: z.boolean().optional()
    })
  )
  .mutation(async ({ input }) => {
    if (input.allowNewUsers !== undefined) {
      await db.update(settings).set({ allowNewUsers: input.allowNewUsers });
    }
    if (input.exposeDirectory !== undefined) {
      await setDirectoryExposed(input.exposeDirectory);
    }
  });

export { getRegistrationRoute, setRegistrationRoute };
