import { parse, stringify } from 'ini';
import fs from 'node:fs/promises';
import { ensureServerDirs } from './helpers/ensure-server-dirs';
import { getPrivateIp, getPublicIp } from './helpers/network';
import { CONFIG_INI_PATH } from './helpers/paths';
import { IS_DEVELOPMENT } from './utils/env';
import { fileExists } from './utils/file-manager';

const [SERVER_PUBLIC_IP, SERVER_PRIVATE_IP] = await Promise.all([
  getPublicIp(),
  getPrivateIp()
]);

type TConfig = {
  server: {
    port: number;
    debug: boolean;
    autoupdate: boolean;
  };
  http: {
    maxFiles: number;
    maxFileSize: number;
  };
  mediasoup: {
    worker: {
      rtcMinPort: number;
      rtcMaxPort: number;
    };
    audio: {
      maxBitrate: number;
      stereo: boolean;
      fec: boolean;
      dtx: boolean;
    };
    video: {
      initialAvailableOutgoingBitrate: number;
    };
  };
  federation: {
    enabled: boolean;
    domain: string;
  };
};

let config: TConfig = {
  server: {
    port: 4991,
    debug: IS_DEVELOPMENT ? true : false,
    autoupdate: false
  },
  http: {
    maxFiles: 40,
    maxFileSize: 100 // 100 MB
  },
  mediasoup: {
    worker: {
      rtcMinPort: 40000,
      rtcMaxPort: 40020
    },
    audio: {
      maxBitrate: 510000,
      stereo: true,
      fec: true,
      dtx: true
    },
    video: {
      initialAvailableOutgoingBitrate: 6000000
    }
  },
  federation: {
    enabled: false,
    domain: ''
  }
};

// TODO: get rid of this double write here, but it's fine for now
await ensureServerDirs();

if (!(await fileExists(CONFIG_INI_PATH))) {
  await fs.writeFile(CONFIG_INI_PATH, stringify(config));
}

const text = await fs.readFile(CONFIG_INI_PATH, {
  encoding: 'utf-8'
});

if (process.env.DEBUG) {
  config.server.debug = true;
}

const parsed = parse(text) as Record<string, unknown>;

// Deep-merge parsed INI over defaults so new sections (e.g. federation)
// are always present even on existing installs.
config = {
  server: { ...config.server, ...(parsed.server as object) },
  http: { ...config.http, ...(parsed.http as object) },
  mediasoup: {
    worker: {
      ...config.mediasoup.worker,
      ...((parsed.mediasoup as Record<string, object>)?.worker as object)
    },
    audio: {
      ...config.mediasoup.audio,
      ...((parsed.mediasoup as Record<string, object>)?.audio as object)
    },
    video: {
      ...config.mediasoup.video,
      ...((parsed.mediasoup as Record<string, object>)?.video as object)
    }
  },
  federation: { ...config.federation, ...(parsed.federation as object) }
} as TConfig;

// Coerce INI string values back to proper types
config.server.port = Number(config.server.port);
config.server.debug = String(config.server.debug) === 'true';
config.server.autoupdate = String(config.server.autoupdate) === 'true';
config.http.maxFiles = Number(config.http.maxFiles);
config.http.maxFileSize = Number(config.http.maxFileSize);
config.mediasoup.worker.rtcMinPort = Number(config.mediasoup.worker.rtcMinPort);
config.mediasoup.worker.rtcMaxPort = Number(config.mediasoup.worker.rtcMaxPort);
config.mediasoup.audio.maxBitrate = Number(config.mediasoup.audio.maxBitrate);
config.mediasoup.audio.stereo = String(config.mediasoup.audio.stereo) === 'true';
config.mediasoup.audio.fec = String(config.mediasoup.audio.fec) === 'true';
config.mediasoup.audio.dtx = String(config.mediasoup.audio.dtx) === 'true';
config.mediasoup.video.initialAvailableOutgoingBitrate = Number(config.mediasoup.video.initialAvailableOutgoingBitrate);
config.federation.enabled = String(config.federation.enabled) === 'true';

export { config, SERVER_PRIVATE_IP, SERVER_PUBLIC_IP };
