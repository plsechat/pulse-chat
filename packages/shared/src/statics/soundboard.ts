/**
 * Soundboard bounds — one definition for the upload form, the add/update
 * routes and the play route. A clip is a short stab (the server has no
 * decoder, so the LENGTH is the client's check before upload; the SIZE
 * is the server's hard stop), a server keeps a small shelf of them, and
 * the play route rate-limits so a room cannot be spammed.
 */
export const SOUND_NAME_MAX_LENGTH = 40;
export const SOUND_EMOJI_MAX_LENGTH = 16;
export const SOUND_MAX_FILE_BYTES = 512 * 1024;
export const SOUND_MAX_DURATION_SECONDS = 5;
export const SOUNDS_PER_SERVER_MAX = 50;
/** One trigger per user every 2 s; ten per room per minute. */
export const SOUND_USER_COOLDOWN_MS = 2_000;
export const SOUND_ROOM_WINDOW_MS = 60_000;
export const SOUND_ROOM_MAX_PER_WINDOW = 10;
