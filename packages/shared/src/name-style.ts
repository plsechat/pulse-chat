import type { NAME_STYLE_EFFECTS, NAME_STYLE_FONTS } from "./statics/index";

export type TNameStyleFont = (typeof NAME_STYLE_FONTS)[number];
export type TNameStyleEffect = (typeof NAME_STYLE_EFFECTS)[number];

/**
 * Styled display name (users.nameStyle, HOME surfaces only). The exact
 * shape is stored verbatim as jsonb, so it is validated on equip
 * (users.setNameStyle) and on federation receive — a peer instance's
 * word isn't trusted. The validating schema lives in the server
 * (utils/name-style-schema.ts there) and is type-checked against
 * this type: shared stays free of zod because the client
 * bundles it and only ever reads the shape.
 */
export type TNameStyle = {
  font?: TNameStyleFont;
  effect: TNameStyleEffect;
  /** `#rrggbb` */
  color: string;
  /** Second `#rrggbb`, used by the 'gradient' and 'pop' effects. */
  color2?: TNameStyle["color"];
};
