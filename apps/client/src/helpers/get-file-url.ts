import type { TFileRef } from '@pulse/shared';

const getHostFromServer = () => {
  if (import.meta.env.MODE === 'development') {
    return 'localhost:5443';
  }

  return window.location.host;
};

const getUrlFromServer = () => {
  if (import.meta.env.MODE === 'development') {
    return 'http://localhost:5443';
  }

  const host = window.location.host;
  const currentProtocol = window.location.protocol;

  const finalUrl = `${currentProtocol}//${host}`;

  return finalUrl;
};

// Base URLs of federated instances, registered by the federation actions
// whenever an entry is joined/loaded. The HOME SERVER computes each peer's
// protocol (http for LAN/allowlisted-private peers, https otherwise) —
// resolving from this map avoids guessing. The inline localhost-only
// fallback below only covers domains that were never registered.
const remoteInstanceBaseUrls = new Map<string, string>();

const registerRemoteInstanceUrl = (
  instanceDomain: string,
  baseUrl: string
) => {
  remoteInstanceBaseUrls.set(instanceDomain, baseUrl.replace(/\/+$/, ''));
};

/**
 * Absolute `/public/<name>` URL on the instance that owns the file: the
 * active federated instance when one is given, otherwise the home server.
 */
const getPublicFileUrl = (
  name: string,
  instanceDomain?: string,
  accessToken?: string
) => {
  const base = instanceDomain
    ? (remoteInstanceBaseUrls.get(instanceDomain) ??
      `${instanceDomain.includes('localhost') ? 'http' : 'https'}://${instanceDomain}`)
    : getUrlFromServer();
  let url = `${base}/public/${name}`;
  if (accessToken) url += `?accessToken=${accessToken}`;
  return encodeURI(url);
};

const getFileUrl = (
  file: (TFileRef & { _accessToken?: string }) | undefined | null,
  instanceDomain?: string
) => {
  if (!file) return '';
  return getPublicFileUrl(file.name, instanceDomain, file._accessToken);
};

export {
  getFileUrl,
  getPublicFileUrl,
  getHostFromServer,
  getUrlFromServer,
  registerRemoteInstanceUrl
};
