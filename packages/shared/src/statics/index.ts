export * from "./permissions";
export * from "./storage";
export * from "./metrics";

export const DEFAULT_MESSAGES_LIMIT = 100;

/**
 * Plaintext budget the composer enforces before sending. The server-side
 * wire cap (MAX_MESSAGE_WIRE_LENGTH) is deliberately larger because E2EE
 * clients encrypt BEFORE the server validates: pairwise libsignal DMs
 * expand to ~1.63 chars per plaintext byte (JSON-escaped binary body,
 * more on a session's first PreKey message) and sender-key channels to
 * ~4/3 plus ~130 chars of envelope, so a full-length plaintext message
 * must still fit the wire cap after encryption.
 */
export const MAX_MESSAGE_CONTENT_LENGTH = 16000;
export const MAX_MESSAGE_WIRE_LENGTH = 40000;

export const OWNER_ROLE_ID = 1;

export const TYPING_MS = 2000;

export enum DisconnectCode {
  UNEXPECTED = 1006,
  FEDERATION_REJECTED = 4003,
  KICKED = 40000,
  BANNED = 40001,
  SERVER_SHUTDOWN = 40002,
}
