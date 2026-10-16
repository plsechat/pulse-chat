import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  removeLocalStorageItem,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import type { TFederatedServerEntry } from './slice';

/**
 * Which federated server was in focus, persisted across a reload.
 *
 * ACTIVE_SERVER_ID holds a HOME server id and is what the reload's first
 * openSession loads; a federated server's numeric id must never land
 * there — ids collide across instances, so the home join would open
 * whatever home server happens to share the number. The federated focus
 * is therefore persisted separately, as the pair that identifies it,
 * and re-entered only after the federated memberships have loaded.
 */
type TFederatedFocus = {
  instanceDomain: string;
  serverId: number;
};

const saveFederatedFocus = (focus: TFederatedFocus) =>
  setLocalStorageItemAsJSON(LocalStorageKey.ACTIVE_FEDERATED_SERVER, focus);

const clearFederatedFocus = () =>
  removeLocalStorageItem(LocalStorageKey.ACTIVE_FEDERATED_SERVER);

const readFederatedFocus = (): TFederatedFocus | undefined => {
  const saved = getLocalStorageItemAsJSON<unknown>(
    LocalStorageKey.ACTIVE_FEDERATED_SERVER
  );
  if (!saved || typeof saved !== 'object') return undefined;
  const { instanceDomain, serverId } = saved as Partial<TFederatedFocus>;
  if (typeof instanceDomain !== 'string' || instanceDomain.length === 0) {
    return undefined;
  }
  if (typeof serverId !== 'number' || !Number.isInteger(serverId)) {
    return undefined;
  }
  return { instanceDomain, serverId };
};

/**
 * The membership entry a saved focus points at, or undefined when the
 * focus is stale (left, kicked, unpeered) — nothing is re-entered then.
 */
const resolveFederatedFocus = (
  focus: TFederatedFocus | undefined,
  entries: TFederatedServerEntry[]
): TFederatedServerEntry | undefined => {
  if (!focus) return undefined;
  return entries.find(
    (entry) =>
      entry.instanceDomain === focus.instanceDomain &&
      entry.server.id === focus.serverId
  );
};

export {
  clearFederatedFocus,
  readFederatedFocus,
  resolveFederatedFocus,
  saveFederatedFocus
};
export type { TFederatedFocus };
