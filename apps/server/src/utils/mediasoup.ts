import mediasoup from 'mediasoup';
import { config } from '../config.js';
import { MEDIASOUP_BINARY_PATH } from '../helpers/paths.js';
import { logger } from '../logger.js';

let mediaSoupWorker: mediasoup.types.Worker<mediasoup.types.AppData>;

const loadMediasoup = async () => {
  const workerConfig: mediasoup.types.WorkerSettings = {
    rtcMinPort: +config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: +config.mediasoup.worker.rtcMaxPort,
    logLevel: 'debug',
    disableLiburing: true,
    workerBin: MEDIASOUP_BINARY_PATH
  };

  logger.debug(
    `Loading mediasoup worker with config ${JSON.stringify(workerConfig, null, 2)}`
  );

  mediaSoupWorker = await mediasoup.createWorker(workerConfig);

  mediaSoupWorker.on('died', (error) => {
    logger.error('Mediasoup worker died', error);

    setTimeout(() => process.exit(0), 2000);
  });

  logger.debug(
    `Mediasoup worker loaded (port range: ${workerConfig.rtcMinPort}-${workerConfig.rtcMaxPort})`
  );
};

/**
 * Shutdown: close the worker subprocess so it does not outlive us and
 * get reaped by the OS. `close()` is deliberate, so the 'died' handler
 * above (which schedules a process exit) must not treat it as a crash.
 */
const closeMediasoup = () => {
  if (!mediaSoupWorker || mediaSoupWorker.closed) return;

  mediaSoupWorker.removeAllListeners('died');
  mediaSoupWorker.close();
};

export { closeMediasoup, loadMediasoup, mediaSoupWorker };
