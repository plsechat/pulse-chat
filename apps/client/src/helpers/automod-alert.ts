/**
 * Auto-Mod `alert_channel` rows are server-generated (utils/automod.ts
 * postAlert): posted under the rule author's id, locked (`editable:
 * false`) and in one fixed shape. The client recognises that shape and
 * renders the row as a system message — a centered notice — instead
 * of a chat bubble that looks like the moderator typed it.
 */
export type TAutomodAlert = {
  ruleName: string;
  /** The member whose message was blocked. */
  offenderId: number;
  /** The channel the blocked message was sent to. */
  channelId: number;
};

const ALERT_PATTERN =
  /^\[Auto-Mod\] Rule "(.+)" blocked a message from <@(\d+)> in <#(\d+)>$/;

type TMessageLike = {
  type?: string | null;
  content?: string | null;
  editable?: boolean | null;
};

export const parseAutomodAlert = (
  content: string | null | undefined
): TAutomodAlert | null => {
  if (!content) return null;
  const match = ALERT_PATTERN.exec(content);
  if (!match) return null;
  return {
    ruleName: match[1]!,
    offenderId: Number(match[2]),
    channelId: Number(match[3])
  };
};

/**
 * Locked rows in the alert shape — only the server writes those. Newer
 * servers mark them `type: 'system'`; older rows are plain locked
 * messages, so the type is not required.
 */
export const isAutomodAlert = (message: TMessageLike): boolean =>
  message.editable === false &&
  parseAutomodAlert(message.content) !== null;

/**
 * Rows the chat renders standalone through `SystemMessage`: real
 * system rows (identity resets) and Auto-Mod alerts.
 */
export const isSystemLikeMessage = (message: TMessageLike): boolean =>
  message.type === 'system' || isAutomodAlert(message);
