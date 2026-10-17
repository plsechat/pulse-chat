/**
 * Embeds as plain text. A bot on an external chat service posts its
 * status cards as embeds — a title, a description, a few "name: value"
 * fields, a footer — with no message body at all. The community import
 * and the bridge plugin both turn such a message into one of ours, and
 * both used to keep only the embed's url and title, so a status channel
 * arrived empty. This helper is the one rendering they share; nothing
 * here touches the network, so every rule has a direct unit test.
 *
 * Media embeds (a GIF from the picker, a pasted image) are not text:
 * `pickEmbedMedia` names the file a caller can re-host as an attachment,
 * from the small set of hosts the pickers publish on, and the caller
 * leaves such an embed out of the text rendering once it is re-hosted.
 */

export type TEmbedMedia = {
  url?: string;
  proxy_url?: string;
  width?: number;
  height?: number;
  content_type?: string;
};

export type TEmbedField = { name?: string; value?: string };

/** The slice of an embed object both services' APIs agree on. */
export type TEmbedLike = {
  /** rich, image, video, gifv, article, link … */
  type?: string;
  title?: string;
  description?: string;
  url?: string;
  fields?: TEmbedField[];
  footer?: { text?: string } | null;
  image?: TEmbedMedia | null;
  thumbnail?: TEmbedMedia | null;
  video?: TEmbedMedia | null;
};

const MAX_TITLE = 256;
const MAX_DESCRIPTION = 1000;
const MAX_FIELDS = 10;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 512;
const MAX_FOOTER = 256;
const MAX_URL = 2048;

const oneLine = (value: string | null | undefined, max: number): string => {
  const trimmed = (value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  return Array.from(trimmed).slice(0, max).join("").trim();
};

const block = (value: string | null | undefined, max: number): string => {
  const trimmed = (value ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, " ").trim();
  return Array.from(trimmed).slice(0, max).join("").trim();
};

const boundTotal = (text: string, bound: number): string =>
  Array.from(text).slice(0, Math.max(0, bound)).join("").trim();

/**
 * A card is what a bot or webhook composed (`rich`, the default type);
 * everything else is the service unfurling a link the author pasted —
 * its title and description belong to the page, not the author, and
 * must not be written back into the message as text.
 */
const isCard = (embed: TEmbedLike): boolean => embed.type === undefined || embed.type === "rich";

/**
 * Render embeds as lines. A card gives `title — url` (or either alone),
 * the description, up to ten `name: value` fields and the footer; an
 * unfurl gives at most its link. Embeds are separated by a blank line.
 * A url already present in `existingText` (the message body it
 * accompanies) is not repeated, so a pasted link does not show twice.
 * The whole result is capped at `bound` characters; an empty string
 * means there was nothing to say.
 */
export const renderEmbedsAsText = (
  embeds: readonly TEmbedLike[] | null | undefined,
  bound: number,
  existingText = ""
): string => {
  const blocks: string[] = [];

  for (const embed of embeds ?? []) {
    if (!embed || typeof embed !== "object") continue;

    const lines: string[] = [];
    const title = oneLine(embed.title, MAX_TITLE);
    const url = oneLine(embed.url, MAX_URL);
    const urlShown = url.length > 0 && !existingText.includes(url);

    if (!isCard(embed)) {
      if (urlShown) lines.push(title ? `${title} — ${url}` : url);
      if (lines.length > 0) blocks.push(lines.join("\n"));
      continue;
    }

    if (title && urlShown) lines.push(`${title} — ${url}`);
    else if (title) lines.push(title);
    else if (urlShown) lines.push(url);

    const description = block(embed.description, MAX_DESCRIPTION);
    if (description) lines.push(description);

    for (const field of (embed.fields ?? []).slice(0, MAX_FIELDS)) {
      if (!field || typeof field !== "object") continue;
      const name = oneLine(field.name, MAX_FIELD_NAME);
      const value = block(field.value, MAX_FIELD_VALUE);
      if (name && value) lines.push(`${name}: ${value}`);
      else if (name || value) lines.push(name || value);
    }

    const footer = oneLine(embed.footer?.text, MAX_FOOTER);
    if (footer) lines.push(footer);

    if (lines.length > 0) blocks.push(lines.join("\n"));
  }

  return boundTotal(blocks.join("\n\n"), bound);
};

/**
 * The hosts the GIF pickers publish their files on. The picker posts the
 * GIF's page link as the message and the direct file inside a `gifv`
 * embed; only files from these hosts are fetched, and the hardened
 * download paths refuse everything else regardless of what an embed
 * claims.
 */
export const GIF_PICKER_MEDIA_HOSTS: readonly string[] = [
  "media.tenor.com",
  "c.tenor.com",
  "static.klipy.com",
  "static2.klipy.com"
];

/** The service's own media proxy, which `proxy_url` points at. */
export const EMBED_PROXY_HOSTS: readonly string[] = ["media.discordapp.net", "cdn.discordapp.com"];

export type TEmbedMediaPick = {
  url: string;
  filename: string;
  mime: string;
  /** `video` for an animated picker GIF (served as mp4), `image` otherwise. */
  kind: "video" | "image";
};

const EXTENSION_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  gif: "image/gif",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp"
};

const hostOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.hostname : null;
  } catch {
    return null;
  }
};

const allowedMediaUrl = (media: TEmbedMedia | null | undefined, hosts: readonly string[]): string | null => {
  if (!media) return null;
  const direct = hostOf(media.url);
  if (direct && hosts.includes(direct)) return media.url!;
  const proxied = hostOf(media.proxy_url);
  if (proxied && EMBED_PROXY_HOSTS.includes(proxied)) return media.proxy_url!;
  return null;
};

const filenameFor = (url: string, fallbackExt: string): { filename: string; mime: string } => {
  let base = "";
  try {
    base = new URL(url).pathname.split("/").pop() ?? "";
  } catch {
    base = "";
  }
  const match = base.match(/\.([a-z0-9]{1,5})$/i);
  const ext = match ? match[1]!.toLowerCase() : fallbackExt;
  const stem = (match ? base.slice(0, -(match[0].length)) : base).replace(/[^\w.-]+/g, "").slice(0, 60) || "media";
  return { filename: `${stem}.${ext}`, mime: EXTENSION_MIME[ext] ?? (ext === fallbackExt ? EXTENSION_MIME[fallbackExt]! : "application/octet-stream") };
};

/**
 * The file worth re-hosting for a media embed, or null: a picker GIF
 * (`gifv`) is its mp4 — the thumbnail is a still frame — and an image
 * embed is its image. Any other embed type, and any file outside the
 * allowed hosts (the picker hosts plus the service's own proxy), yields
 * null so the caller falls back to the text rendering.
 */
export const pickEmbedMedia = (
  embed: TEmbedLike,
  hosts: readonly string[] = GIF_PICKER_MEDIA_HOSTS
): TEmbedMediaPick | null => {
  if (embed.type === "gifv") {
    const video = allowedMediaUrl(embed.video, hosts);
    if (video) return { url: video, kind: "video", ...filenameFor(video, "mp4") };
    const still = allowedMediaUrl(embed.thumbnail, hosts) ?? allowedMediaUrl(embed.image, hosts);
    if (still) return { url: still, kind: "image", ...filenameFor(still, "gif") };
    return null;
  }

  if (embed.type === "image") {
    const image = allowedMediaUrl(embed.image, hosts) ?? allowedMediaUrl(embed.thumbnail, hosts);
    if (image) return { url: image, kind: "image", ...filenameFor(image, "png") };
  }

  return null;
};

/**
 * True when the message body is nothing but the embed's own page link —
 * what the GIF picker posts. Once the file is re-hosted the link would
 * only duplicate it, so callers drop the body.
 */
export const isBareEmbedLink = (content: string, embed: TEmbedLike): boolean => {
  const url = oneLine(embed.url, MAX_URL);
  return url.length > 0 && content.trim() === url;
};
