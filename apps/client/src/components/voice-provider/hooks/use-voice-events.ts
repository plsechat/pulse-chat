import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { logVoice } from '@/helpers/browser-logger';
import { getTRPCClient } from '@/lib/trpc';
import type { TRemoteUserStreamKinds } from '@/types';
import { StreamKind } from '@pulse/shared';
import type { RtpCapabilities } from 'mediasoup-client/types';
import { useEffect, useRef } from 'react';

type TEvents = {
  consume: (
    remoteId: number,
    kind: StreamKind,
    routerRtpCapabilities: RtpCapabilities
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
  rtpCapabilities: RtpCapabilities;
};

const useVoiceEvents = ({
  consume,
  removeRemoteUserStream,
  removeExternalStreamTrack,
  removeExternalStream,
  clearRemoteUserStreamsForUser,
  rtpCapabilities
}: TEvents) => {
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const ownUserId = useOwnUserId();

  // Use refs for values needed inside subscription callbacks so they always
  // reflect the latest state without causing the effect to re-run.
  // This prevents voice event subscriptions from being torn down/recreated
  // during server navigation or other state changes.
  const channelIdRef = useRef(currentVoiceChannelId);
  const ownUserIdRef = useRef(ownUserId);
  const consumeRef = useRef(consume);
  const removeRemoteUserStreamRef = useRef(removeRemoteUserStream);
  const removeExternalStreamTrackRef = useRef(removeExternalStreamTrack);
  const removeExternalStreamRef = useRef(removeExternalStream);
  const clearRemoteUserStreamsForUserRef = useRef(clearRemoteUserStreamsForUser);
  const rtpCapabilitiesRef = useRef(rtpCapabilities);

  useEffect(() => {
    channelIdRef.current = currentVoiceChannelId;
  }, [currentVoiceChannelId]);

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
    rtpCapabilitiesRef.current = rtpCapabilities;
  }, [rtpCapabilities]);

  // Only re-subscribe when currentVoiceChannelId changes (join/leave voice).
  // All other values are accessed via refs inside callbacks.
  useEffect(() => {
    if (!currentVoiceChannelId) {
      logVoice('Voice events not initialized - missing channelId');
      return;
    }

    const trpc = getTRPCClient();

    let isCleaningUp = false;

    logVoice('Subscribing to voice events', {
      channelId: currentVoiceChannelId
    });

    const onVoiceNewProducerSub = trpc.voice.onNewProducer.subscribe(
      undefined,
      {
        onData: ({ remoteId, kind, channelId }) => {
          if (channelIdRef.current !== channelId || isCleaningUp) return;

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

          try {
            consumeRef.current(remoteId, kind, rtpCapabilitiesRef.current);
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
        onData: ({ channelId, remoteId, kind }) => {
          if (channelIdRef.current !== channelId || isCleaningUp) return;

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
      onData: ({ channelId, userId }) => {
        if (channelIdRef.current !== channelId || isCleaningUp) return;

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
        onData: ({ channelId, streamId }) => {
          if (channelIdRef.current !== channelId || isCleaningUp) return;

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
