/**
 * Phase debug-logging / Phase 1 — log-context module.
 *
 * AsyncLocalStorage propagation: the request-scoped correlation id and
 * its companion fields must survive across `await`, microtasks, and
 * nested setTimeout / Promise boundaries — otherwise debug lines from
 * deep helpers won't carry the id.
 */
import { describe, expect, test } from 'bun:test';
import {
  getLogContext,
  newRequestId,
  updateLogContext,
  withLogContext
} from '../log-context';

describe('log-context', () => {
  test('getLogContext returns null outside any scope', () => {
    expect(getLogContext()).toBeNull();
  });

  test('withLogContext binds the active context for the inner stack', () => {
    const ret = withLogContext({ requestId: 'req-1', userId: 42 }, () => {
      const ctx = getLogContext();
      expect(ctx?.requestId).toBe('req-1');
      expect(ctx?.userId).toBe(42);
      return 'ok';
    });
    expect(ret).toBe('ok');
    expect(getLogContext()).toBeNull();
  });

  test('context survives across await boundaries', async () => {
    await withLogContext({ requestId: 'req-2' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(getLogContext()?.requestId).toBe('req-2');
      await Promise.resolve();
      expect(getLogContext()?.requestId).toBe('req-2');
    });
  });

  test('nested withLogContext creates a child scope and restores on exit', () => {
    withLogContext({ requestId: 'outer' }, () => {
      expect(getLogContext()?.requestId).toBe('outer');
      withLogContext({ requestId: 'inner' }, () => {
        expect(getLogContext()?.requestId).toBe('inner');
      });
      // Outer scope still active after inner returns
      expect(getLogContext()?.requestId).toBe('outer');
    });
  });

  test('updateLogContext mutates the active scope', () => {
    withLogContext({ requestId: 'req-3' }, () => {
      updateLogContext({ userId: 7, route: '/test' });
      const ctx = getLogContext();
      expect(ctx?.userId).toBe(7);
      expect(ctx?.route).toBe('/test');
      expect(ctx?.requestId).toBe('req-3');
    });
  });

  test('updateLogContext outside a scope is a no-op', () => {
    updateLogContext({ userId: 9 });
    expect(getLogContext()).toBeNull();
  });

  test('newRequestId returns distinct UUID-shaped ids', () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
    expect(typeof a).toBe('string');
  });
});
