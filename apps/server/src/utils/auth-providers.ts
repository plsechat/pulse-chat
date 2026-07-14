import type { TAuthProvider } from '@pulse/shared';
import { isRegistrationMethodEnabled } from './env';
import { getOidcConfig } from './oidc';

// Built-in social providers (Supabase-mediated). `name` is passed verbatim
// to Supabase's `signInWithOAuth`; `label` is the button text. These
// require AUTH_BACKEND=supabase.
const OAUTH_PROVIDERS = [
  { env: 'GOOGLE_OAUTH_ENABLED', name: 'google', label: 'Google' },
  { env: 'DISCORD_OAUTH_ENABLED', name: 'discord', label: 'Discord' },
  { env: 'FACEBOOK_OAUTH_ENABLED', name: 'facebook', label: 'Facebook' },
  { env: 'TWITCH_OAUTH_ENABLED', name: 'twitch', label: 'Twitch' }
] as const;

// Native OIDC provider (PULSE runs the flow itself — see utils/oidc.ts).
// Works with any standards-compliant IdP (Authentik, Keycloak, Zitadel,
// Auth0, …) under either auth backend. Advertised only when fully
// configured. `kind: 'oidc'` tells the client to redirect to
// /auth/oidc/start rather than call Supabase.
function getOidcProvider(): TAuthProvider | null {
  const config = getOidcConfig();
  if (!config) return null;
  return { name: 'oidc', label: config.label, kind: 'oidc' };
}

const getEnabledAuthProviders = (): TAuthProvider[] => {
  const oidcProvider = getOidcProvider();

  return [
    ...OAUTH_PROVIDERS.filter(({ env }) => process.env[env] === 'true').map(
      ({ name, label }) => ({ name, label })
    ),
    ...(oidcProvider ? [oidcProvider] : [])
  ];
};

/**
 * SSO-only mode is DERIVED, not a separate switch: password (email +
 * password) login is considered disabled when the operator has turned off
 * password self-registration (REGISTRATION_PASSWORD_ENABLED=false) AND at
 * least one SSO provider (OIDC or social OAuth) is advertised. The client
 * hides the local login form and /login rejects password attempts.
 *
 * If no provider is configured, password login stays enabled regardless —
 * otherwise the deployment would have no way to sign in at all.
 *
 * A valid invite is the break-glass, mirroring register.ts: accounts
 * created through the invite path are password accounts and must be able
 * to sign in through the same invite link.
 */
const isPasswordLoginEnabled = (): boolean =>
  isRegistrationMethodEnabled('password') ||
  getEnabledAuthProviders().length === 0;

export { getEnabledAuthProviders, isPasswordLoginEnabled };
