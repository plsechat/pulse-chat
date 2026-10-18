import { logVoice } from '@/helpers/browser-logger';
import { getVoiceTRPCClient } from '@/lib/trpc';
import type { TRemoteUserStreamKinds } from '@/types';
import { getMediasoupKind, StreamKind } from '@pulse/shared';
import { TRPCClientError } from '@trpc/client';
// `import type` (not inline `type` members): under verbatimModuleSyntax
// an inline-type import survives as a bare side-effect import, which
// would keep mediasoup-client in the initial bundle although the
// provider only fetches it on the first voice join.
import type {
  AppData,
  Consumer,
  Device,
  RtpCapabilities,
  Transport
} from 'mediasoup-client/types';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { TTransportIceOptions } from '../media-policy';

export type TTransportType = 'producer' | 'consumer';

type TUseTransportParams = {
  addRemoteUserStream: (
    userId: number,
    stream: MediaStream,
    kind: TRemoteUserStreamKinds
  ) => void;
  removeRemoteUserStream: (
    userId: number,
    kind: TRemoteUserStreamKinds
  ) => void;
  addExternalStreamTrack: (
    streamId: number,
    stream: MediaStream,
    kind: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO
  ) => void;
  removeExternalStreamTrack: (
    streamId: number,
    kind: StreamKind.EXTERNAL_AUDIO | StreamKind.EXTERNAL_VIDEO
  ) => void;
  /**
   * ICE on a transport reached `failed` (its ICE restart on `disconnected`
   * did not recover it). The transport is already closed; the provider
   * decides whether to rebuild the session.
   */
  onTransportFailed: (type: TTransportType) => void;
};

const CONSUME_FAILURE_MESSAGE =
  "Couldn't receive a stream from the call — your browser may not support its codec";

const useTransports = ({
  addRemoteUserStream,
  removeRemoteUserStream,
  addExternalStreamTrack,
  removeExternalStreamTrack,
  onTransportFailed
}: TUseTransportParams) => {
  const producerTransport = useRef<Transport<AppData> | undefined>(undefined);
  const consumerTransport = useRef<Transport<AppData> | undefined>(undefined);
  const consumers = useRef<{
    [userId: number]: {
      [kind: string]: Consumer<AppData>;
    };
  }>({});
  const consumeOperationsInProgress = useRef<Set<string>>(new Set());
  // One toast per session for consume failures: a codec this browser
  // cannot decode fails every stream of that kind, and a toast per
  // stream would be a wall of them.
  const consumeFailureToasted = useRef(false);

  // Ref mirror so the transport event handlers (bound once at creation)
  // always call the provider's latest handler.
  const onTransportFailedRef = useRef(onTransportFailed);
  useEffect(() => {
    onTransportFailedRef.current = onTransportFailed;
  }, [onTransportFailed]);

  const closeAllConsumers = useCallback(() => {
    Object.values(consumers.current).forEach((userConsumers) => {
      Object.values(userConsumers).forEach((consumer) => {
        if (!consumer.closed) consumer.close();
      });
    });
    consumers.current = {};
  }, []);

  /**
   * Both creators THROW on failure. They used to swallow, so `init`
   * carried on into a session with no media path at all — every consume
   * logged "transport not available", and the status still reached
   * CONNECTED while nothing could be heard.
   */
  const createProducerTransport = useCallback(
    async (device: Device, ice: TTransportIceOptions) => {
      logVoice('Creating producer transport', { device, ice });

      const trpc = getVoiceTRPCClient();
      if (!trpc) throw new Error('Voice server is not connected');

      const params = await trpc.voice.createProducerTransport.mutate();

      logVoice('Got producer transport parameters', { params });

      const transport = device.createSendTransport({ ...params, ...ice });
      producerTransport.current = transport;

      transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        logVoice('Producer transport connected', { dtlsParameters });

        try {
          await trpc.voice.connectProducerTransport.mutate({
            dtlsParameters
          });

          callback();
        } catch (error) {
          errback(error as Error);
          logVoice('Error connecting producer transport', { error });
        }
      });

      transport.on('connectionstatechange', async (state) => {
        logVoice('Producer transport connection state changed', { state });

        if (state === 'disconnected') {
          logVoice('Producer transport disconnected, attempting ICE restart');
          try {
            const client = getVoiceTRPCClient();
            if (!client) return;
            const result = await client.voice.restartIce.mutate({
              type: 'producer'
            });
            if (
              result?.iceParameters &&
              producerTransport.current &&
              !producerTransport.current.closed
            ) {
              await producerTransport.current.restartIce({
                iceParameters: result.iceParameters
              });
              logVoice('Producer transport ICE restart succeeded');
            }
          } catch (error) {
            logVoice('Producer transport ICE restart failed, closing', {
              error
            });
            producerTransport.current?.close();
            producerTransport.current = undefined;
            onTransportFailedRef.current('producer');
          }
        } else if (state === 'failed') {
          logVoice('Producer transport failed');
          producerTransport.current?.close();
          producerTransport.current = undefined;
          onTransportFailedRef.current('producer');
        } else if (state === 'closed') {
          logVoice('Producer transport closed');
          producerTransport.current = undefined;
        }
      });

      transport.on('icecandidateerror', (error) => {
        logVoice('Producer transport ICE candidate error', { error });
      });

      transport.on(
        'produce',
        async ({ rtpParameters, appData }, callback, errback) => {
          logVoice('Producing new track', { rtpParameters, appData });

          const { kind } = appData as { kind: StreamKind };

          if (!producerTransport.current) return;

          try {
            const producerId = await trpc.voice.produce.mutate({
              transportId: producerTransport.current.id,
              kind,
              rtpParameters
            });

            callback({ id: producerId });
          } catch (error) {
            if (error instanceof TRPCClientError) {
              if (error.data.code === 'FORBIDDEN') {
                logVoice('Permission denied to produce track', { kind });
                errback(
                  new Error(
                    `You don't have permission to ${kind} in this channel`
                  )
                );

                return;
              }
            }

            logVoice('Error producing new track', { error });
            errback(error as Error);
          }
        }
      );
    },
    []
  );

  const createConsumerTransport = useCallback(
    async (device: Device, ice: TTransportIceOptions) => {
      logVoice('Creating consumer transport', { device, ice });

      const trpc = getVoiceTRPCClient();
      if (!trpc) throw new Error('Voice server is not connected');

      const params = await trpc.voice.createConsumerTransport.mutate();

      logVoice('Got consumer transport parameters', { params });

      const transport = device.createRecvTransport({ ...params, ...ice });
      consumerTransport.current = transport;

      transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        logVoice('Consumer transport connected', { dtlsParameters });

        try {
          await trpc.voice.connectConsumerTransport.mutate({
            dtlsParameters
          });

          callback();
        } catch (error) {
          errback(error as Error);
          logVoice('Consumer transport connect error', { error });
        }
      });

      transport.on('connectionstatechange', async (state) => {
        logVoice('Consumer transport connection state changed', { state });

        if (state === 'disconnected') {
          logVoice('Consumer transport disconnected, attempting ICE restart');
          try {
            const client = getVoiceTRPCClient();
            if (!client) return;
            const result = await client.voice.restartIce.mutate({
              type: 'consumer'
            });
            if (
              result?.iceParameters &&
              consumerTransport.current &&
              !consumerTransport.current.closed
            ) {
              await consumerTransport.current.restartIce({
                iceParameters: result.iceParameters
              });
              logVoice('Consumer transport ICE restart succeeded');
            }
          } catch (error) {
            logVoice('Consumer transport ICE restart failed, closing', {
              error
            });
            closeAllConsumers();
            consumerTransport.current?.close();
            consumerTransport.current = undefined;
            onTransportFailedRef.current('consumer');
          }
        } else if (state === 'failed') {
          logVoice('Consumer transport failed, cleaning up');
          closeAllConsumers();
          consumerTransport.current?.close();
          consumerTransport.current = undefined;
          onTransportFailedRef.current('consumer');
        } else if (state === 'closed') {
          logVoice('Consumer transport closed');
          consumerTransport.current = undefined;
        }
      });

      transport.on('icecandidateerror', (error) => {
        logVoice('Consumer transport ICE candidate error', { error });
      });
    },
    [closeAllConsumers]
  );

  /**
   * `deviceRtpCapabilities` are the loaded Device's — what THIS browser
   * can decode — not the router's. The server picks the consumer codec
   * from what it is told the client supports; handed the router's own
   * list it would happily pick a codec the browser lacks (an H264 screen
   * share into a Firefox without OpenH264), and the local consume() then
   * failed with nothing on screen.
   */
  const consume = useCallback(
    async (
      remoteId: number,
      kind: StreamKind,
      deviceRtpCapabilities: RtpCapabilities
    ) => {
      if (!consumerTransport.current) {
        logVoice('Consumer transport not available');
        return;
      }

      const operationKey = `${remoteId}-${kind}`;

      if (consumeOperationsInProgress.current.has(operationKey)) {
        logVoice('Consume operation already in progress', {
          remoteId,
          kind
        });
        return;
      }

      consumeOperationsInProgress.current.add(operationKey);

      try {
        logVoice('Consuming remote producer', { remoteId, kind });

        const trpc = getVoiceTRPCClient();
        if (!trpc) return;

        const { producerId, consumerId, consumerKind, consumerRtpParameters } =
          await trpc.voice.consume.mutate({
            kind,
            remoteId,
            rtpCapabilities: deviceRtpCapabilities
          });

        logVoice('Got consumer parameters', {
          producerId,
          consumerId,
          consumerKind,
          consumerRtpParameters
        });

        if (!consumers.current[remoteId]) {
          consumers.current[remoteId] = {};
        }

        const existingConsumer = consumers.current[remoteId][consumerKind];

        if (existingConsumer && !existingConsumer.closed) {
          logVoice('Closing existing consumer before creating new one');

          existingConsumer.close();
          delete consumers.current[remoteId][consumerKind];
        }

        const newConsumer = await consumerTransport.current.consume({
          id: consumerId,
          producerId: producerId,
          kind: getMediasoupKind(consumerKind),
          rtpParameters: consumerRtpParameters
        });

        logVoice('Created new consumer', { newConsumer });

        // Consumer emits transportclose/trackended; its observer emits
        // `close` for every close path (including consumer.close()).
        const onConsumerGone = (event: string) => {
          logVoice(`Consumer cleanup event "${event}" triggered`, {
            remoteId,
            kind
          });

          if (
            kind === StreamKind.EXTERNAL_VIDEO ||
            kind === StreamKind.EXTERNAL_AUDIO
          ) {
            removeExternalStreamTrack(remoteId, kind);
          } else {
            removeRemoteUserStream(remoteId, kind);
          }

          if (consumers.current[remoteId]?.[consumerKind]) {
            delete consumers.current[remoteId][consumerKind];
          }
        };

        newConsumer.on('transportclose', () => onConsumerGone('transportclose'));
        newConsumer.on('trackended', () => onConsumerGone('trackended'));
        newConsumer.observer.on('close', () => onConsumerGone('close'));

        consumers.current[remoteId][consumerKind] = newConsumer;

        const stream = new MediaStream();

        stream.addTrack(newConsumer.track);

        if (
          kind === StreamKind.EXTERNAL_VIDEO ||
          kind === StreamKind.EXTERNAL_AUDIO
        ) {
          addExternalStreamTrack(remoteId, stream, kind);
        } else {
          addRemoteUserStream(remoteId, stream, kind);
        }
      } catch (error) {
        logVoice('Error consuming remote producer', { error, remoteId, kind });
        if (!consumeFailureToasted.current) {
          consumeFailureToasted.current = true;
          toast.error(CONSUME_FAILURE_MESSAGE);
        }
      } finally {
        consumeOperationsInProgress.current.delete(operationKey);
      }
    },
    [
      addRemoteUserStream,
      removeRemoteUserStream,
      addExternalStreamTrack,
      removeExternalStreamTrack
    ]
  );

  const consumeExistingProducers = useCallback(
    async (
      deviceRtpCapabilities: RtpCapabilities,
      externalStreamTracks?: {
        [streamId: number]: { audio?: boolean; video?: boolean };
      }
    ) => {
      logVoice('Consuming existing producers');

      const trpc = getVoiceTRPCClient();
      if (!trpc) return;

      try {
        const {
          remoteAudioIds,
          remoteScreenIds,
          remoteScreenAudioIds,
          remoteVideoIds,
          remoteExternalStreamIds
        } = await trpc.voice.getProducers.query();

        logVoice('Got existing producers', {
          remoteAudioIds,
          remoteScreenIds,
          remoteScreenAudioIds,
          remoteVideoIds,
          remoteExternalStreamIds
        });

        const consumePromises: Promise<void>[] = [];

        for (const remoteId of remoteAudioIds) {
          consumePromises.push(
            consume(remoteId, StreamKind.AUDIO, deviceRtpCapabilities)
          );
        }

        for (const remoteId of remoteVideoIds) {
          consumePromises.push(
            consume(remoteId, StreamKind.VIDEO, deviceRtpCapabilities)
          );
        }

        for (const remoteId of remoteScreenIds) {
          consumePromises.push(
            consume(remoteId, StreamKind.SCREEN, deviceRtpCapabilities)
          );
        }

        for (const remoteId of remoteScreenAudioIds) {
          consumePromises.push(
            consume(remoteId, StreamKind.SCREEN_AUDIO, deviceRtpCapabilities)
          );
        }

        for (const streamId of remoteExternalStreamIds) {
          const tracks = externalStreamTracks?.[streamId];

          if (tracks?.audio !== false) {
            consumePromises.push(
              consume(streamId, StreamKind.EXTERNAL_AUDIO, deviceRtpCapabilities)
            );
          }
          if (tracks?.video !== false) {
            consumePromises.push(
              consume(streamId, StreamKind.EXTERNAL_VIDEO, deviceRtpCapabilities)
            );
          }
        }

        await Promise.allSettled(consumePromises);
      } catch (error) {
        logVoice('Error consuming existing producers', { error });
      }
    },
    [consume]
  );

  const cleanupTransports = useCallback(() => {
    logVoice('Cleaning up transports');

    closeAllConsumers();
    consumeOperationsInProgress.current.clear();
    consumeFailureToasted.current = false;

    if (producerTransport.current && !producerTransport.current.closed) {
      producerTransport.current.close();
    }

    producerTransport.current = undefined;

    if (consumerTransport.current && !consumerTransport.current.closed) {
      consumerTransport.current.close();
    }

    consumerTransport.current = undefined;

    logVoice('Transports cleanup complete');
  }, [closeAllConsumers]);

  return {
    producerTransport,
    consumerTransport,
    consumers,
    createProducerTransport,
    createConsumerTransport,
    consume,
    consumeExistingProducers,
    cleanupTransports
  };
};

export { useTransports };
