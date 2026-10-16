/**
 * useAdminQuery — the one fetch state machine behind the instance
 * panels: loading on mount, data or error afterwards, Retry re-runs the
 * fetch, and a stale response never overwrites a newer one (A8-6).
 *
 * Run via: bun test apps/client/src/features/server/admin/__tests__/use-admin-query.test.tsx
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAdminQuery, type TAdminQuery } from '../hooks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
const defer = <T,>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

let root: Root | null = null;
let latest: TAdminQuery<string> | null = null;

const mount = (fn: () => Promise<string>) => {
  const Probe = () => {
    latest = useAdminQuery(fn, 'fallback');
    return null;
  };
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root!.render(<Probe />));
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = null;
});

describe('useAdminQuery', () => {
  test('loading → data', async () => {
    const d = defer<string>();
    mount(() => d.promise);
    expect(latest!.loading).toBe(true);
    expect(latest!.data).toBeNull();

    d.resolve('ok');
    await flush();
    expect(latest!.loading).toBe(false);
    expect(latest!.data).toBe('ok');
    expect(latest!.error).toBeNull();
  });

  test('a rejected fetch becomes an error, and refetch clears it', async () => {
    let calls = 0;
    mount(() => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('fine');
    });
    await flush();
    expect(latest!.error).toBe('boom');
    expect(latest!.loading).toBe(false);

    await act(async () => {
      await latest!.refetch();
    });
    expect(latest!.error).toBeNull();
    expect(latest!.data).toBe('fine');
  });

  test('a stale response cannot overwrite a newer refetch', async () => {
    const first = defer<string>();
    const second = defer<string>();
    let calls = 0;
    mount(() => (++calls === 1 ? first.promise : second.promise));

    let refetched: Promise<void>;
    act(() => {
      refetched = latest!.refetch();
    });
    second.resolve('new');
    await flush();
    await act(async () => {
      await refetched;
    });
    expect(latest!.data).toBe('new');

    first.resolve('old');
    await flush();
    expect(latest!.data).toBe('new');
    expect(latest!.loading).toBe(false);
  });
});
