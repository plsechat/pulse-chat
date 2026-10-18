import { describe, expect, test } from 'bun:test';
import { failedCommandReply } from '../command-reply';

const card = (status: string, response?: string) =>
  `<command data-plugin-id="watch-together" data-command="watch" data-args='[]' data-status='${status}'${
    response === undefined ? '' : ` data-response='${response}'`
  }></command>`;

describe('failedCommandReply', () => {
  test('returns the reply of a failed command', () => {
    expect(failedCommandReply(card('failed', 'Join a voice channel first, then run /watch there.'))).toBe(
      'Join a voice channel first, then run /watch there.'
    );
  });

  test('is null for pending, completed, plain messages and empty replies', () => {
    expect(failedCommandReply(card('pending'))).toBeNull();
    expect(failedCommandReply(card('completed', 'Playing for everyone'))).toBeNull();
    expect(failedCommandReply(card('failed', '   '))).toBeNull();
    expect(failedCommandReply('<p>/watch is not a command here</p>')).toBeNull();
    expect(failedCommandReply(null)).toBeNull();
  });

  test('bounds a long reply', () => {
    expect(failedCommandReply(card('failed', 'x'.repeat(900)))!.length).toBe(500);
  });
});
