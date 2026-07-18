import { isInstanceOwner } from '../../db/queries/servers';
import { invariant } from '../../utils/invariant';

/**
 * Instance-level federation — enabling/disabling federation, setting the
 * instance domain, and adding/accepting/blocking/removing peer instances —
 * is the instance owner's alone (the operator who owns the first server).
 * Previously these gated on MANAGE_SETTINGS of the first server, which any
 * admin, or any user who created their own server (its owner, with every
 * permission), satisfied — letting them federate the whole instance.
 */
export const assertInstanceOwner = async (userId: number): Promise<void> => {
  invariant(await isInstanceOwner(userId), {
    code: 'FORBIDDEN',
    message: 'Only the instance owner can manage federation'
  });
};
