import { z } from 'zod';

/**
 * Input bounds shared by the plugins router. Plugin ids are directory
 * names under PLUGINS_PATH and command/setting keys are identifiers the
 * plugin registered — none of them is ever legitimately long, and every
 * one of them is user-supplied (Bun is single-threaded; unbounded input
 * is a DoS lever).
 */
const MAX_PLUGIN_ID_LENGTH = 64;
const MAX_COMMAND_NAME_LENGTH = 64;
const MAX_SETTING_KEY_LENGTH = 64;
const MAX_ARG_KEYS = 32;
const MAX_ARG_KEY_LENGTH = 64;
const MAX_STRING_VALUE_LENGTH = 4096;

const pluginIdSchema = z.string().min(1).max(MAX_PLUGIN_ID_LENGTH);
const commandNameSchema = z.string().min(1).max(MAX_COMMAND_NAME_LENGTH);
const settingKeySchema = z.string().min(1).max(MAX_SETTING_KEY_LENGTH);
// `null` clears a `secret` setting (the loader refuses it for any other type).
const settingValueSchema = z.union([
  z.string().max(MAX_STRING_VALUE_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null()
]);

const commandArgsSchema = z
  .record(
    z.string().max(MAX_ARG_KEY_LENGTH),
    z.union([
      z.string().max(MAX_STRING_VALUE_LENGTH),
      z.number().finite(),
      z.boolean(),
      z.null()
    ])
  )
  .refine((args) => Object.keys(args).length <= MAX_ARG_KEYS, {
    message: `At most ${MAX_ARG_KEYS} command arguments are allowed`
  });

export {
  commandArgsSchema,
  commandNameSchema,
  pluginIdSchema,
  settingKeySchema,
  settingValueSchema
};
