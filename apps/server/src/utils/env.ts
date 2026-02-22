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
  SERVER_VERSION,
  PULSE_MEDIASOUP_BIN_NAME
};
