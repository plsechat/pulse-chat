import type { TMessageMetadata } from "../types";

/**
 * A plugin's structured card state on a message: one `metadata` entry
 * of this media type per plugin, next to the link previews and the
 * persona entry. The server writes it from `actions.messages.post` /
 * `edit({ metadata })`; the client reads it to render a card instead
 * of a preview; the preview pipeline keeps it when it rewrites the
 * column.
 */
export const PLUGIN_DATA_MEDIA_TYPE = "plugin-data";

/** The persona entry a webhook or a plugin post rides on. */
export const PERSONA_MEDIA_TYPE = "webhook";

/** Whether an entry is something the preview renderer should draw. */
export const isLinkPreviewEntry = (entry: TMessageMetadata): boolean =>
  entry.mediaType !== PERSONA_MEDIA_TYPE &&
  entry.mediaType !== PLUGIN_DATA_MEDIA_TYPE;

/** The data `pluginId` attached to the message, if any. */
export const pluginMessageData = (
  metadata: TMessageMetadata[] | null | undefined,
  pluginId: string,
): Record<string, unknown> | undefined => {
  if (!metadata) return undefined;
  const entry = metadata.find(
    (m) => m.mediaType === PLUGIN_DATA_MEDIA_TYPE && m.pluginId === pluginId,
  );
  return entry?.data && typeof entry.data === "object" ? entry.data : undefined;
};

/** The entry that stores `data` for `pluginId`. */
export const pluginDataEntry = (
  pluginId: string,
  data: Record<string, unknown>,
): TMessageMetadata => ({
  url: "",
  mediaType: PLUGIN_DATA_MEDIA_TYPE,
  pluginId,
  data,
});
