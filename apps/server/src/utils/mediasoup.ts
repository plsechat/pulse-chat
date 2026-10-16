import mediasoup from 'mediasoup';
import type { TransportListenInfo, WebRtcServer } from 'mediasoup/types';
import { config, SERVER_PUBLIC_IP } from '../config.js';
import { MEDIASOUP_BINARY_PATH } from '../helpers/paths.js';
import { logger } from '../logger.js';
import { IS_DOCKER, IS_PRODUCTION } from './env.js';

let mediaSoupWorker: mediasoup.types.Worker<mediasoup.types.AppData>;
// Single-port mode only: every WebRtcTransport multiplexes over this one
// UDP + TCP socket pair instead of binding its own ports.
let webRtcServer: WebRtcServer | undefined;

/**
 * The ip / announcedAddress every media socket binds and advertises.
 * Production listens on all interfaces and announces the public IP
 * (ICE-lite: the client connects to exactly this address); development
 * stays on loopback with nothing announced. A container is treated like
 * production whatever the build: its loopback is unreachable from any
 * browser, so a development image in Docker (the e2e stack) must bind
 * every interface and announce the address the host publishes.
 */
const getMediaListenInfo = (): { ip: string; announcedAddress?: string } => {
  const exposed = IS_PRODUCTION || IS_DOCKER;
  const ip = exposed ? '0.0.0.0' : '127.0.0.1';
  const announcedAddress = exposed ? SERVER_PUBLIC_IP : undefined;

  return announcedAddress ? { ip, announcedAddress } : { ip };
};

const describeParticipantCap = () =>
  config.mediasoup.maxParticipants > 0
    ? `participant cap ${config.mediasoup.maxParticipants}`
    : 'no participant cap';

const loadMediasoup = async () => {
  // Idempotent: the test preload and a restart-after-close both call
  // this; a second worker would fight the first for the media port.
  if (mediaSoupWorker && !mediaSoupWorker.closed) return;

  const { worker } = config.mediasoup;

  const workerConfig: mediasoup.types.WorkerSettings = {
    // Range mode draws transport ports from here; in single-port mode
    // only plugin PlainTransports (no WebRtcServer) still use the range.
    rtcMinPort: worker.rtcMinPort,
    rtcMaxPort: worker.rtcMaxPort,
    // The worker's debug level logs every RTP/RTCP event on the Bun
    // thread — far too chatty for a production SFU.
    logLevel: config.server.debug ? 'debug' : 'warn',
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

  const listen = getMediaListenInfo();
  const announced = listen.announcedAddress
    ? ` (announcing ${listen.announcedAddress})`
    : '';

  if (worker.mode === 'single-port') {
    const listenInfos: TransportListenInfo[] = [
      { protocol: 'udp', ...listen, port: worker.port },
      { protocol: 'tcp', ...listen, port: worker.port }
    ];

    try {
      webRtcServer = await mediaSoupWorker.createWebRtcServer({ listenInfos });
    } catch (err) {
      // Surface the actionable cause instead of a bare bind error: the
      // server is dead for voice without this socket pair.
      throw new Error(
        `Cannot bind the voice media port ${worker.port} (UDP and TCP). Free the port, set MEDIASOUP_PORT, or set MEDIASOUP_MODE=range.`,
        { cause: err }
      );
    }

    logger.info(
      `[voice] media mode: single-port — UDP+TCP ${worker.port}${announced}, ${describeParticipantCap()}`
    );
  } else {
    webRtcServer = undefined;

    // Each participant holds two transports and each transport binds one
    // UDP and one TCP port (separate pools), so the range holds about
    // size / 2 participants across the whole instance.
    const ports = worker.rtcMaxPort - worker.rtcMinPort + 1;
    logger.info(
      `[voice] media mode: range — UDP+TCP ${worker.rtcMinPort}-${worker.rtcMaxPort}${announced} (${ports} ports ≈ ${Math.floor(ports / 2)} participants), ${describeParticipantCap()}`
    );
  }
};

/** The shared WebRtcServer, or undefined in range mode. */
const getWebRtcServer = () => webRtcServer;

/**
 * Shutdown: close the worker subprocess so it does not outlive us and
 * get reaped by the OS. `close()` is deliberate, so the 'died' handler
 * above (which schedules a process exit) must not treat it as a crash.
 */
const closeMediasoup = () => {
  if (!mediaSoupWorker || mediaSoupWorker.closed) return;

  mediaSoupWorker.removeAllListeners('died');
  mediaSoupWorker.close();
  webRtcServer = undefined;
};

export {
  closeMediasoup,
  getMediaListenInfo,
  getWebRtcServer,
  loadMediasoup,
  mediaSoupWorker
};
