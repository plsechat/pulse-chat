import type { TPluginSecretSettingValue } from '@pulse/shared';

/** Whether the settings route reports a value for a `secret` setting — it never reports the value itself. */
const secretIsSet = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  (value as TPluginSecretSettingValue).set === true;

export { secretIsSet };
