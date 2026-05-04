import { protectedProcedure } from '../../utils/trpc';

/**
 * Returns the calling user's id within this instance. Used by the
 * client during multi-store federation flows (e.g. Phase B
 * `redistributeOwnSenderKeys`) to learn "who am I on this instance"
 * without re-fetching the heavy `others.joinServer` payload.
 */
const getMyIdRoute = protectedProcedure.query(({ ctx }) => {
  return { userId: ctx.userId };
});

export { getMyIdRoute };
