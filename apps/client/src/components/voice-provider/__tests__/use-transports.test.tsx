/**
 * voice-provider/hooks/use-transports — the client side of the media
 * transports, driven through the real hook on a stubbed Device.
 *
 *  - transport creation THROWS when the server refuses (init must not
 *    carry on into a session with no media path)
 *  - the operator's ICE relay reaches the transport options
 *  - consume negotiates with the DEVICE's capabilities (what this browser
 *    decodes), not the router's
 *  - a consume failure is surfaced once per session, not once per stream
 *  - ICE `failed` closes the transport and hands the provider the decision
 *
 * Run via: bun test apps/client/src/components/voice-provider/__tests__/use-transports.test.tsx
 */

import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Device } from 'mediasoup-client/types';
import { StreamKind } from '@pulse/shared';
import { toast } from 'sonner';
import {
  fakeClient,
  installClients,
  installConnectionMocks,
  resetConnectionState,
  type FakeClient
} from '@/__tests__/home-connection-harness';

installConnectionMocks();

const { useTransports } = await import('../hooks/use-transports');

type TransportsApi = ReturnType<typeof useTransports>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// happy-dom's MediaStream rejects anything that is not its own track
// class; the consumer's track is a plain stub here.
class FakeMediaStream {
  tracks: unknown[] = [];
  addTrack(track: unknown) {
    this.tracks.push(track);
  }
}
const RealMediaStream = globalThis.MediaStream;

// Device capabilities WITHOUT H264 — a browser that cannot decode it.
const DEVICE_CAPS = {
  codecs: [{ mimeType: 'video/VP8', kind: 'video', clockRate: 90000 }],
  headerExtensions: []
};
const ROUTER_CAPS = {
  codecs: [
    { mimeType: 'video/H264', kind: 'video', clockRate: 90000 },
    { mimeType: 'video/VP8', kind: 'video', clockRate: 90000 }
  ],
  headerExtensions: []
};
const TRANSPORT_PARAMS = {
  id: 't-1',
  iceParameters: {},
  iceCandidates: [],
  dtlsParameters: {}
};

type Handler = (...args: unknown[]) => unknown;

/** A transport stub that records listeners and the options it was built with. */
const fakeTransport = (consumeImpl?: () => Promise<unknown>) => {
  const handlers = new Map<string, Handler>();
  const transport = {
    id: 't-1',
    closed: false,
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    close: () => {
      transport.closed = true;
    },
    consume:
      consumeImpl ??
      (async () => ({
        track: { kind: 'video' },
        closed: false,
        close: () => {},
        on: () => {},
        observer: { on: () => {} }
      })),
    emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args)
  };
  return transport;
};

const fakeDevice = (recvTransport: ReturnType<typeof fakeTransport>) => {
  const created: { recv: unknown[]; send: unknown[] } = { recv: [], send: [] };
  const device = {
    rtpCapabilities: DEVICE_CAPS,
    createRecvTransport: (options: unknown) => {
      created.recv.push(options);
      return recvTransport;
    },
    createSendTransport: (options: unknown) => {
      created.send.push(options);
      return fakeTransport();
    }
  };
  return { device: device as unknown as Device, created };
};

let home: FakeClient;
let restoreClients: () => void;
let root: Root | null = null;
let container: HTMLDivElement;
let streams: { userId: number; kind: StreamKind }[];
let failed: string[];

const mountTransports = async (): Promise<TransportsApi> => {
  let api: TransportsApi | null = null;
  const Host = () => {
    const transports = useTransports({
      addRemoteUserStream: (userId, _stream, kind) => {
        streams.push({ userId, kind });
      },
      removeRemoteUserStream: () => {},
      addExternalStreamTrack: () => {},
      removeExternalStreamTrack: () => {},
      onTransportFailed: (type) => {
        failed.push(type);
      }
    });
    useEffect(() => {
      api = transports;
    });
    return null;
  };
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root!.render(<Host />);
  });
  if (!api) throw new Error('hook did not mount');
  return api;
};

beforeEach(() => {
  resetConnectionState();
  streams = [];
  failed = [];
  home = fakeClient({
    'voice.createConsumerTransport': () => TRANSPORT_PARAMS,
    'voice.createProducerTransport': () => TRANSPORT_PARAMS,
    'voice.consume': (input) => {
      const { remoteId, kind } = input as { remoteId: number; kind: StreamKind };
      return {
        producerId: `p-${remoteId}`,
        consumerId: `c-${remoteId}`,
        consumerKind: kind,
        consumerRtpParameters: {}
      };
    }
  });
  restoreClients = installClients({ home });
  (globalThis as { MediaStream: unknown }).MediaStream = FakeMediaStream;
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  (globalThis as { MediaStream: unknown }).MediaStream = RealMediaStream;
  restoreClients();
});

describe('transport creation', () => {
  test('a refused producer transport throws instead of leaving a half session', async () => {
    home.handlers['voice.createProducerTransport'] = () => {
      throw new Error('Voice runtime is full');
    };
    const api = await mountTransports();
    const { device } = fakeDevice(fakeTransport());

    await expect(api.createProducerTransport(device, {})).rejects.toThrow(
      'Voice runtime is full'
    );
    expect(api.producerTransport.current).toBeUndefined();
  });

  test('a refused consumer transport throws too', async () => {
    home.handlers['voice.createConsumerTransport'] = () => {
      throw new Error('nope');
    };
    const api = await mountTransports();
    const { device } = fakeDevice(fakeTransport());

    await expect(api.createConsumerTransport(device, {})).rejects.toThrow('nope');
  });

  test("the operator's ICE relay reaches both transports' options", async () => {
    const api = await mountTransports();
    const { device, created } = fakeDevice(fakeTransport());
    const ice = {
      iceServers: [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }],
      iceTransportPolicy: 'relay' as const
    };

    await api.createConsumerTransport(device, ice);
    await api.createProducerTransport(device, ice);

    expect(created.recv[0]).toMatchObject({ ...TRANSPORT_PARAMS, ...ice });
    expect(created.send[0]).toMatchObject({ ...TRANSPORT_PARAMS, ...ice });
  });
});

describe('consume', () => {
  test('negotiates with the device capabilities, not the router list', async () => {
    const api = await mountTransports();
    const { device } = fakeDevice(fakeTransport());
    await api.createConsumerTransport(device, {});

    await api.consume(77, StreamKind.SCREEN, device.rtpCapabilities);

    const calls = home.callsTo('voice.consume');
    expect(calls).toHaveLength(1);
    const input = calls[0]!.input as { rtpCapabilities: typeof DEVICE_CAPS };
    expect(input.rtpCapabilities).toEqual(DEVICE_CAPS);
    expect(input.rtpCapabilities).not.toEqual(ROUTER_CAPS);
    expect(
      input.rtpCapabilities.codecs.some((c) => /h264/i.test(c.mimeType))
    ).toBe(false);
    expect(streams).toEqual([{ userId: 77, kind: StreamKind.SCREEN }]);
  });

  test('a failure is surfaced once per session, and again after cleanup', async () => {
    const errorToast = spyOn(toast, 'error').mockImplementation(() => '' as never);
    try {
      const api = await mountTransports();
      const transport = fakeTransport(async () => {
        throw new Error('UnsupportedError: codec');
      });
      const { device } = fakeDevice(transport);
      await api.createConsumerTransport(device, {});

      await api.consume(1, StreamKind.VIDEO, device.rtpCapabilities);
      await api.consume(2, StreamKind.VIDEO, device.rtpCapabilities);
      await api.consume(3, StreamKind.SCREEN, device.rtpCapabilities);

      expect(home.callsTo('voice.consume')).toHaveLength(3);
      expect(errorToast).toHaveBeenCalledTimes(1);
      expect(streams).toHaveLength(0);

      // A new session gets its own one toast.
      api.cleanupTransports();
      await api.createConsumerTransport(device, {});
      await api.consume(4, StreamKind.VIDEO, device.rtpCapabilities);
      expect(errorToast).toHaveBeenCalledTimes(2);
    } finally {
      errorToast.mockRestore();
    }
  });
});

describe('ICE failure', () => {
  test('a failed consumer transport is closed and reported to the provider', async () => {
    const api = await mountTransports();
    const transport = fakeTransport();
    const { device } = fakeDevice(transport);
    await api.createConsumerTransport(device, {});

    await act(async () => {
      await transport.emit('connectionstatechange', 'failed');
    });

    expect(transport.closed).toBe(true);
    expect(api.consumerTransport.current).toBeUndefined();
    expect(failed).toEqual(['consumer']);
  });

  test('a failed producer transport is reported the same way', async () => {
    const api = await mountTransports();
    const { device, created } = fakeDevice(fakeTransport());
    await api.createProducerTransport(device, {});
    expect(created.send).toHaveLength(1);

    const transport = api.producerTransport.current as unknown as ReturnType<
      typeof fakeTransport
    >;
    await act(async () => {
      await transport.emit('connectionstatechange', 'failed');
    });

    expect(transport.closed).toBe(true);
    expect(failed).toEqual(['producer']);
  });
});
