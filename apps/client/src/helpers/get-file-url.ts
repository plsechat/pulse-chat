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

const getFileUrl = (
  file: (TFileRef & { _accessToken?: string }) | undefined | null,
  instanceDomain?: string
) => {
  if (!file) return '';

  // If on a remote federated server, resolve URL to remote instance
  if (instanceDomain) {
    const base =
      remoteInstanceBaseUrls.get(instanceDomain) ??
      `${instanceDomain.includes('localhost') ? 'http' : 'https'}://${instanceDomain}`;
    let baseUrl = `${base}/public/${file.name}`;

    if (file._accessToken) {
      baseUrl += `?accessToken=${file._accessToken}`;
    }

    return encodeURI(baseUrl);
  }

  const url = getUrlFromServer();

  let baseUrl = `${url}/public/${file.name}`;

  if (file._accessToken) {
    baseUrl += `?accessToken=${file._accessToken}`;
  }

  return encodeURI(baseUrl);
};

export {
  getFileUrl,
  getHostFromServer,
  getUrlFromServer,
  registerRemoteInstanceUrl
};
