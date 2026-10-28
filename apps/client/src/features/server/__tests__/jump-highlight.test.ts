/**
 * A jump's highlight is UI intent, not part of the server snapshot: the
 * keep-voice reset that follows a DM → server switch must carry it, and
 * only a full disconnect reset drops it.
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { describe, expect, test } from 'bun:test';
import { clearHighlightIfStill } from '@/features/server/channels/actions';
import { serverSliceActions, serverSliceReducer as reducer } from '@/features/server/slice';
import { store } from '@/features/store';

describe('jump highlight across resets', () => {
  test('resetStateKeepVoice keeps the highlighted message id', () => {
    let state = reducer(undefined, { type: '@@init' });
    state = reducer(state, serverSliceActions.setHighlightedMessageId(42));
    expect(state.highlightedMessageId).toBe(42);
    state = reducer(state, serverSliceActions.resetStateKeepVoice());
    expect(state.highlightedMessageId).toBe(42);
  });

  test('resetState (a disconnect) drops it', () => {
    let state = reducer(undefined, { type: '@@init' });
    state = reducer(state, serverSliceActions.setHighlightedMessageId(42));
    state = reducer(state, serverSliceActions.resetState());
    expect(state.highlightedMessageId).toBeUndefined();
  });
});

describe('clearHighlightIfStill', () => {
  test('a flash timer ends only the highlight it set', () => {
    store.dispatch(serverSliceActions.setHighlightedMessageId(7));
    // The earlier jump's timer fires after a newer jump moved the highlight on.
    clearHighlightIfStill(8);
    expect(store.getState().server.highlightedMessageId).toBe(7);
    clearHighlightIfStill(7);
    expect(store.getState().server.highlightedMessageId).toBeUndefined();
  });
});
