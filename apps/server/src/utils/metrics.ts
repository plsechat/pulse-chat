import type { TDiskMetrics } from '@pulse/shared';
import si from 'systeminformation';
import { getUsedFileQuota } from '../db/queries/files';
import { logger } from '../logger';
import { VoiceRuntime } from '../runtimes/voice';
import { getWsStats } from './ws-stats';

const getDiskMetrics = async (): Promise<TDiskMetrics> => {
  const [diskInfo, filesUsedSpace] = await Promise.all([
    si.fsSize(),
    getUsedFileQuota()
  ]);

  const totalDisk = diskInfo.reduce((acc, disk) => acc + disk.size, 0);
  const usedDisk = diskInfo.reduce((acc, disk) => acc + disk.used, 0);

  const freeDisk = totalDisk - usedDisk;

  const metrics: TDiskMetrics = {
    totalSpace: totalDisk,
    usedSpace: usedDisk,
    freeSpace: freeDisk,
    pulseUsedSpace: filesUsedSpace
  };

  return metrics;
};

/**
 * In-process time-series sampler for the admin Health graphs. Samples
 * every 15s into a capped ring (6h) — same in-memory precedent as the
 * log ring: restarts reset it, the DB is never touched.
 *
 * cpuSystemPercent is whole-machine load (systeminformation);
 * cpuProcessPercent is THIS process as percent of one core (Bun's JS
 * thread is single-threaded; mediasoup workers are separate processes
 * and show up in system, not process). elLagMs is scheduler drift —
 * how late the sampler fired versus when it asked to run — the honest
 * single-threaded saturation signal. Network rates are summed across
 * external interfaces by systeminformation (cross-platform).
 */

const SAMPLE_INTERVAL_MS = 15_000;
const MAX_SAMPLES = 1_440; // 6 hours at 15s

type TMetricSample = {
  ts: number;
  cpuSystemPercent: number;
  cpuProcessPercent: number;
  rssBytes: number;
  heapUsedBytes: number;
  elLagMs: number;
  wsConnections: number;
  voiceParticipants: number;
  netRxBps: number;
  netTxBps: number;
};

const samples: TMetricSample[] = [];

let prevCpu = process.cpuUsage();
let prevCpuAt = performance.now();

const round1 = (n: number) => Math.round(n * 10) / 10;

const collectMetricsSample = async (elLagMs = 0): Promise<TMetricSample> => {
  const now = performance.now();
  const cpu = process.cpuUsage();
  const elapsedMs = now - prevCpuAt;
  // A window under a second has no meaningful rate (the primer sample
  // right after baseline reset); report 0 instead of a division spike.
  const cpuProcessPercent =
    elapsedMs < 1000
      ? 0
      : ((cpu.user - prevCpu.user + cpu.system - prevCpu.system) /
          (elapsedMs * 1000)) *
        100;
  prevCpu = cpu;
  prevCpuAt = now;

  const [load, netStats] = await Promise.all([
    si.currentLoad().catch(() => null),
    si.networkStats('*').catch(() => [])
  ]);
  let netRxBps = 0;
  let netTxBps = 0;
  for (const iface of netStats) {
    if (iface.iface === 'lo' || iface.iface === 'lo0') continue;
    netRxBps += iface.rx_sec ?? 0;
    netTxBps += iface.tx_sec ?? 0;
  }

  const memory = process.memoryUsage();
  const sample: TMetricSample = {
    ts: Date.now(),
    cpuSystemPercent: round1(load?.currentLoad ?? 0),
    cpuProcessPercent: round1(cpuProcessPercent),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    elLagMs: round1(elLagMs),
    wsConnections: getWsStats().connections,
    voiceParticipants: VoiceRuntime.getStats().participants,
    netRxBps: Math.max(0, Math.round(netRxBps)),
    netTxBps: Math.max(0, Math.round(netTxBps))
  };

  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.shift();
  return sample;
};

let samplerStarted = false;

const startMetricsSampler = (): void => {
  if (samplerStarted) return;
  samplerStarted = true;

  // setTimeout chain instead of setInterval so each tick can measure
  // its own scheduling drift (the event-loop-lag signal) and a slow
  // tick never stacks behind the next one.
  let expected = Date.now() + SAMPLE_INTERVAL_MS;
  const tick = () => {
    const lag = Math.max(0, Date.now() - expected);
    collectMetricsSample(lag)
      .catch((err) => logger.error('[metrics] sample failed: %o', err))
      .finally(() => {
        expected = Date.now() + SAMPLE_INTERVAL_MS;
        setTimeout(tick, SAMPLE_INTERVAL_MS);
      });
  };
  // Reset the CPU baseline before priming: the module-level baseline
  // dates from import time, so the first window would otherwise cover
  // the whole boot burn and read as a >100% spike on the chart.
  prevCpu = process.cpuUsage();
  prevCpuAt = performance.now();
  // Prime immediately so the panel has a point right after boot (and
  // so systeminformation's rate baselines are initialized).
  collectMetricsSample().catch(() => {});
  setTimeout(tick, SAMPLE_INTERVAL_MS);
};

const getMetricSamples = (sinceMs: number): readonly TMetricSample[] => {
  const cutoff = Date.now() - sinceMs;
  return samples.filter((s) => s.ts >= cutoff);
};

export {
  collectMetricsSample,
  getDiskMetrics,
  getMetricSamples,
  SAMPLE_INTERVAL_MS,
  startMetricsSampler
};
export type { TMetricSample };
