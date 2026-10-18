import {
  NAME_STYLE_EFFECTS,
  NAME_STYLE_FONTS,
  type TNameStyle
} from '@pulse/shared';
import { z } from 'zod';
import type { GuardedAgainst } from './schema-guard';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Validates a styled display name (users.nameStyle) on equip
 * (users.setNameStyle) and on federation receive — a peer instance's
 * word isn't trusted. The shape itself is @pulse/shared's TNameStyle,
 * written by hand there so the client bundle carries no validator;
 * GuardedAgainst fails the build if the two drift apart.
 */
const schema = z.strictObject({
  font: z.enum(NAME_STYLE_FONTS).optional(),
  effect: z.enum(NAME_STYLE_EFFECTS),
  color: z.string().regex(HEX_COLOR),
  // Second color, used by the 'gradient' and 'pop' effects.
  color2: z.string().regex(HEX_COLOR).optional()
});

export const nameStyleSchema: GuardedAgainst<typeof schema, TNameStyle> =
  schema;
