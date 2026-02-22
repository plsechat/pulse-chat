import type { TServerInfo } from '@pulse/shared';
import http from 'http';
import { getFirstServer } from '../db/queries/servers';
import { isRegistrationDisabled, SERVER_VERSION } from '../utils/env';

const OAUTH_PROVIDERS = [
  { env: 'GOOGLE_OAUTH_ENABLED', name: 'google' },
  { env: 'DISCORD_OAUTH_ENABLED', name: 'discord' },
  { env: 'FACEBOOK_OAUTH_ENABLED', name: 'facebook' },
  { env: 'TWITCH_OAUTH_ENABLED', name: 'twitch' }
] as const;

const infoRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const server = await getFirstServer();

  if (!server) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No server found' }));
    return;
  }

  const enabledAuthProviders = OAUTH_PROVIDERS
    .filter(({ env }) => process.env[env] === 'true')
    .map(({ name }) => name);

  const info: TServerInfo = {
    serverId: server.publicId,
    version: SERVER_VERSION,
    name: server.name,
    description: server.description,
    logo: server.logo,
    allowNewUsers: server.allowNewUsers,
    registrationDisabled: isRegistrationDisabled(),
    enabledAuthProviders,
    supabaseUrl: process.env.SUPABASE_PUBLIC_URL || process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    giphyApiKey: process.env.GIPHY_API_KEY || undefined
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(info));
};

export { infoRouteHandler };
