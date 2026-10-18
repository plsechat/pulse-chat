/**
 * Attachment caps shared by the server routes and the composers. Each id
 * in the list is a `saveFile` on the server (disk + DB work), so the
 * arrays are capped; the client enforces the same number up front so a
 * user learns the limit while picking files, not from a rejected submit.
 */
export const MAX_FILES_PER_MESSAGE = 10;
export const MAX_FILES_PER_POST = 10;
