/**
 * Channel-name normalisation, the plugin's copy of the server's
 * (apps/server/src/routers/servers/bridge-pairing.ts). The server pairs
 * channels with it; the plugin uses it to find a remote category of the
 * same name before creating one. Both are tested against the same
 * vectors so they cannot drift apart unnoticed.
 *
 * `General Chat` → `general-chat`; accents stripped; any run of
 * punctuation or whitespace is one dash; leading/trailing dashes go.
 */
export const normalizeChannelName = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
