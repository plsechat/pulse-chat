import os from 'os';

const FETCH_TIMEOUT_MS = 5000;

const getPrivateIp = async () => {
  const interfaces = os.networkInterfaces();
  const addresses = Object.values(interfaces)
    .flat()
    .filter((iface) => iface?.family === 'IPv4' && !iface.internal)
    .map((iface) => iface?.address);

  return addresses[0];
};

const getPublicIpFromIpify = async (): Promise<string | undefined> => {
  try {
    const response = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const data = (await response.json()) as {
      ip: string;
    };

    return data.ip;
  } catch {
    return undefined;
  }
};

// fallback since it can return ipv6 sometimes
const getPublicIpFromIfconfig = async (): Promise<string | undefined> => {
  try {
    const response = await fetch('https://ifconfig.me/ip', {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const ip = (await response.text()).trim();

    return ip;
  } catch {
    return undefined;
  }
};

const getPublicIpFromIcanhazip = async (): Promise<string | undefined> => {
  try {
    const response = await fetch('https://ipv4.icanhazip.com', {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const ip = (await response.text()).trim();

    return ip;
  } catch {
    return undefined;
  }
};

const getPublicIp = async () => {
  // Allow override via env var (useful for Docker/NAT environments)
  if (process.env.PUBLIC_IP) {
    return process.env.PUBLIC_IP;
  }

  // Run all providers concurrently. Return the first success.
  // Each provider has its own 5s timeout via AbortSignal.
  // Providers return undefined on failure, so we wrap them to reject
  // on undefined results. Promise.any then resolves with the first real IP.
  const requireDefined = (p: Promise<string | undefined>) =>
    p.then((v) => {
      if (!v) throw new Error('no ip');
      return v;
    });

  try {
    const ip = await Promise.any([
      requireDefined(getPublicIpFromIcanhazip()),
      requireDefined(getPublicIpFromIpify()),
      requireDefined(getPublicIpFromIfconfig())
    ]);

    return ip;
  } catch {
    // All providers failed or returned undefined
    return undefined;
  }
};

export { getPrivateIp, getPublicIp };
