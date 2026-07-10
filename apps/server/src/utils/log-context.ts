/**
 * AsyncLocalStorage-backed correlation context for structured logs.
 *
 * Every inbound request (HTTP, WS, federation handler, tRPC call)
 * runs `withLogContext({ requestId, ... }, fn)` so any `logger.*`
 * call inside the call stack — even from deep transitive helpers —
 * can stamp the same `requestId` onto its JSON payload without
 * threading it through every signature.
 *
 * Cross-instance correlation: federation requests carry the active
 * `requestId` in the `X-Pulse-Request-Id` header; the receiver
 * extracts it and seeds its own context with the same id, so a
 * single trace spans both sides of the call.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUIDv7 } from 'bun';

export type LogContext = {
  requestId: string;
  userId?: number;
  instanceDomain?: string;
  route?: string;
  [key: string]: unknown;
};

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Run `fn` with `ctx` bound as the active log context. Nested calls
 * to `withLogContext` create child scopes; reads from `getLogContext`
 * see the innermost active scope.
 */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Returns the active context, or null if no scope is active. Logger
 * transports call this on every emit to merge the context into the
 * structured payload.
 */
export function getLogContext(): LogContext | null {
  return storage.getStore() ?? null;
}

/**
 * Mutate fields on the active context. No-op outside a scope.
 *
 * Useful when a request handler learns the userId / route mid-flow
 * (e.g. tRPC middleware after the input is parsed) and wants
 * subsequent log lines from the same request to carry that detail.
 */
export function updateLogContext(patch: Partial<LogContext>): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  Object.assign(ctx, patch);
}

/**
 * Generates a fresh request id. Used at trust boundaries (HTTP
 * server entry, WS connection accept) when no inbound id is present.
 */
export function newRequestId(): string {
  return randomUUIDv7();
}
