import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { TSeedUser } from '../../helpers/fixtures';

/**
 * Shared by seed.spec.ts and verify.spec.ts — the two halves of the
 * upgrade smoke (docker/compose.upgrade.yml, docker/upgrade-smoke.sh).
 *
 * The two specs run as separate Playwright invocations against two
 * different server images, so everything the verify half needs to know
 * about what the seed half created travels through a small JSON state
 * file (outside test-results/, which Playwright wipes on every run).
 */

/** Which half of the smoke this invocation is: `seed` or `verify`. */
export const UPGRADE_PHASE = process.env.UPGRADE_PHASE;

export const UPGRADE_HOST_PORT = process.env.UPGRADE_HOST_PORT ?? '14997';
export const UPGRADE_BASE = `http://127.0.0.1:${UPGRADE_HOST_PORT}`;

/** The postgres container of compose.upgrade.yml. */
export const UPGRADE_DB_CONTAINER = 'pulse-e2e-upgrade-db';

export const STATE_FILE = path.join(__dirname, '..', '..', '.upgrade', 'state.json');

/**
 * The account seeded on the OLD image and logged in on the NEW one. Fixed
 * (not RUN_TAG-suffixed): the upgrade stack is always `down -v`'d before
 * a run, and a stable email is what "the old credentials still work"
 * means.
 */
export const UPGRADE_OWNER: TSeedUser = {
  email: 'upgrade-owner@e2e.local',
  password: 'e2e-password-1234',
  displayName: 'UpgradeOwner'
};

export type TMigrationRow = { id: string; hash: string; createdAt: string };

export type TUpgradeState = {
  /** `/info` version reported by the image that seeded the data. */
  oldVersion: string;
  /** Per-run tag baked into the channel and message names. */
  runTag: string;
  channelName: string;
  messageText: string;
  /** Absolute URL of the uploaded attachment as served by the old image. */
  fileUrl: string;
  /** `drizzle.__drizzle_migrations` rows after the old image booted. */
  migrations: TMigrationRow[];
};

/** Run one SQL statement in the upgrade postgres (bare tuples). */
export function upgradePsql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', UPGRADE_DB_CONTAINER, 'psql', '-U', 'postgres', '-qtAX', '-c', sql],
    { encoding: 'utf8' }
  ).trim();
}

/** The migration tracking rows, oldest first. */
export function readMigrationRows(): TMigrationRow[] {
  const out = upgradePsql(
    'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id'
  );
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [id, hash, createdAt] = line.split('|');
    return { id: id!, hash: hash!, createdAt: createdAt! };
  });
}

export function writeState(state: TUpgradeState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function readState(): TUpgradeState {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(
      `${STATE_FILE} is missing — run the seed phase first (UPGRADE_PHASE=seed)`
    );
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as TUpgradeState;
}

/**
 * Number of migrations the checkout under test ships: the migrator's
 * journal is the source of truth for "every migration applied once".
 */
export function journalMigrationCount(): number {
  const journalPath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'apps',
    'server',
    'src',
    'db',
    'migrations',
    'meta',
    '_journal.json'
  );
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
    entries: unknown[];
  };
  return journal.entries.length;
}
