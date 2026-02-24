import { randomUUIDv7 } from 'bun';
import { publicProcedure } from '../../utils/trpc';

const handshakeRoute = publicProcedure.query(async ({ ctx }) => {
  const handshakeHash = randomUUIDv7();
  ctx.handshakeHash = handshakeHash;
  return { handshakeHash };
});

export { handshakeRoute };
