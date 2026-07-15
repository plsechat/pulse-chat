import { execFileSync } from 'node:child_process';

/**
 * Direct psql access to the dockerized instance databases — the only way
 * to assert at-rest properties the UI deliberately hides (E2EE ciphertext,
 * ban reasons, invite usage counters).
 */
const DB_CONTAINERS = {
  core: 'pulse-e2e-db-core',
  sso: 'pulse-e2e-db-sso',
  fedA: 'pulse-e2e-db-fed-a',
  fedB: 'pulse-e2e-db-fed-b'
} as const;

export type TInstanceDb = keyof typeof DB_CONTAINERS;

/** Run one SQL statement, returning trimmed stdout (-qtAX: bare tuples). */
export function psql(instance: TInstanceDb, sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      DB_CONTAINERS[instance],
      'psql',
      '-U',
      'postgres',
      '-qtAX',
      '-c',
      sql
    ],
    { encoding: 'utf8' }
  ).trim();
}
