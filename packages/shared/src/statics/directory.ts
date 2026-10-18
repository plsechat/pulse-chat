/**
 * Public directory card copy limits — one definition for the opt-in
 * form, the opt-in route and the bound applied to a peer's listing.
 */
export const DIRECTORY_DESCRIPTION_MAX_LENGTH = 300;
export const DIRECTORY_TAGS_MAX = 5;
export const DIRECTORY_TAG_MAX_LENGTH = 24;
/**
 * What a tag may be made of: letters and digits of any script, spaces,
 * underscores and hyphens. Tags are stored without a leading `#` and
 * shown with one, so the character itself is not allowed.
 */
export const DIRECTORY_TAG_PATTERN = /^[\p{L}\p{N} _-]+$/u;
export const DIRECTORY_GAME_MAX_LENGTH = 60;
/** The longest Directory search the server accepts. */
export const DIRECTORY_SEARCH_MAX_LENGTH = 64;
