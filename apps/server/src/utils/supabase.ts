/**
 * Back-compat re-export. The real auth dispatcher lives in
 * `utils/auth`. New code should import `authBackend` from there.
 *
 * Kept so the test mock at `apps/server/src/__tests__/mock-modules.ts`
 * has a stable target for legacy callers, and so any out-of-tree
 * forks importing `../utils/supabase` keep working.
 */
export { authBackend } from './auth';
