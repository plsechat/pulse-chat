import z from "zod";
import { NAME_STYLE_EFFECTS, NAME_STYLE_FONTS } from "./statics/index";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Styled display name (users.nameStyle, HOME surfaces only). The exact
 * shape is stored verbatim as jsonb, so it is validated with this schema
 * both on equip (users.setNameStyle) and on federation receive — a peer
 * instance's word isn't trusted.
 */
export const nameStyleSchema = z.strictObject({
  font: z.enum(NAME_STYLE_FONTS).optional(),
  effect: z.enum(NAME_STYLE_EFFECTS),
  color: z.string().regex(HEX_COLOR),
  // Second color, used by the 'gradient' and 'pop' effects.
  color2: z.string().regex(HEX_COLOR).optional(),
});

export type TNameStyle = z.infer<typeof nameStyleSchema>;
