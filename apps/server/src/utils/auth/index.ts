/**
 * AuthBackend dispatcher — picks `local` or `supabase` based on env
 * config, then re-exports the chosen backend as `authBackend`.
 *
 * Selection rules (first match wins):
 *
 *   1. `AUTH_BACKEND=local`   → local (bcrypt + HS256 JWT)
 *   2. `AUTH_BACKEND=supabase` → supabase (managed)
 *   3. `SUPABASE_URL` is set → supabase   (back-compat with existing
 *                                          installs that haven't
 *                                          opted in to the env flag)
 *   4. Otherwise → local
 *
 * The selection is logged at boot so operators can confirm which
 * backend is in use without opening a JS shell.
 */

import { logger } from '../../logger';
import { localAuthBackend } from './local';
import { supabaseAuthBackend } from './supabase';
import type { AuthBackend } from './types';

function pickBackend(): AuthBackend {
  const explicit = process.env.AUTH_BACKEND?.toLowerCase().trim();
  if (explicit === 'local') return localAuthBackend;
  if (explicit === 'supabase') return supabaseAuthBackend;
  if (explicit && explicit.length > 0) {
    throw new Error(
      `Unknown AUTH_BACKEND value "${explicit}" — expected "local" or "supabase"`
    );
  }
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return supabaseAuthBackend;
  }
  return localAuthBackend;
}

const authBackend = pickBackend();

logger.info('[auth] backend=%s', authBackend.kind);

export { authBackend };
export type { AuthBackend } from './types';
