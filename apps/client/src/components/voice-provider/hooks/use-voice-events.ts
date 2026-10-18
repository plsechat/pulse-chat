import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { logVoice } from '@/helpers/browser-logger';
import { getVoiceTRPCClient } from '@/lib/trpc';
import type { TRemoteUserStreamKinds } from '@/types';
import { StreamKind } from '@pulse/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import type { IRootState } from '@/features/store';

type TEvents = {
  consume: (
    remoteId: number,
    kind: StreamKind,
    deviceRtpCapabilities: RtpCapabilities
  ) => Promise<void>;
  removeRemoteUserStream: (
    userId: number,
    kind: TRemoteUserStreamKinds
  ) => void;
  removeExternalStreamTrack: (
    streamId: number,
    kind: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO
  ) => void;
  removeExternalStream: (streamId: number) => void;
  clearRemoteUserStreamsForUser: (userId: number) => void;
  /**
   * The loaded Device's capabilities (what this browser can decode), read
   * at event time — the Device only exists once init has run, which is
   * after the first render that mounts this hook.
   */
  getDeviceRtpCapabilities: () => RtpCapabilities | null;
};

/** The room kinds a roster payload may name. */
const isRoomKind = (value: unknown): value is 'channel' | 'dm' =>
  value === 'channel' || value === 'dm';

/**
 * A payload for the session we are in. The numeric id spaces of server
 * channels and DM calls overlap; a payload that names its ROOM kind must
 * match ours. Only 'channel' / 'dm' count as a room kind: the producer
 * events reuse the field name `kind` for the stream kind (audio, video,
 * screen …), and the server already scopes those to the room through
 * the runtime-keyed topic, so for them only the channel id is compared.
 * A payload with no room kind (an older server) is taken as-is.
 */
const isForCurrentSession = (
  payload: { channelId: number; kind?: unknown },
  channelId: number | undefined,
  kind: string | undefined
) =>
  payload.channelId === channelId &&
  (!isRoomKind(payload.kind) || payload.kind === kind);

const useVoiceEvents = ({
  consume,
  removeRemoteUserStream,
  removeExternalStreamTrack,
  removeExternalStream,
  clearRemoteUserStreamsForUser,
  getDeviceRtpCapabilities
}: TEvents) => {
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const currentVoiceKind = useSelector(
    (state: IRootState) => state.server.currentVoiceKind
  );
  const ownUserId = useOwnUserId();

  // Use refs for values needed inside subscription callbacks so they always
  // reflect the latest state without causing the effect to re-run.
  // This prevents voice event subscriptions from being torn down/recreated
  // during server navigation or other state changes.
  const channelIdRef = useRef(currentVoiceChannelId);
  const kindRef = useRef(currentVoiceKind);
  const ownUserIdRef = useRef(ownUserId);
  const consumeRef = useRef(consume);
  const removeRemoteUserStreamRef = useRef(removeRemoteUserStream);
  const removeExternalStreamTrackRef = useRef(removeExternalStreamTrack);
  const removeExternalStreamRef = useRef(removeExternalStream);
  const clearRemoteUserStreamsForUserRef = useRef(clearRemoteUserStreamsForUser);
  const getDeviceRtpCapabilitiesRef = useRef(getDeviceRtpCapabilities);

  useEffect(() => {
    channelIdRef.current = currentVoiceChannelId;
    kindRef.current = currentVoiceKind;
  }, [currentVoiceChannelId, currentVoiceKind]);

  useEffect(() => {
    ownUserIdRef.current = ownUserId;
  }, [ownUserId]);

  useEffect(() => {
    consumeRef.current = consume;
  }, [consume]);

  useEffect(() => {
    removeRemoteUserStreamRef.current = removeRemoteUserStream;
  }, [removeRemoteUserStream]);

  useEffect(() => {
    removeExternalStreamTrackRef.current = removeExternalStreamTrack;
  }, [removeExternalStreamTrack]);

  useEffect(() => {
    removeExternalStreamRef.current = removeExternalStream;
  }, [removeExternalStream]);

  useEffect(() => {
    clearRemoteUserStreamsForUserRef.current = clearRemoteUserStreamsForUser;
  }, [clearRemoteUserStreamsForUser]);

  useEffect(() => {
    getDeviceRtpCapabilitiesRef.current = getDeviceRtpCapabilities;
  }, [getDeviceRtpCapabilities]);

  // Only re-subscribe when currentVoiceChannelId changes (join/leave voice).
  // All other values are accessed via refs inside callbacks.
  useEffect(() => {
    if (!currentVoiceChannelId) {
      logVoice('Voice events not initialized - missing channelId');
      return;
    }

    // The session's hosting instance, pinned at join — never the instance
    // in focus, which the user can change mid-call.
    const trpc = getVoiceTRPCClient();
    if (!trpc) return;

    let isCleaningUp = false;

    logVoice('Subscribing to voice events', {
      channelId: currentVoiceChannelId
    });

    const onVoiceNewProducerSub = trpc.voice.onNewProducer.subscribe(
      undefined,
      {
        onData: (payload) => {
          const { remoteId, kind, channelId } = payload;
          if (
            !isForCurrentSession(payload, channelIdRef.current, kindRef.current) ||
            isCleaningUp
          ) {
            return;
          }

          if (remoteId === ownUserIdRef.current) {
            logVoice('Ignoring own producer event', {
              remoteId,
              ownUserId: ownUserIdRef.current,
              kind,
              channelId
            });

            return;
          }

          logVoice('New producer event received', {
            remoteId,
            kind,
            channelId
          });

          const deviceRtpCapabilities = getDeviceRtpCapabilitiesRef.current();
          if (!deviceRtpCapabilities) {
            logVoice('New producer event before the device was loaded', {
              remoteId,
              kind
            });
            return;
          }

          try {
            consumeRef.current(remoteId, kind, deviceRtpCapabilities);
          } catch (error) {
            logVoice('Error consuming new producer', {
              error,
              remoteId,
              kind,
              channelId
            });
          }
        },
        onError: (error) => {
          logVoice('onVoiceNewProducer subscription error', { error });
        }
      }
    );

    const onVoiceProducerClosedSub = trpc.voice.onProducerClosed.subscribe(
      undefined,
      {
        onData: (payload) => {
          const { channelId, remoteId, kind } = payload;
          if (
            !isForCurrentSession(payload, channelIdRef.current, kindRef.current) ||
            isCleaningUp
          ) {
            return;
          }

          logVoice('Producer closed event received', {
            remoteId,
            kind,
            channelId
          });

          try {
            if (
              kind === StreamKind.EXTERNAL_VIDEO ||
              kind === StreamKind.EXTERNAL_AUDIO
            ) {
              removeExternalStreamTrackRef.current(remoteId, kind);
            } else {
              removeRemoteUserStreamRef.current(remoteId, kind);
            }
          } catch (error) {
            logVoice('Error removing remote stream for closed producer', {
              error,
              remoteId,
              kind,
              channelId
            });
          }
        },
        onError: (error) => {
          logVoice('onVoiceProducerClosed subscription error', { error });
        }
      }
    );

    const onVoiceUserLeaveSub = trpc.voice.onLeave.subscribe(undefined, {
      onData: (payload) => {
        const { channelId, userId } = payload;
        if (
          !isForCurrentSession(payload, channelIdRef.current, kindRef.current) ||
          isCleaningUp
        ) {
          return;
        }

        logVoice('User leave event received', { userId, channelId });

        try {
          clearRemoteUserStreamsForUserRef.current(userId);
        } catch (error) {
          logVoice('Error clearing remote streams for user', { error });
        }
      },
      onError: (error) => {
        logVoice('onVoiceUserLeave subscription error', { error });
      }
    });

    const onVoiceRemoveExternalStreamSub =
      trpc.voice.onRemoveExternalStream.subscribe(undefined, {
        onData: (payload) => {
          const { channelId, streamId } = payload;
          if (
            !isForCurrentSession(payload, channelIdRef.current, kindRef.current) ||
            isCleaningUp
          ) {
            return;
          }

          logVoice('External stream removed event received', {
            streamId,
            channelId
          });

          try {
            removeExternalStreamRef.current(streamId);
          } catch (error) {
            logVoice('Error removing external stream', {
              error,
              streamId,
              channelId
            });
          }
        },
        onError: (error) => {
          logVoice('onVoiceRemoveExternalStream subscription error', { error });
        }
      });

    return () => {
      logVoice('Cleaning up voice events');

      isCleaningUp = true;

      onVoiceNewProducerSub.unsubscribe();
      onVoiceProducerClosedSub.unsubscribe();
      onVoiceUserLeaveSub.unsubscribe();
      onVoiceRemoveExternalStreamSub.unsubscribe();
    };
  }, [currentVoiceChannelId]);
};

export { useVoiceEvents };

export const __testing = { isForCurrentSession };
