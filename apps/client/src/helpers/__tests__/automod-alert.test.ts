/**
 * Auto-Mod alert rows are recognised by their server-generated shape
 * and the locked flag, and rendered as system messages (B2 carry-over).
 *
 * Run via: bun test apps/client/src/helpers/__tests__/automod-alert.test.ts
 */
import { describe, expect, test } from 'bun:test';
import {
  isAutomodAlert,
  isSystemLikeMessage,
  parseAutomodAlert
} from '../automod-alert';

const alert = '[Auto-Mod] Rule "No links" blocked a message from <@42> in <#7>';

describe('parseAutomodAlert', () => {
  test('extracts rule, offender and channel from the server shape', () => {
    expect(parseAutomodAlert(alert)).toEqual({
      ruleName: 'No links',
      offenderId: 42,
      channelId: 7
    });
  });

  test('rejects anything that is not exactly the alert shape', () => {
    expect(parseAutomodAlert(null)).toBeNull();
    expect(parseAutomodAlert('hello')).toBeNull();
    expect(parseAutomodAlert(`${alert} and more`)).toBeNull();
    expect(parseAutomodAlert('[Auto-Mod] Rule "x" blocked a message')).toBeNull();
  });
});

describe('isAutomodAlert / isSystemLikeMessage', () => {
  test('only locked rows count — a member typing the text is a normal message', () => {
    expect(isAutomodAlert({ type: 'user', editable: false, content: alert })).toBe(true);
    expect(isAutomodAlert({ type: 'user', editable: true, content: alert })).toBe(false);
    expect(isAutomodAlert({ type: 'user', editable: undefined, content: alert })).toBe(false);
  });

  test('system rows stay system rows; alerts join them', () => {
    expect(isSystemLikeMessage({ type: 'system', content: 'identity_reset' })).toBe(true);
    expect(isSystemLikeMessage({ type: 'user', editable: false, content: alert })).toBe(true);
    expect(isSystemLikeMessage({ type: 'user', editable: true, content: 'hi' })).toBe(false);
  });
});
