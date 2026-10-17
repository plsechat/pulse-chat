/**
 * Container health probe. The server's port is whatever the operator
 * configured — `PULSE_PORT` in the environment, else `port` in the data
 * directory's config.ini, else the 5443 default — so the probe reads the
 * same sources instead of pinning 5443 (an instance on another port was
 * reported "unhealthy" forever while serving fine).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fromEnv = Number(process.env.PULSE_PORT);
const fromConfig = (): number | undefined => {
  try {
    const dir = process.env.DATA_PATH || '/root/.config/pulse';
    const ini = readFileSync(join(dir, 'config.ini'), 'utf8');
    const server = ini.split(/^\[/m).find((s) => s.startsWith('server]'));
    const m = server?.match(/^\s*port\s*=\s*(\d+)/m);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
};
const port =
  Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : (fromConfig() ?? 5443);

try {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(4000)
  });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
