import { generateFederationKeys, getLocalKeys } from '../../utils/federation';
import { instanceOwnerProcedure } from '../../utils/procedures';

// Instance-owner gated like every other instance-federation surface.
// Previously MANAGE_SETTINGS on the first server — a strictly weaker
// gate any first-server admin satisfied.
const generateKeysRoute = instanceOwnerProcedure.mutation(async ({ ctx }) => {
  const existing = await getLocalKeys();
  if (existing) {
    ctx.throwValidationError('keys', 'Federation keys already exist');
  }

  const keys = await generateFederationKeys();

  return { publicKey: keys.publicKey };
});

export { generateKeysRoute };
