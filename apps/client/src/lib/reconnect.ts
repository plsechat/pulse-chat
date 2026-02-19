import {
  setConnected,
  setReconnecting,
  setReconnectAttempt,
  setDisconnectInfo,
  connect
} from '@/features/server/actions';
import { loadFederatedServers } from '@/features/app/actions';
import { store } from '@/features/store';
import { getAccessToken } from '@/lib/supabase';
import { DisconnectCode } from '@pulse/shared';

const MAX_ATTEMPTS = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attemptCount = 0;
let isReconnecting = false;

/** Whether the disconnect code is non-recoverable (user was kicked/banned). */
const isNonRecoverable = (code: number) =>
  code === DisconnectCode.KICKED || code === DisconnectCode.BANNED;

/** Exponential backoff with jitter: base * 2^attempt + random jitter, capped. */
const getDelay = (attempt: number) => {
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * BASE_DELAY_MS;
  return Math.min(exponential + jitter, MAX_DELAY_MS);
};

const attemptReconnect = async () => {
  if (!isReconnecting) return;

  // Don't attempt reconnection without a valid auth token — this would just
  // spam the server with UNAUTHORIZED errors and get rejected every time.
  const token = await getAccessToken();
  if (!token) {
    console.warn('[reconnect] no access token, stopping reconnection');
    stopReconnecting();
    setConnected(false);
    setDisconnectInfo({
      code: DisconnectCode.UNEXPECTED,
      reason: 'Session expired. Please sign in again.',
      wasClean: false,
      time: new Date()
    });
    return;
  }

  attemptCount++;
  setReconnectAttempt(attemptCount);

  console.log(
    `[reconnect] attempt ${attemptCount}/${MAX_ATTEMPTS}`
  );

  try {
    await connect();

    // Re-establish federated connections
    loadFederatedServers();

    // Success — clear reconnecting state
    console.log('[reconnect] reconnected successfully');
    stopReconnecting();
  } catch (error) {
    console.warn('[reconnect] attempt failed:', error);

    if (attemptCount >= MAX_ATTEMPTS) {
      console.error('[reconnect] max attempts reached, giving up');
      stopReconnecting();
      setConnected(false);
      setDisconnectInfo({
        code: DisconnectCode.UNEXPECTED,
        reason: 'Failed to reconnect after multiple attempts.',
        wasClean: false,
        time: new Date()
      });
      return;
    }

    // Schedule next attempt
    const delay = getDelay(attemptCount);
    console.log(`[reconnect] retrying in ${Math.round(delay)}ms`);
    reconnectTimer = setTimeout(attemptReconnect, delay);
  }
};

/** Start the reconnection loop. Called from onClose when the disconnect is recoverable. */
export const startReconnecting = (closeCode: number) => {
  if (isNonRecoverable(closeCode)) return;
  if (isReconnecting) return;

  // Don't reconnect if we're not logged in (no session to resume)
  const state = store.getState();
  if (!state.server.info) return;

  isReconnecting = true;
  attemptCount = 0;
  setReconnecting(true);
  setConnected(false);

  // First attempt after a short delay to let the socket fully close
  const delay = getDelay(0);
  reconnectTimer = setTimeout(attemptReconnect, delay);

  // Also listen for browser coming back online
  window.addEventListener('online', onOnline);
};

/** Stop reconnecting (either success or gave up). */
export const stopReconnecting = () => {
  isReconnecting = false;
  attemptCount = 0;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  setReconnecting(false);
  window.removeEventListener('online', onOnline);
};

/** When the browser comes back online, try immediately. */
const onOnline = () => {
  if (!isReconnecting) return;

  console.log('[reconnect] browser came online, trying immediately');
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  attemptReconnect();
};

/** Check if we're currently in a reconnection loop. */
export const isCurrentlyReconnecting = () => isReconnecting;
