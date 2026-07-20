import {
  MicNoiseGate,
  NOISE_GATE_MAX_DB,
  NOISE_GATE_MIN_DB,
  buildMicConstraints,
  dbToMeterPercent
} from '@/components/voice-provider/mic-pipeline';
import { cn } from '@/lib/utils';
import type { NoiseSuppressionMode } from '@/types';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { memo, useEffect, useRef, useState } from 'react';

type TMicMeterProps = {
  microphoneId: string | undefined;
  echoCancellation: boolean;
  autoGainControl: boolean;
  mode: NoiseSuppressionMode;
  threshold: number;
  onThresholdChange: (db: number) => void;
};

/**
 * Live input-level meter with (in manual mode) a draggable noise-gate
 * threshold on the same bar. Runs the exact same analysis/gate code the
 * call pipeline uses, so what lights up green here is what would transmit.
 */
const MicMeter = memo(
  ({
    microphoneId,
    echoCancellation,
    autoGainControl,
    mode,
    threshold,
    onThresholdChange
  }: TMicMeterProps) => {
    const [levelDb, setLevelDb] = useState(NOISE_GATE_MIN_DB);
    const [gateOpen, setGateOpen] = useState(false);
    const [micError, setMicError] = useState(false);
    const probeRef = useRef<MicNoiseGate | null>(null);
    const thresholdRef = useRef(threshold);
    thresholdRef.current = threshold;

    useEffect(() => {
      let cancelled = false;
      let stream: MediaStream | null = null;
      let probe: MicNoiseGate | null = null;

      const start = async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia(
            buildMicConstraints({
              deviceId: microphoneId,
              echoCancellation,
              autoGainControl,
              noiseSuppression: mode === 'automatic'
            })
          );

          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }

          setMicError(false);
          probe = new MicNoiseGate(thresholdRef.current);
          probe.onLevel = (db, open) => {
            setLevelDb(db);
            setGateOpen(open);
          };
          probe.setSource(stream);
          probeRef.current = probe;
        } catch {
          if (!cancelled) setMicError(true);
        }
      };

      start();

      return () => {
        cancelled = true;
        probeRef.current = null;
        probe?.destroy();
        stream?.getTracks().forEach((t) => t.stop());
        setLevelDb(NOISE_GATE_MIN_DB);
        setGateOpen(false);
      };
    }, [microphoneId, echoCancellation, autoGainControl, mode]);

    // Threshold moves adjust the live probe without re-acquiring the mic
    useEffect(() => {
      probeRef.current?.setThreshold(threshold);
    }, [threshold]);

    if (micError) {
      return (
        <p className="text-sm text-destructive">
          Microphone unavailable — check browser permissions.
        </p>
      );
    }

    const levelPercent = dbToMeterPercent(levelDb);
    const manual = mode === 'manual';
    const fillClass = manual
      ? gateOpen
        ? 'bg-emerald-500'
        : 'bg-muted-foreground/40'
      : 'bg-emerald-500';

    const meterFill = (
      <div
        className={cn(
          'absolute inset-y-0 left-0 rounded-full transition-[width] duration-75',
          fillClass
        )}
        style={{ width: `${levelPercent}%` }}
      />
    );

    return (
      <div className="w-full max-w-[500px] space-y-1.5">
        {manual ? (
          <SliderPrimitive.Root
            className="relative flex h-5 w-full touch-none select-none items-center"
            min={NOISE_GATE_MIN_DB}
            max={NOISE_GATE_MAX_DB}
            step={1}
            value={[threshold]}
            onValueChange={([value]) => onThresholdChange(value)}
          >
            <SliderPrimitive.Track className="relative h-2.5 w-full grow overflow-hidden rounded-full bg-muted">
              {meterFill}
            </SliderPrimitive.Track>
            <SliderPrimitive.Thumb
              aria-label="Noise gate threshold"
              className="block h-5 w-2.5 cursor-ew-resize rounded-full border border-border bg-foreground shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </SliderPrimitive.Root>
        ) : (
          <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted">
            {meterFill}
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          {manual ? (
            <>
              <span>
                Your mic transmits only while the level passes the handle —
                drag it just above your background noise.
              </span>
              <span className="ml-2 shrink-0 tabular-nums">
                {Math.round(threshold)} dB
              </span>
            </>
          ) : (
            <span>Input level</span>
          )}
        </div>
      </div>
    );
  }
);

MicMeter.displayName = 'MicMeter';

export { MicMeter };
