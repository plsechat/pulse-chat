import type { TPluginPackageJson } from '@pulse/shared';
import { z } from 'zod';
import type { GuardedAgainst } from '../utils/schema-guard';

/**
 * Validates a plugin's package.json before the loader touches its entry
 * file. The shape is @pulse/shared's TPluginPackageJson, written by hand
 * there so the shared package (bundled into the client, vendored by
 * plugin authors) carries no validator; GuardedAgainst fails the build
 * if the two drift apart.
 */
const schema = z.object({
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9-.]+)?$/, 'Invalid version format'),
  name: z.string().min(1, 'Package name is required'),
  pulse: z.object({
    entry: z.string().endsWith('.js', 'Plugin entry file must be a .js file'),
    // Semver range of @pulse/plugin-sdk the plugin was written against.
    // Optional for one release; the server refuses to load a plugin whose
    // range the running SDK version does not satisfy.
    sdk: z.string().min(1).optional(),
    author: z.string().min(1, 'Plugin author is required'),
    homepage: z.url().optional(),
    description: z.string().min(1, 'Plugin description is required'),
    logo: z.string().optional(),
    // Elevated powers the plugin asks for (TPluginCapability). A small
    // closed list: an unknown name is a manifest error, not a silent
    // no-op, so a typo cannot ship a plugin that believes it may
    // moderate when it may not.
    capabilities: z
      .array(z.enum(['moderate-messages']))
      .max(8)
      .optional()
  })
});

export const zPluginPackageJson: GuardedAgainst<
  typeof schema,
  TPluginPackageJson
> = schema;
