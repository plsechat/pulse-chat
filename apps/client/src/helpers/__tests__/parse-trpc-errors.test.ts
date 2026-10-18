/**
 * Server validation errors reach the client as a TRPCClientError whose
 * message is a JSON array of Zod-style issues; these helpers turn that
 * into per-field messages (forms) or one toast line.
 *
 * Run via: bun test apps/client/src/helpers/__tests__/parse-trpc-errors.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { TRPCClientError } from '@trpc/client';
import { getTrpcError, parseTrpcErrors } from '../parse-trpc-errors';

const issues = (list: { path?: string[]; message: string }[]) =>
  new TRPCClientError(
    JSON.stringify(list.map((i) => ({ code: 'custom', path: i.path ?? [], ...i })))
  );

describe('parseTrpcErrors', () => {
  test('maps each issue to its first path segment', () => {
    expect(
      parseTrpcErrors(
        issues([
          { path: ['name'], message: 'Name is required' },
          { path: ['email', 'domain'], message: 'Bad domain' }
        ])
      )
    ).toEqual({ name: 'Name is required', email: 'Bad domain' });
  });

  test('an issue without a path lands on _general', () => {
    expect(parseTrpcErrors(issues([{ message: 'Nope' }]))).toEqual({ _general: 'Nope' });
  });

  test('a later issue for the same field wins', () => {
    expect(
      parseTrpcErrors(issues([{ path: ['a'], message: 'first' }, { path: ['a'], message: 'second' }]))
    ).toEqual({ a: 'second' });
  });

  test('a non-JSON tRPC message is the general error', () => {
    expect(parseTrpcErrors(new TRPCClientError('UNAUTHORIZED'))).toEqual({
      _general: 'UNAUTHORIZED'
    });
  });

  test('a plain object is passed through as the errors map', () => {
    expect(parseTrpcErrors({ name: 'taken' })).toEqual({ name: 'taken' });
  });

  test('anything else is the generic message', () => {
    expect(parseTrpcErrors('boom')).toEqual({
      _general: 'Something went wrong, please try again.'
    });
    expect(parseTrpcErrors(undefined)).toEqual({
      _general: 'Something went wrong, please try again.'
    });
  });
});

describe('getTrpcError', () => {
  test('returns the first issue message of a Zod-style array', () => {
    expect(
      getTrpcError(issues([{ path: ['automod'], message: 'Blocked by automod' }, { message: 'x' }]), 'fallback')
    ).toBe('Blocked by automod');
  });

  test('returns the raw message when it is not an issues array', () => {
    expect(getTrpcError(new TRPCClientError('FORBIDDEN'), 'fallback')).toBe('FORBIDDEN');
    expect(getTrpcError(new Error('plain error'), 'fallback')).toBe('plain error');
    expect(getTrpcError(new Error('{"not":"an array"}'), 'fallback')).toBe('{"not":"an array"}');
    expect(getTrpcError(new Error('[{"code":"x"}]'), 'fallback')).toBe('[{"code":"x"}]');
  });

  test('falls back for non-errors and empty messages', () => {
    expect(getTrpcError('string', 'fallback')).toBe('fallback');
    expect(getTrpcError(null, 'fallback')).toBe('fallback');
    expect(getTrpcError(new Error(''), 'fallback')).toBe('fallback');
  });
});
