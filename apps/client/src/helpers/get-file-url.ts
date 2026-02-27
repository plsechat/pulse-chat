import type { TFileRef } from '@pulse/shared';

const getHostFromServer = () => {
  if (import.meta.env.MODE === 'development') {
    return 'localhost:4991';
  }

  return window.location.host;
};

const getUrlFromServer = () => {
  if (import.meta.env.MODE === 'development') {
    return 'http://localhost:4991';
  }

  const host = window.location.host;
  const currentProtocol = window.location.protocol;

  const finalUrl = `${currentProtocol}//${host}`;

  return finalUrl;
};

const getFileUrl = (
  file: (TFileRef & { _accessToken?: string }) | undefined | null,
  instanceDomain?: string
) => {
  if (!file) return '';

  // If on a remote federated server, resolve URL to remote instance
  if (instanceDomain) {
    const protocol = instanceDomain.includes('localhost') ? 'http' : 'https';
    let baseUrl = `${protocol}://${instanceDomain}/public/${file.name}`;

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

export { getFileUrl, getHostFromServer, getUrlFromServer };
