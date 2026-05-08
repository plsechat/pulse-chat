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
 * Why dynamic imports
 * ===================
 * Bun's `--compile` flattens dynamic imports into eager statics at
 * build time. That means `await import('./supabase')` here still
 * pulls supabase.ts into the bundle — but more importantly, supabase.ts
 * isn't *evaluated* unless the import expression actually runs. So
 * gating the import expression on the env-driven branch keeps
 * supabase-js's module-init off the boot path in local mode. Without
 * this, a supabase-js init crash (observed on arm64) takes down the
 * container even when local mode is selected.
 */

import type { AuthBackend } from './types';

async function pickBackend(): Promise<AuthBackend> {
  const explicit = process.env.AUTH_BACKEND?.toLowerCase().trim();

  if (explicit && explicit !== 'local' && explicit !== 'supabase') {
    throw new Error(
      `Unknown AUTH_BACKEND value "${explicit}" — expected "local" or "supabase"`
    );
  }

  const useSupabase =
    explicit === 'supabase' ||
    (!explicit &&
      !!process.env.SUPABASE_URL &&
      !!process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (useSupabase) {
    const { supabaseAuthBackend } = await import('./supabase');
    return supabaseAuthBackend;
  }

  const { localAuthBackend } = await import('./local');
  return localAuthBackend;
}

const authBackend = await pickBackend();

// Use console.log here, not logger.info — auth/index.ts is loaded
// transitively from db/queries/users.ts during the early boot graph,
// before logger.ts finishes its top-level await on ensureDir(). Using
// the logger here creates a TDZ from the import cycle:
// logger → log-redact → config → file-manager → ... → auth.
// One-shot boot line; standard out is fine.
// eslint-disable-next-line no-console
console.log(`[auth] backend=${authBackend.kind}`);

export { authBackend };
export type { AuthBackend } from './types';
