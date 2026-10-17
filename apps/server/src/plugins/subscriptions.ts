/**
 * In-process subscriptions to what plugins do: the topics a plugin
 * raises through `ctx.server.notify`, and the load/unload lifecycle.
 *
 * Kept in a module that imports nothing so a server feature can
 * subscribe while its own module evaluates. plugins/index.ts sits in an
 * import cycle with the routers (the channel actions reach the thread
 * helpers, which reach the routers, which reach the bridge sync), and
 * reading `pluginManager` from inside that cycle is a TDZ error whose
 * outcome depends on which module happened to be imported first — the
 * shape routers/servers/bridge-hooks.ts exists to avoid. The manager
 * exposes `onNotify` / `onPluginLoaded` / `onPluginUnloaded` as these
 * functions and is the only caller of the delivering side.
 */

type TNotifyHandler = (payload: unknown) => void | Promise<void>;
type TLifecycleListener = (pluginId: string) => void | Promise<void>;
/** How a failing subscriber is reported — the manager routes it to the plugin's log. */
type TFailureReporter = (message: string) => void;

const notifyHandlers = new Map<string, Map<string, Set<TNotifyHandler>>>();
const loadedListeners = new Set<TLifecycleListener>();
const unloadedListeners = new Set<TLifecycleListener>();

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Subscribe to what a plugin says through `ctx.server.notify(topic)`.
 * Scoped to one plugin id so a feature only hears the plugin it trusts
 * for that topic; the entry outlives the plugin's loads and unloads.
 * Returns the unsubscribe.
 */
const onPluginNotify = (
  pluginId: string,
  topic: string,
  handler: TNotifyHandler
): (() => void) => {
  let topics = notifyHandlers.get(pluginId);

  if (!topics) {
    topics = new Map();
    notifyHandlers.set(pluginId, topics);
  }

  let handlers = topics.get(topic);

  if (!handlers) {
    handlers = new Set();
    topics.set(topic, handlers);
  }

  handlers.add(handler);

  return () => {
    const current = notifyHandlers.get(pluginId)?.get(topic);

    if (!current) return;

    current.delete(handler);

    if (current.size === 0) {
      notifyHandlers.get(pluginId)!.delete(topic);

      if (notifyHandlers.get(pluginId)!.size === 0) {
        notifyHandlers.delete(pluginId);
      }
    }
  };
};

const hasPluginNotifySubscribers = (pluginId: string, topic: string): boolean =>
  (notifyHandlers.get(pluginId)?.get(topic)?.size ?? 0) > 0;

/**
 * Hand a signal to every subscriber, in order, as the plugin raises it.
 * A handler that throws or rejects is reported and the rest still run.
 */
const deliverPluginNotify = (
  pluginId: string,
  topic: string,
  payload: unknown,
  report: TFailureReporter
): void => {
  const handlers = notifyHandlers.get(pluginId)?.get(topic);

  if (!handlers) return;

  for (const handler of [...handlers]) {
    try {
      const result = handler(payload);

      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((error: unknown) => {
          report(`A server subscriber to '${topic}' failed: ${errorText(error)}`);
        });
      }
    } catch (error) {
      report(`A server subscriber to '${topic}' failed: ${errorText(error)}`);
    }
  }
};

/** Fires after a plugin's `onLoad` succeeded (boot and toggle alike). Returns the unsubscribe. */
const onPluginLoaded = (listener: TLifecycleListener): (() => void) => {
  loadedListeners.add(listener);
  return () => loadedListeners.delete(listener);
};

/** Fires after a plugin's unload finished. Returns the unsubscribe. */
const onPluginUnloaded = (listener: TLifecycleListener): (() => void) => {
  unloadedListeners.add(listener);
  return () => unloadedListeners.delete(listener);
};

/**
 * Listeners run in registration order and are awaited, so a feature
 * that wants its first work started before the toggle returns gets
 * that; one that throws is reported and does not stop the others.
 */
const emitPluginLifecycle = async (
  what: 'loaded' | 'unloaded',
  pluginId: string,
  report: TFailureReporter
): Promise<void> => {
  const listeners = what === 'loaded' ? loadedListeners : unloadedListeners;

  for (const listener of [...listeners]) {
    try {
      await listener(pluginId);
    } catch (error) {
      report(`A plugin-${what} listener failed: ${errorText(error)}`);
    }
  }
};

export {
  deliverPluginNotify,
  emitPluginLifecycle,
  hasPluginNotifySubscribers,
  onPluginLoaded,
  onPluginNotify,
  onPluginUnloaded
};
export type { TLifecycleListener, TNotifyHandler };
