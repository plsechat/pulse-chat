/**
 * The planner's system rows are recognised by their exact JSON shape;
 * anything else is left to the other system-row renderers.
 *
 * Run via: bun test apps/client/src/features/events/__tests__/system-rows.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { parseEventSystemRow } from '../system-rows';

describe('parseEventSystemRow', () => {
  test('the RSVP card row', () => {
    expect(parseEventSystemRow('{"kind":"event","eventId":12}')).toEqual({
      kind: 'event',
      eventId: 12
    });
  });

  test('the summary row, attended floored at zero', () => {
    expect(
      parseEventSystemRow('{"kind":"event-summary","eventId":3,"attended":7}')
    ).toEqual({
      kind: 'event-summary',
      eventId: 3,
      attended: 7
    });
    expect(
      parseEventSystemRow('{"kind":"event-summary","eventId":3}')?.kind
    ).toBe('event-summary');
    expect(
      parseEventSystemRow('{"kind":"event-summary","eventId":3,"attended":-2}')
    ).toMatchObject({ attended: 0 });
  });

  test('rejects other content', () => {
    expect(parseEventSystemRow(null)).toBeNull();
    expect(parseEventSystemRow('')).toBeNull();
    expect(parseEventSystemRow('identity_reset')).toBeNull();
    expect(parseEventSystemRow('{not json')).toBeNull();
    expect(parseEventSystemRow('{"kind":"event"}')).toBeNull();
    expect(parseEventSystemRow('{"kind":"event","eventId":"12"}')).toBeNull();
    expect(parseEventSystemRow('{"kind":"event","eventId":0}')).toBeNull();
    expect(parseEventSystemRow('{"kind":"poll","eventId":1}')).toBeNull();
    expect(parseEventSystemRow('[1,2]')).toBeNull();
  });
});
