import { defineConfig, devices } from '@playwright/test';

/**
 * Instance map (see docker/compose.yml):
 *   core        http://127.0.0.1:14991
 *   sso         http://127.0.0.1:14993
 *   federation  http://127.0.0.1:14994 (fed-a, home) + 14995 (fed-b, peer)
 *
 * Workers are 1 per project on purpose: each project shares one live
 * instance and (for core) one operator account, so tests within a
 * project run sequentially against evolving-but-deterministic state.
 * Projects themselves target separate instances and can parallelize.
 */

const FAKE_MEDIA_ARGS = [
  // Voice channels request the microphone on join; fake devices keep the
  // headless run non-interactive.
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream'
];

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  projects: [
    // Registers the shared users once and writes storageState files.
    {
      name: 'core-setup',
      testDir: './tests/core',
      testMatch: /core\.setup\.ts/
    },
    {
      name: 'core',
      testDir: './tests/core',
      testIgnore: /core\.setup\.ts/,
      dependencies: ['core-setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://127.0.0.1:14991',
        launchOptions: { args: FAKE_MEDIA_ARGS },
        permissions: ['microphone']
      }
    },
    {
      name: 'sso',
      testDir: './tests/sso',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://127.0.0.1:14993'
      }
    },
    {
      name: 'federation',
      testDir: './tests/federation',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://127.0.0.1:14994',
        permissions: ['microphone'],
        launchOptions: {
          args: [
            ...FAKE_MEDIA_ARGS,
            // The client addresses the peer by its Instance Domain
            // (pulse-fed-b:4991). Containers resolve it via compose DNS;
            // the host browser resolves it here — same URL, same
            // behavior, no app/config difference.
            '--host-resolver-rules=MAP pulse-fed-b:4991 127.0.0.1:14995'
          ]
        }
      }
    }
  ]
});
