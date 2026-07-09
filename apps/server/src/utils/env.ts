// these values are injected at build time
const PULSE_ENV = process.env.PULSE_ENV;
const PULSE_BUILD_VERSION = process.env.PULSE_BUILD_VERSION;
const PULSE_BUILD_DATE = process.env.PULSE_BUILD_DATE;
const PULSE_MEDIASOUP_BIN_NAME = process.env.PULSE_MEDIASOUP_BIN_NAME;

const SERVER_VERSION =
  typeof PULSE_BUILD_VERSION !== 'undefined'
    ? PULSE_BUILD_VERSION
    : '0.0.0-dev';

const BUILD_DATE =
  typeof PULSE_BUILD_DATE !== 'undefined' ? PULSE_BUILD_DATE : 'dev';

const env = typeof PULSE_ENV !== 'undefined' ? PULSE_ENV : 'development';
const IS_PRODUCTION = env === 'production';
const IS_DEVELOPMENT = !IS_PRODUCTION;
const IS_TEST = process.env.NODE_ENV === 'test';
const IS_DOCKER = process.env.RUNNING_IN_DOCKER === 'true';
const isRegistrationDisabled = () => process.env.REGISTRATION_DISABLED === 'true';

/**
 * Per-method registration switches. Each defaults to ENABLED and is only
 * turned off by an explicit `false`, so existing deployments are unchanged.
 * These are independent of the global `REGISTRATION_DISABLED` / server
 * `allowNewUsers` gate: a method that is off routes new users through the
 * same invite-required path (invites remain a break-glass path).
 *
 * Set e.g. REGISTRATION_PASSWORD_ENABLED=false and
 * REGISTRATION_SOCIAL_ENABLED=false to allow new accounts only via OIDC.
 */
type RegistrationMethod = 'password' | 'oidc' | 'social';

const REGISTRATION_METHOD_ENV: Record<RegistrationMethod, string> = {
  password: 'REGISTRATION_PASSWORD_ENABLED',
  oidc: 'REGISTRATION_OIDC_ENABLED',
  social: 'REGISTRATION_SOCIAL_ENABLED'
};

const isRegistrationMethodEnabled = (method: RegistrationMethod) =>
  process.env[REGISTRATION_METHOD_ENV[method]] !== 'false';

if (IS_PRODUCTION) {
  if (!PULSE_MEDIASOUP_BIN_NAME) {
    throw new Error('PULSE_MEDIASOUP_BIN is not defined');
  }
}

export {
  BUILD_DATE,
  IS_DEVELOPMENT,
  IS_DOCKER,
  IS_PRODUCTION,
  IS_TEST,
  isRegistrationDisabled,
  isRegistrationMethodEnabled,
  SERVER_VERSION,
  PULSE_MEDIASOUP_BIN_NAME
};
