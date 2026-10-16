import { UploadHeaders } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { appRouter } from '../routers';
import { users } from '../db/schema';
import { createMockContext } from './context';
import { getTestDb } from './mock-db';
import { testsBaseUrl } from './setup';

const getMockedToken = async (userId: number) => {
  const tdb = getTestDb();

  // Get the user's supabaseId from the test database
  const [user] = await tdb
    .select({ supabaseId: users.supabaseId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new Error(`Test user with id ${userId} not found`);
  }

  // For tests, the access token IS the user's supabaseId — the auth-
  // backend mock in `mock-modules.ts` returns `{ user: { id: token } }`
  // from getUser(token), so anywhere `getUserByToken` runs in test
  // code, this round-trips back to the test user row.
  return user.supabaseId;
};

const getCaller = async (userId: number) => {
  const mockedToken = await getMockedToken(userId);

  const ctx = await createMockContext({
    customToken: mockedToken
  });

  const caller = appRouter.createCaller(ctx);

  return { caller, mockedToken, ctx };
};

// this will basically simulate a specific user connecting to the server
const initTest = async (userId: number = 1) => {
  const { caller, mockedToken, ctx } = await getCaller(userId);
  const { handshakeHash } = await caller.others.handshake();

  const initialData = await caller.others.openSession({
    handshakeHash: handshakeHash
  });

  return { caller, mockedToken, initialData, ctx };
};

const login = async (email: string, password: string, invite?: string) =>
  fetch(`${testsBaseUrl}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email,
      password,
      invite
    })
  });

type Caller = ReturnType<typeof appRouter.createCaller>;

type SubscriptionSource<T> =
  | {
      subscribe: (observer: {
        next: (value: T) => void;
        error?: (err: unknown) => void;
        complete?: () => void;
      }) => { unsubscribe: () => void };
    }
  | AsyncIterable<T>;

/**
 * Subscribe to `caller.<ns>.<route>()`, run `trigger`, and resolve the
 * first event the subscription yields — the one-line shape for the
 * `on*` routes. The listener is registered BEFORE the trigger runs
 * (pubsub.subscribeFor registers synchronously), and the subscription
 * is torn down afterwards so a listener never leaks into the next
 * test. Rejects when nothing arrives within `timeoutMs` (default 2 s),
 * so a route that publishes to the wrong user fails loudly instead of
 * hanging the file.
 */
const firstSubscriptionEvent = async <T = unknown>(
  caller: Caller,
  ns: keyof Caller & string,
  route: string,
  trigger: () => unknown,
  opts: { input?: unknown; timeoutMs?: number } = {}
): Promise<T> => {
  const namespace = (caller as unknown as Record<string, Record<string, unknown>>)[
    ns
  ];
  const procedure = namespace?.[route];
  if (typeof procedure !== 'function') {
    throw new Error(`No subscription procedure ${ns}.${route}`);
  }

  const source = (await procedure(opts.input)) as SubscriptionSource<T>;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  let unsubscribe: (() => void) | undefined;

  const first = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`${ns}.${route} yielded no event within ${timeoutMs}ms`)
        ),
      timeoutMs
    );
    const settle = <R>(fn: (v: R) => void) => (v: R) => {
      clearTimeout(timer);
      fn(v);
    };

    if ('subscribe' in source && typeof source.subscribe === 'function') {
      const sub = source.subscribe({
        next: settle(resolve),
        error: settle(reject)
      });
      unsubscribe = () => sub.unsubscribe();
      return;
    }

    if (Symbol.asyncIterator in source) {
      const iterator = source[Symbol.asyncIterator]();
      iterator.next().then(
        settle((result: IteratorResult<T>) => {
          if (result.done) reject(new Error(`${ns}.${route} ended early`));
          else resolve(result.value);
        }),
        settle(reject)
      );
      unsubscribe = () => {
        void iterator.return?.();
      };
      return;
    }

    clearTimeout(timer);
    reject(new Error(`${ns}.${route} is not a subscription`));
  });

  try {
    await trigger();
    return await first;
  } finally {
    unsubscribe?.();
  }
};

const uploadFile = async (file: File, token: string) =>
  fetch(`${testsBaseUrl}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      [UploadHeaders.TYPE]: file.type,
      [UploadHeaders.CONTENT_LENGTH]: file.size.toString(),
      [UploadHeaders.ORIGINAL_NAME]: file.name,
      [UploadHeaders.TOKEN]: token
    },
    body: file
  });

export {
  firstSubscriptionEvent,
  getCaller,
  getMockedToken,
  initTest,
  login,
  uploadFile
};
