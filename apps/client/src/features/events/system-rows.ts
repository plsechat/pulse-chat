/**
 * The planner's system rows. The server posts a `type: 'system'` row
 * whose content is a small JSON document: the RSVP card when an event
 * is announced in a channel and a summary once it ended. The client
 * recognises exactly those two shapes; anything else is not a planner
 * row and falls through to the other system renderers.
 */
export type TEventSystemRow =
  | { kind: 'event'; eventId: number }
  | { kind: 'event-summary'; eventId: number; attended: number };

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

export const parseEventSystemRow = (
  content: string | null | undefined
): TEventSystemRow | null => {
  if (!content || content[0] !== '{') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (!isPositiveInt(row.eventId)) return null;
  if (row.kind === 'event') return { kind: 'event', eventId: row.eventId };
  if (row.kind === 'event-summary') {
    const attended =
      typeof row.attended === 'number' && Number.isFinite(row.attended)
        ? Math.max(0, Math.floor(row.attended))
        : 0;
    return { kind: 'event-summary', eventId: row.eventId, attended };
  }
  return null;
};
