import type { TAuthProvider, TServerInfo } from '@pulse/shared';
import http from 'http';
import { getFirstServer } from '../db/queries/servers';
import { isRegistrationDisabled, SERVER_VERSION } from '../utils/env';

// Built-in social providers. `name` is passed verbatim to Supabase's
// `signInWithOAuth`; `label` is the button text on the login screen.
const OAUTH_PROVIDERS = [
  { env: 'GOOGLE_OAUTH_ENABLED', name: 'google', label: 'Google' },
  { env: 'DISCORD_OAUTH_ENABLED', name: 'discord', label: 'Discord' },
  { env: 'FACEBOOK_OAUTH_ENABLED', name: 'facebook', label: 'Facebook' },
  { env: 'TWITCH_OAUTH_ENABLED', name: 'twitch', label: 'Twitch' }
] as const;

// Generic OIDC provider. Supabase/GoTrue exposes a single generic-OIDC
// slot via its `keycloak` provider (GOTRUE_EXTERNAL_KEYCLOAK_*), whose
// issuer URL can point at any standards-compliant IdP — Authentik,
// Keycloak, Zitadel, Auth0, etc. Operators pick the button label with
// OIDC_LABEL (e.g. "Authentik", "Company SSO").
function getOidcProvider(): TAuthProvider | null {
  if (process.env.OIDC_OAUTH_ENABLED !== 'true') return null;
  return {
    name: 'keycloak',
    label: process.env.OIDC_LABEL || 'Single Sign-On'
  };
}

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

  const enabledAuthProviders: TAuthProvider[] = [
    ...OAUTH_PROVIDERS.filter(({ env }) => process.env[env] === 'true').map(
      ({ name, label }) => ({ name, label })
    ),
    ...(getOidcProvider() ? [getOidcProvider()!] : [])
  ];

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
