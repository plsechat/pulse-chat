import { createHttpServer } from '../http';
import { createWsServer } from './wss';

/** Returns the listening HTTP server so shutdown can stop it accepting. */
const createServers = async () => {
  const httpServer = await createHttpServer();

  await createWsServer(httpServer);

  return httpServer;
};

export { createServers };
