import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { setupE2EEKeys } from '@/lib/e2ee';
import { getHomeTRPCClient } from '@/lib/trpc';
import { toast } from 'sonner';
import { AlertTriangle, KeyRound, Loader2 } from 'lucide-react';

type Step = 'choosing' | 'confirm-regenerate' | 'processing';

const E2EESetupModal = memo(() => {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('choosing');
  const [hasBackup, setHasBackup] = useState<boolean | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');

  const resolveRef = useRef<(() => void) | null>(null);
  const rejectRef = useRef<((err: Error) => void) | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        resolve: () => void;
        reject: (err: Error) => void;
      };
      resolveRef.current = detail.resolve;
      rejectRef.current = detail.reject;
      setOpen(true);
      setStep('choosing');
      setPassphrase('');
      setError('');
      setHasBackup(null);

      // Query whether a server backup exists
      getHomeTRPCClient()
        .e2ee.hasKeyBackup.query()
        .then(setHasBackup)
        .catch(() => setHasBackup(false));
    };
    window.addEventListener('e2ee-setup-needed', handler);
    return () => window.removeEventListener('e2ee-setup-needed', handler);
  }, []);

  const handleCancel = useCallback(() => {
    setOpen(false);
    rejectRef.current?.(new Error('E2EE setup cancelled'));
    resolveRef.current = null;
    rejectRef.current = null;
  }, []);

  const handleRestore = useCallback(async () => {
    if (!passphrase) {
      setError('Please enter your backup passphrase');
      return;
    }

    setStep('processing');
    setError('');
    try {
      await setupE2EEKeys('restore', passphrase);
      setOpen(false);
      toast.success('Encryption keys restored from server backup');
      resolveRef.current?.();
    } catch (err) {
      setStep('choosing');
      setError(err instanceof Error ? err.message : 'Failed to restore keys');
    }
  }, [passphrase]);

  const handleGenerate = useCallback(async () => {
    setStep('processing');
    setError('');
    try {
      await setupE2EEKeys('generate');
      setOpen(false);
      toast.success(
        'Encryption keys generated. Back up your keys in Settings > Encryption.'
      );
      resolveRef.current?.();
    } catch (err) {
      setStep('choosing');
      setError(err instanceof Error ? err.message : 'Failed to generate keys');
    }
  }, []);

  const handleGenerateClick = useCallback(() => {
    if (hasBackup) {
      setStep('confirm-regenerate');
    } else {
      handleGenerate();
    }
  }, [hasBackup, handleGenerate]);

  // Loading state while querying backup status
  if (open && hasBackup === null) {
    return (
      <Dialog open onOpenChange={() => handleCancel()}>
        <DialogContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && step !== 'processing') handleCancel();
      }}
    >
      <DialogContent>
        {step === 'choosing' && (
          <>
            <DialogHeader>
              <DialogTitle>Set Up Encryption</DialogTitle>
              <DialogDescription>
                {hasBackup
                  ? 'A server backup of your encryption keys was found. Restore your keys to decrypt previous messages, or generate new keys.'
                  : 'End-to-end encryption requires keys on this device. Generate new keys to get started.'}
              </DialogDescription>
            </DialogHeader>

            {hasBackup && (
              <div className="space-y-3 py-2">
                <Input
                  type="password"
                  placeholder="Backup passphrase"
                  value={passphrase}
                  onChange={(e) => {
                    setPassphrase(e.target.value);
                    setError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRestore();
                  }}
                  autoFocus
                />
                {error && <p className="text-sm text-destructive">{error}</p>}
              </div>
            )}

            {!hasBackup && error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              {hasBackup ? (
                <>
                  <Button
                    variant="outline"
                    onClick={handleGenerateClick}
                  >
                    <KeyRound className="mr-2 h-4 w-4" />
                    Generate New Keys
                  </Button>
                  <Button onClick={handleRestore}>Restore Keys</Button>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={handleCancel}>
                    Cancel
                  </Button>
                  <Button onClick={handleGenerateClick}>
                    <KeyRound className="mr-2 h-4 w-4" />
                    Generate Keys
                  </Button>
                </>
              )}
            </DialogFooter>
          </>
        )}

        {step === 'confirm-regenerate' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-yellow-500" />
                Generate New Keys?
              </DialogTitle>
              <DialogDescription>
                This will create new encryption keys. Messages encrypted with
                your previous keys will be unreadable on this device.
              </DialogDescription>
            </DialogHeader>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                variant="outline"
                onClick={() => setStep('choosing')}
              >
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleGenerate}>
                I understand, generate new keys
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'processing' && (
          <div className="flex flex-col items-center justify-center gap-3 py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Setting up encryption keys...
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
});

export { E2EESetupModal };
