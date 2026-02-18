import { mock } from 'bun:test';

/**
 * This file MUST be the first preload in bunfig.toml.
 *
 * It mocks modules that would otherwise throw or perform side effects
 * (network calls, file I/O, env var checks) at import time.
 *
 * Modules mocked here:
 * - config    — top-level await for getPublicIp/getPrivateIp + file I/O
 * - logger    — imports config, creates log files at module scope
 * - supabase  — throws immediately if SUPABASE_URL env vars are missing
 */

// ── Suppress console output during tests ──
const noop = () => {};

global.console.log = noop;
global.console.info = noop;
global.console.warn = noop;
global.console.debug = noop;

// ── Mock config (avoids network calls and file system reads) ──
mock.module('../config', () => ({
  config: {
    server: { port: 9999, debug: false, autoupdate: false },
    http: { maxFiles: 40, maxFileSize: 100 },
    mediasoup: {
      worker: { rtcMinPort: 40000, rtcMaxPort: 40020 },
      audio: { maxBitrate: 510000, stereo: true, fec: true, dtx: true }
    },
    federation: { enabled: false, domain: '' }
  },
  SERVER_PUBLIC_IP: '127.0.0.1',
  SERVER_PRIVATE_IP: '127.0.0.1'
}));

// ── Mock logger (avoids importing config + creating log files) ──
mock.module('../logger', () => ({
  logger: {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    time: noop,
    timeEnd: noop
  }
}));

// ── Mock supabase (avoids env var check that throws at import time) ──
// In tests, the access token IS the user's supabaseId.
// The mock makes supabaseAdmin.auth.getUser(token) return { id: token }
// so getUserByToken → getUserBySupabaseId works against the test DB.
mock.module('../utils/supabase', () => ({
  supabaseAdmin: {
    auth: {
      getUser: async (token: string) => ({
        data: { user: { id: token } },
        error: null
      }),
      admin: {
        generateLink: async () => ({
          data: { actionLink: 'mock-link' },
          error: null
        })
      }
    }
  }
}));
