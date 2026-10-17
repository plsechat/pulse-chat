/**
 * The desktop game-presence bridge, driven through a fake
 * `window.pulseDesktop.onGamePresence` (the contract in
 * docs/desktop-integration.md):
 *
 *  - subscribing takes the shell's immediate report and sends it to
 *    users.setGamePresence on the home client; null is sent as null
 *  - reports inside the 10 s window are coalesced to the LAST state,
 *    sent when the window reopens — never a burst, never a lost state
 *  - stopping unsubscribes from the shell and reports nothing
 *  - the own-presence store keeps startedAt across a same-name re-report
 *  - a reopened home session re-reports the current game
 *  - no shell (the browser build) → nothing happens
 *
 * Run via: bun test apps/client/src/lib/__tests__/game-presence.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __testing,
  getOwnGamePresence,
  resendGamePresence,
  startGamePresenceBridge,
  stopGamePresenceBridge,
  subscribeOwnGamePresence
} from '../game-presence';

type ShellCallback = (presence: { name: string } | null) => void;

/** A fake shell: records subscribers and lets the test "detect" games. */
const installFakeShell = () => {
  const subscribers = new Set<ShellCallback>();
  let current: { name: string } | null = null;
  (window as { pulseDesktop?: unknown }).pulseDesktop = {
    isElectron: true,
    platform: 'test',
    onGamePresence(cb: ShellCallback) {
      subscribers.add(cb);
      cb(current);
      return () => subscribers.delete(cb);
    }
  };
  return {
    subscribers,
    detect(presence: { name: string } | null) {
      current = presence;
      for (const cb of subscribers) cb(presence);
    }
  };
};

const sentReports: unknown[] = [];
const fakeClient = {
  users: {
    setGamePresence: {
      mutate: async (input: unknown) => {
        sentReports.push(input);
        return { gamePresence: null };
      }
    }
  }
} as never;

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  __testing.reset();
  __testing.setClientResolver(() => fakeClient);
  __testing.setMinInterval(30);
  sentReports.length = 0;
});

afterEach(() => {
  __testing.reset();
  delete (window as { pulseDesktop?: unknown }).pulseDesktop;
});

describe('startGamePresenceBridge', () => {
  test('without a shell nothing is subscribed or sent', async () => {
    expect(startGamePresenceBridge()).toBe(false);
    await tick(10);
    expect(sentReports).toEqual([]);
    expect(getOwnGamePresence()).toBeNull();
  });

  test('a shell without the hook (older desktop) is treated as no shell', () => {
    (window as { pulseDesktop?: unknown }).pulseDesktop = { isElectron: true };
    expect(startGamePresenceBridge()).toBe(false);
  });

  test('takes the immediate report and sends it to the home client', async () => {
    const shell = installFakeShell();
    shell.detect({ name: 'Rocket Pass' });

    expect(startGamePresenceBridge()).toBe(true);
    expect(shell.subscribers.size).toBe(1);
    await tick(5);

    expect(sentReports).toEqual([{ name: 'Rocket Pass' }]);
    expect(getOwnGamePresence()?.name).toBe('Rocket Pass');
    // Idempotent: a second start does not double-subscribe.
    expect(startGamePresenceBridge()).toBe(true);
    expect(shell.subscribers.size).toBe(1);
  });

  test('coalesces reports inside the window to the last state', async () => {
    const shell = installFakeShell();
    startGamePresenceBridge();
    await tick(5);
    expect(sentReports).toEqual([null]);

    shell.detect({ name: 'One' });
    shell.detect({ name: 'Two' });
    shell.detect(null);
    shell.detect({ name: 'Three' });
    await tick(5);
    // Still inside the window: nothing more went out yet …
    expect(sentReports).toEqual([null]);
    // … but the own-presence store already shows the latest.
    expect(getOwnGamePresence()?.name).toBe('Three');

    await tick(60);
    expect(sentReports).toEqual([null, { name: 'Three' }]);
  });

  test('a game that closes inside the window still clears when it reopens', async () => {
    const shell = installFakeShell();
    shell.detect({ name: 'Short Session' });
    startGamePresenceBridge();
    await tick(5);
    shell.detect(null);
    await tick(60);

    expect(sentReports).toEqual([{ name: 'Short Session' }, null]);
    expect(getOwnGamePresence()).toBeNull();
  });

  test('trims the name and treats a blank one as nothing', async () => {
    const shell = installFakeShell();
    shell.detect({ name: '  Padded  ' });
    startGamePresenceBridge();
    await tick(5);
    expect(sentReports).toEqual([{ name: 'Padded' }]);

    shell.detect({ name: '   ' });
    await tick(60);
    expect(sentReports[1]).toBeNull();
  });
});

describe('own presence', () => {
  test('a same-name re-report keeps startedAt and does not notify', async () => {
    const shell = installFakeShell();
    shell.detect({ name: 'Rocket Pass' });
    startGamePresenceBridge();
    let notified = 0;
    subscribeOwnGamePresence(() => notified++);
    const first = getOwnGamePresence();
    expect(first?.name).toBe('Rocket Pass');

    await tick(5);
    shell.detect({ name: 'Rocket Pass' });
    expect(getOwnGamePresence()).toBe(first);
    expect(notified).toBe(0);

    shell.detect({ name: 'Chess' });
    expect(getOwnGamePresence()?.name).toBe('Chess');
    expect(notified).toBe(1);
  });
});

describe('stopGamePresenceBridge', () => {
  test('unsubscribes from the shell and reports nothing', async () => {
    const shell = installFakeShell();
    shell.detect({ name: 'Rocket Pass' });
    startGamePresenceBridge();
    await tick(5);

    stopGamePresenceBridge();
    expect(shell.subscribers.size).toBe(0);
    expect(getOwnGamePresence()).toBeNull();
    await tick(60);
    expect(sentReports).toEqual([{ name: 'Rocket Pass' }, null]);

    // The shell keeps detecting; a stopped bridge ignores it.
    shell.detect({ name: 'Ignored' });
    await tick(60);
    expect(sentReports).toHaveLength(2);
  });

  test('stopping with nothing reported sends nothing', async () => {
    installFakeShell();
    startGamePresenceBridge();
    await tick(60);
    expect(sentReports).toEqual([null]);

    stopGamePresenceBridge();
    await tick(60);
    expect(sentReports).toEqual([null]);
  });
});

describe('resendGamePresence', () => {
  test('re-reports the current game when the home session reopens', async () => {
    const shell = installFakeShell();
    shell.detect({ name: 'Rocket Pass' });
    startGamePresenceBridge();
    await tick(60);
    expect(sentReports).toEqual([{ name: 'Rocket Pass' }]);

    resendGamePresence();
    await tick(5);
    expect(sentReports).toEqual([{ name: 'Rocket Pass' }, { name: 'Rocket Pass' }]);
  });

  test('is a no-op while nothing is playing or the bridge is stopped', async () => {
    installFakeShell();
    startGamePresenceBridge();
    await tick(60);
    sentReports.length = 0;

    resendGamePresence();
    stopGamePresenceBridge();
    resendGamePresence();
    await tick(60);
    expect(sentReports).toEqual([]);
  });
});
