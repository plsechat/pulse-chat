/**
 * Helpers for the family of `subscribeToX` functions in
 * `features/*\/subscriptions.ts`. Every one of those files used to
 * spell out the same boilerplate three times per subscription:
 *
 *   const onFooSub = trpc.foo.onSomething.subscribe(undefined, {
 *     onData: (x) => ...,
 *     onError: (err) => console.error('onFoo subscription error:', err)
 *   });
 *   ...
 *   return () => {
 *     onFooSub.unsubscribe();
 *     onBarSub.unsubscribe();
 *     ...   // hand-maintained, drift-prone, easy to forget
 *   };
 *
 * Worse: the manual unsub list was duplicated whenever the function
 * had an early-return path (e.g. messages/subscriptions.ts kept two
 * copies of the 14-entry unsub block — one for the `if (!homeTrpc)`
 * guard and one for the main path; adding a new sub meant remembering
 * both). That's the canonical memory-leak class footgun.
 *
 * The helpers below collapse the boilerplate and remove the dual-list
 * hazard:
 *
 *   subscribe(name, source, onData)
 *     - returns an `Unsubscribe` (just a thunk)
 *     - logs errors with a stable `${name} subscription error:` prefix
 *
 *   combineUnsubscribes(...unsubs)
 *     - merges any number of `Unsubscribe` thunks into one
 *     - the SINGLE source of truth for cleanup; whatever's in the
 *       array gets unsubscribed, no parallel list to keep in sync
 *
 * Typical use:
 *
 *   const subs = [
 *     subscribe('onFoo', trpc.foo.onSomething, (x) => addFoo(x)),
 *     subscribe('onBar', trpc.bar.onSomething, (x) => addBar(x))
 *   ];
 *   const homeTrpc = getHomeTRPCClient();
 *   if (homeTrpc) {
 *     subs.push(subscribe('onFedInstance', homeTrpc.federation.onInstanceUpdate, ...));
 *   }
 *   return combineUnsubscribes(...subs);
 */

type Unsubscribe = () => void;

/**
 * Minimal shape that matches a tRPC v10 subscription proxy's
 * `.subscribe(input, opts)`. Kept loose so any concrete tRPC client
 * shape satisfies it without needing to drag the whole tRPC type in.
 */
type TrpcSubscriptionLike<TData> = {
  subscribe(
    input: undefined,
    opts: {
      onData: (data: TData) => void | Promise<void>;
      onError: (err: unknown) => void;
    }
  ): { unsubscribe: () => void };
};

// onData callbacks routinely return Redux dispatch results — typed as
// `{ payload, type }` action shapes. tRPC's onData signature wants
// `void | Promise<void>`. Accept `unknown` here and discard whatever
// the caller returns; this keeps the call sites tidy
// (`(role) => addRole(role)` instead of `(role) => { addRole(role); }`).
const subscribe = <TData>(
  name: string,
  source: TrpcSubscriptionLike<TData>,
  onData: (data: TData) => unknown
): Unsubscribe => {
  const sub = source.subscribe(undefined, {
    onData: async (data) => {
      // TEMP DIAG — pubsub regression. Remove after diagnosis.
      if (name.startsWith('onDm')) {
        console.log(`[DM-DIAG] subscribe.onData ${name}`, data);
      }
      // Await in case the caller returns a promise (e.g. async
      // decryption before dispatch). Errors propagate to onError via
      // the async wrapper.
      await onData(data);
    },
    onError: (err) => console.error(`${name} subscription error:`, err)
  });
  return () => sub.unsubscribe();
};

const combineUnsubscribes = (...unsubs: Unsubscribe[]): Unsubscribe => {
  return () => {
    for (const u of unsubs) {
      try {
        u();
      } catch (err) {
        // One handler throwing must not block the others — that would
        // leak the rest of the subscriptions. Log and keep going.
        console.error('Unsubscribe handler threw:', err);
      }
    }
  };
};

export { subscribe, combineUnsubscribes };
export type { Unsubscribe };
