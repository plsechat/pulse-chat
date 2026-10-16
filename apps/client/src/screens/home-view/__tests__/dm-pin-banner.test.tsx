/**
 * DM pin banner + the compact ChatMessageBody it (and the DM search
 * results / pinned-messages panel) render through (audit A8-16):
 *
 *  - legacy HTML content is DOMPurify-sanitized — an `<img onerror>`
 *    payload reaches the DOM with no handler attribute
 *  - token content is tokenized, not parsed as HTML — `<@2>` renders as
 *    a mention chip instead of being dropped as an unknown tag
 *  - compact mode renders the content only (no reactions/attachments)
 *
 * Rendered with react-dom under happy-dom on the connection harness's
 * store; the harness's fake home client answers `dms.getPinned`.
 *
 * Run via: bun test apps/client/src/screens/home-view/__tests__/dm-pin-banner.test.tsx
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import type { TJoinedDmChannel, TJoinedDmMessage } from '@pulse/server/types';
import { dmsSliceActions } from '@/features/dms/slice';
import {
  fakeClient,
  installClients,
  installConnectionMocks,
  resetConnectionState,
  settle,
  testStore
} from '@/__tests__/home-connection-harness';

installConnectionMocks();

// Imported after the mocks so `@/lib/trpc` resolves to the fake client.
const { DmPinBanner } = await import('../dm-pin-banner');
const { ChatMessageBody } = await import(
  '@/components/chat-primitives/message-body'
);
const { ChatScopeProvider } = await import(
  '@/components/chat-primitives/chat-scope'
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const CHANNEL = 1;
const XSS_HTML = '<p>hi <img src="x" onerror="alert(1)"> there</p>';
const TOKEN_CONTENT = 'ping <@2> **now**';

const pinned = (content: string): TJoinedDmMessage =>
  ({
    id: 7,
    dmChannelId: CHANNEL,
    userId: 2,
    content,
    createdAt: 7000,
    updatedAt: null,
    edited: false,
    pinned: true,
    e2ee: false,
    files: [],
    reactions: [],
    metadata: null,
    replyTo: null
  }) as unknown as TJoinedDmMessage;

let root: Root;
let container: HTMLDivElement;
let restoreClients: () => void;

const mount = async (node: ReactNode) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(Provider, {
        store: testStore,
        children: createElement(ChatScopeProvider, { homeScope: true, children: node })
      })
    );
  });
  await act(async () => {
    await settle();
  });
};

const expandBanner = async () => {
  const toggle = container.querySelector<HTMLButtonElement>(
    'button[title="Expand pinned message"]'
  );
  expect(toggle).not.toBeNull();
  await act(async () => {
    toggle!.click();
  });
};

beforeEach(() => {
  resetConnectionState();
  testStore.dispatch(dmsSliceActions.resetState());
  // The DM's members are the home roster the banner/mention resolve
  // authors against.
  testStore.dispatch(
    dmsSliceActions.setChannels([
      {
        id: CHANNEL,
        isGroup: false,
        e2ee: false,
        unreadCount: 0,
        members: [
          { id: 2, name: 'Rhea', avatar: null, _identity: 'rhea', createdAt: 1000 },
          { id: 10, name: 'Me', avatar: null, _identity: 'me', createdAt: 1000 }
        ]
      } as unknown as TJoinedDmChannel
    ])
  );
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  restoreClients?.();
  testStore.dispatch(dmsSliceActions.resetState());
});

describe('DmPinBanner', () => {
  test('legacy HTML is sanitized: the onerror handler never reaches the DOM', async () => {
    restoreClients = installClients({
      home: fakeClient({ 'dms.getPinned': () => [pinned(XSS_HTML)] })
    });
    await mount(createElement(DmPinBanner, { dmChannelId: CHANNEL }));

    // Collapsed: author + plain-text preview, no markup.
    expect(container.textContent).toContain('Rhea');
    expect(container.textContent).toContain('hi  there');

    await expandBanner();

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.hasAttribute('onerror')).toBe(false);
    expect(container.querySelectorAll('[onerror]').length).toBe(0);
    expect(container.innerHTML).not.toContain('onerror');
    expect(container.innerHTML).not.toContain('alert(1)');
  });

  test('token content renders a mention chip, not a dropped tag', async () => {
    restoreClients = installClients({
      home: fakeClient({ 'dms.getPinned': () => [pinned(TOKEN_CONTENT)] })
    });
    await mount(createElement(DmPinBanner, { dmChannelId: CHANNEL }));
    await expandBanner();

    const chip = container.querySelector('.mention');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe('@Rhea');
    // The bold markers became markup, the raw token is gone.
    expect(container.querySelector('strong')?.textContent).toBe('now');
    expect(container.textContent).not.toContain('<@2>');
  });

  test('renders nothing when there is no pin', async () => {
    restoreClients = installClients({
      home: fakeClient({ 'dms.getPinned': () => [] })
    });
    await mount(createElement(DmPinBanner, { dmChannelId: CHANNEL }));
    expect(container.innerHTML).toBe('');
  });
});

describe('ChatMessageBody compact (DM search result / pinned item path)', () => {
  const body = (content: string) =>
    createElement(ChatMessageBody, {
      message: {
        ...pinned(content),
        reactions: [{ emoji: '👍', count: 1, users: [] }] as never
      },
      homeScope: true,
      compact: true
    });

  test('sanitizes legacy HTML', async () => {
    restoreClients = installClients({ home: fakeClient() });
    await mount(body(XSS_HTML));
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.querySelectorAll('[onerror]').length).toBe(0);
    expect(container.innerHTML).not.toContain('alert(1)');
  });

  test('renders tokens through the token renderer', async () => {
    restoreClients = installClients({ home: fakeClient() });
    await mount(body(TOKEN_CONTENT));
    expect(container.querySelector('.mention')?.textContent).toBe('@Rhea');
    expect(container.querySelector('strong')?.textContent).toBe('now');
  });

  test('is content only — no reaction row', async () => {
    restoreClients = installClients({ home: fakeClient() });
    await mount(body(TOKEN_CONTENT));
    expect(container.textContent).not.toContain('👍');
  });
});
