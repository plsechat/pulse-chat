/**
 * The channel-create hook of the whole-server bridge, as a registry.
 *
 * The plugin `channels.create` action lives under plugins/, and
 * plugins/index.ts is what bridge-sync.ts (through the plugin call
 * helpers) imports — so the action importing bridge-sync directly would
 * close a module cycle and leave the servers router reading
 * `bridgeSyncRoute` before its initialisation. This module imports
 * nothing: both create paths call `notifyBridgeChannelCreated`, and
 * bridge-sync.ts registers the real hook when it loads (it always does,
 * through the servers router).
 */

type TChannelCreatedHook = (serverId: number) => Promise<void>;

let hook: TChannelCreatedHook | null = null;

const setBridgeChannelCreatedHook = (next: TChannelCreatedHook | null): void => {
  hook = next;
};

const notifyBridgeChannelCreated = async (serverId: number): Promise<void> => {
  if (hook) await hook(serverId);
};

export { notifyBridgeChannelCreated, setBridgeChannelCreatedHook };
