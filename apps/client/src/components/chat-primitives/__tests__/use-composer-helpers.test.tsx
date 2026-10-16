/**
 * chat-primitives/use-composer-helpers — the composer plumbing shared
 * by the channel and DM orchestrators (audit A8-17):
 *
 *  - onGifSelect: send → onGifSent; a detached window is re-attached
 *    and scrolled; a failed send toasts and does not clear the reply
 *  - onRemoveFileClick: the surface's temp-file delete runs best-effort
 *  - focusEditorAtBottom lands on the live tail (handleReply's contract)
 *  - every returned callback is identity-stable across option changes
 *  - useTypingSignal throttles and is cancelled on unmount
 *
 * Rendered with react-dom under happy-dom on the connection harness's
 * store (useUploadFiles reads server settings/permissions from it).
 *
 * Run via: bun test apps/client/src/components/chat-primitives/__tests__/use-composer-helpers.test.tsx
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { toast } from 'sonner';
import {
  fakeClient,
  installClients,
  installConnectionMocks,
  resetConnectionState,
  testStore
} from '@/__tests__/home-connection-harness';

installConnectionMocks();

const { useComposerHelpers, useTypingSignal } = await import(
  '../use-composer-helpers'
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type THelpers = ReturnType<typeof useComposerHelpers>;
type TOptions = Parameters<typeof useComposerHelpers>[0];

const latest: { current: THelpers | null } = { current: null };

const Probe = ({ options }: { options: TOptions }) => {
  latest.current = useComposerHelpers(options);
  return null;
};

let root: Root;
let container: HTMLDivElement;
let restoreClients: () => void;

const render = async (options: TOptions) => {
  await act(async () => {
    root.render(
      createElement(Provider, {
        store: testStore,
        children: createElement(Probe, { options })
      })
    );
  });
};

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const baseOptions = (over: Partial<TOptions> = {}): TOptions => ({
  uploadDisabled: false,
  isE2ee: false,
  sendGif: async () => {},
  detached: false,
  reattach: async () => {},
  scrollToBottom: () => {},
  ...over
});

beforeEach(() => {
  resetConnectionState();
  restoreClients = installClients({ home: fakeClient() });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  restoreClients();
  latest.current = null;
});

describe('useComposerHelpers', () => {
  test('onGifSelect sends, then runs onGifSent; an attached window is left alone', async () => {
    const sent: string[] = [];
    let gifSent = 0;
    let reattached = 0;
    await render(
      baseOptions({
        sendGif: async (url) => {
          sent.push(url);
        },
        onGifSent: () => gifSent++,
        reattach: async () => {
          reattached++;
        }
      })
    );

    await act(async () => {
      await latest.current!.onGifSelect('https://gif/1');
    });

    expect(sent).toEqual(['https://gif/1']);
    expect(gifSent).toBe(1);
    expect(reattached).toBe(0);
  });

  test('onGifSelect from a detached window re-attaches and scrolls to the bottom', async () => {
    const calls: string[] = [];
    await render(
      baseOptions({
        detached: true,
        sendGif: async () => {
          calls.push('send');
        },
        reattach: async () => {
          calls.push('reattach');
        },
        scrollToBottom: () => calls.push('scroll')
      })
    );

    await act(async () => {
      await latest.current!.onGifSelect('https://gif/2');
      await nextFrame();
    });

    expect(calls).toEqual(['send', 'reattach', 'scroll']);
  });

  test('a failed GIF send toasts and does not run onGifSent', async () => {
    const errorSpy = spyOn(toast, 'error').mockImplementation(() => '' as never);
    let gifSent = 0;
    await render(
      baseOptions({
        sendGif: async () => {
          throw new Error('nope');
        },
        onGifSent: () => gifSent++
      })
    );

    await act(async () => {
      await latest.current!.onGifSelect('https://gif/3');
    });

    expect(gifSent).toBe(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe('nope');
    errorSpy.mockRestore();
  });

  test('onRemoveFileClick deletes the temp upload best-effort', async () => {
    const deleted: string[] = [];
    await render(
      baseOptions({
        deleteTemporaryFile: async (id) => {
          deleted.push(id);
          throw new Error('already gone');
        }
      })
    );

    await act(async () => {
      latest.current!.onRemoveFileClick('tmp-1');
      await Promise.resolve();
    });

    expect(deleted).toEqual(['tmp-1']);
  });

  test('focusEditorAtBottom scrolls to the bottom on the next frame', async () => {
    let scrolled = 0;
    await render(baseOptions({ scrollToBottom: () => scrolled++ }));

    latest.current!.focusEditorAtBottom();
    expect(scrolled).toBe(0);
    await nextFrame();
    expect(scrolled).toBe(1);
  });

  test('callbacks keep their identity when the options change, and read the latest', async () => {
    const first: string[] = [];
    await render(baseOptions({ sendGif: async (u) => { first.push(u); } }));
    const before = latest.current!;

    const second: string[] = [];
    await render(baseOptions({ sendGif: async (u) => { second.push(u); } }));
    const after = latest.current!;

    expect(after.onGifSelect).toBe(before.onGifSelect);
    expect(after.onRemoveFileClick).toBe(before.onRemoveFileClick);
    expect(after.onFileInputChange).toBe(before.onFileInputChange);
    expect(after.focusEditorAtBottom).toBe(before.focusEditorAtBottom);
    expect(after.inputAreaRef).toBe(before.inputAreaRef);

    await act(async () => {
      await after.onGifSelect('https://gif/4');
    });
    expect(first).toEqual([]);
    expect(second).toEqual(['https://gif/4']);
  });
});

describe('useTypingSignal', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test('collapses a burst into one leading call per window', async () => {
    let calls = 0;
    const send = () => {
      calls++;
    };
    const TypingProbe = () => {
      const signal = useTypingSignal(send, 40);
      latestSignal.current = signal;
      return null;
    };
    const latestSignal: { current: ReturnType<typeof useTypingSignal> | null } = {
      current: null
    };
    await act(async () => {
      root.render(createElement(TypingProbe));
    });

    latestSignal.current!();
    latestSignal.current!();
    latestSignal.current!();
    expect(calls).toBe(1);
    // The trailing edge fires once the window closes.
    await sleep(60);
    expect(calls).toBe(2);
    // cancel() drops a pending trailing call (what a send does).
    latestSignal.current!();
    latestSignal.current!();
    latestSignal.current!.cancel();
    await sleep(60);
    expect(calls).toBe(3);
  });

  test('a pending trailing call is cancelled on unmount', async () => {
    let calls = 0;
    const send = () => {
      calls++;
    };
    let signal: ReturnType<typeof useTypingSignal> | null = null;
    const TypingProbe = () => {
      signal = useTypingSignal(send, 40);
      return null;
    };
    await act(async () => {
      root.render(createElement(TypingProbe));
    });
    signal!();
    signal!();
    expect(calls).toBe(1);
    await act(async () => {
      root.unmount();
    });
    await sleep(60);
    expect(calls).toBe(1);
    // afterEach unmounts again; a second unmount of a fresh root is a no-op.
    root = createRoot(container);
  });
});
