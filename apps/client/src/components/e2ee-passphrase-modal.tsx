import { memo, useCallback, useEffect, useState } from 'react';
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
import { restoreBackupFromServer } from '@/lib/e2ee/key-backup';
import { initE2EE } from '@/lib/e2ee';
import { toast } from 'sonner';

const E2EEPassphraseModal = memo(() => {
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('e2ee-needs-passphrase', handler);
    return () => window.removeEventListener('e2ee-needs-passphrase', handler);
  }, []);

  const handleRestore = useCallback(async () => {
    if (!passphrase) {
      setError('Please enter your backup passphrase');
      return;
    }

    setRestoring(true);
    setError('');
    try {
      await restoreBackupFromServer(passphrase);
      await initE2EE();
      setOpen(false);
      setPassphrase('');
      toast.success('Encryption keys restored from server backup');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to restore keys';
      setError(message);
    } finally {
      setRestoring(false);
    }
  }, [passphrase]);

  const handleSkip = useCallback(async () => {
    setOpen(false);
    setPassphrase('');
    setError('');
    // Generate new keys since user skipped restore
    try {
      const { signalStore } = await import('@/lib/e2ee');
      await signalStore.clearAll();
      await initE2EE();
      toast.info('New encryption keys generated');
    } catch (err) {
      console.error('Failed to generate new keys after skip:', err);
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleSkip()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore Encryption Keys</DialogTitle>
          <DialogDescription>
            A server backup of your encryption keys was found. Enter the
            passphrase you used when backing up to restore your keys. If you
            skip, new keys will be generated and old encrypted messages will be
            unreadable.
          </DialogDescription>
        </DialogHeader>

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
              if (e.key === 'Enter' && !restoring) handleRestore();
            }}
            autoFocus
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleSkip} disabled={restoring}>
            Skip
          </Button>
          <Button onClick={handleRestore} disabled={restoring}>
            {restoring ? 'Restoring...' : 'Restore Keys'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export { E2EEPassphraseModal };
