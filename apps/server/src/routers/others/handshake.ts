import { randomUUIDv7 } from 'bun';
import { getFirstServerPassword } from '../../db/queries/server';
import { publicProcedure } from '../../utils/trpc';

const handshakeRoute = publicProcedure.query(async ({ ctx }) => {
  const serverPassword = await getFirstServerPassword();
  const hasPassword = !!serverPassword;
  const handshakeHash = randomUUIDv7();

  ctx.handshakeHash = handshakeHash;

  return { handshakeHash, hasPassword };
});

export { handshakeRoute };
