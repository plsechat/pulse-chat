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
      audio: { maxBitrate: 510000, stereo: true, fec: true, dtx: true },
      video: { initialAvailableOutgoingBitrate: 6000000 }
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

// ── Mock rate limiter (disable rate limiting during tests) ──
mock.module('../http/rate-limit', () => ({
  checkRateLimit: () => true,
  authRateLimit: { windowMs: 900000, maxRequests: Infinity },
  federationRateLimit: { windowMs: 60000, maxRequests: Infinity }
}));

// ── In-memory auth store for supabase mock ──
// Shared via globalThis so seed.ts can pre-populate it.
// Each entry: { supabaseId: string, password: string, email: string }
type AuthEntry = { supabaseId: string; password: string; email: string };

declare global {
  // eslint-disable-next-line no-var
  var __supabaseAuthStore: Map<string, AuthEntry>;
}

globalThis.__supabaseAuthStore =
  globalThis.__supabaseAuthStore || new Map<string, AuthEntry>();

const authStore = globalThis.__supabaseAuthStore;

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

      signInWithPassword: async ({
        email,
        password
      }: {
        email: string;
        password: string;
      }) => {
        const existing = authStore.get(email);

        if (existing) {
          // Email found — validate password
          if (existing.password !== password) {
            return {
              data: { user: null, session: null },
              error: { message: 'Invalid login credentials' }
            };
          }

          return {
            data: {
              user: { id: existing.supabaseId },
              session: {
                access_token: existing.supabaseId,
                refresh_token: crypto.randomUUID()
              }
            },
            error: null
          };
        }

        // Email not found — auto-create (mirrors Supabase signUp-on-signIn)
        const newId = crypto.randomUUID();

        authStore.set(email, { supabaseId: newId, password, email });

        return {
          data: {
            user: { id: newId },
            session: {
              access_token: newId,
              refresh_token: crypto.randomUUID()
            }
          },
          error: null
        };
      },

      admin: {
        generateLink: async () => ({
          data: { actionLink: 'mock-link' },
          error: null
        }),

        createUser: async ({
          email,
          password
        }: {
          email: string;
          password: string;
        }) => {
          if (authStore.has(email)) {
            return {
              data: { user: null },
              error: { message: 'User already registered' }
            };
          }

          const newId = crypto.randomUUID();
          authStore.set(email, { supabaseId: newId, password, email });

          return {
            data: { user: { id: newId, email } },
            error: null
          };
        },

        getUserById: async (id: string) => {
          for (const entry of authStore.values()) {
            if (entry.supabaseId === id) {
              return {
                data: { user: { id: entry.supabaseId, email: entry.email } },
                error: null
              };
            }
          }

          return {
            data: { user: null },
            error: { message: 'User not found' }
          };
        },

        updateUserById: async (
          id: string,
          updates: { password?: string }
        ) => {
          for (const [email, entry] of authStore.entries()) {
            if (entry.supabaseId === id) {
              if (updates.password) {
                authStore.set(email, { ...entry, password: updates.password });
              }

              return {
                data: { user: { id: entry.supabaseId, email: entry.email } },
                error: null
              };
            }
          }

          return {
            data: { user: null },
            error: { message: 'User not found' }
          };
        }
      }
    }
  }
}));
