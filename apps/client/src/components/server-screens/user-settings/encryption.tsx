import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  exportKeys,
  importKeys,
  uploadBackupToServer
} from '@/lib/e2ee/key-backup';
import { hasKeys, signalStore, setupE2EEKeys, initE2EE } from '@/lib/e2ee';
import { useFilePicker } from '@/hooks/use-file-picker';
import {
  Cloud,
  Download,
  KeyRound,
  Upload,
  ShieldCheck,
  ShieldAlert
} from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

const Encryption = memo(() => {
  const [hasE2eeKeys, setHasE2eeKeys] = useState<boolean | null>(null);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exportConfirm, setExportConfirm] = useState('');
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);

  const [importPassphrase, setImportPassphrase] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const [generating, setGenerating] = useState(false);

  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [backupConfirm, setBackupConfirm] = useState('');
  const [backupError, setBackupError] = useState('');
  const [backingUp, setBackingUp] = useState(false);

  const openFilePicker = useFilePicker();

  useEffect(() => {
    hasKeys().then(setHasE2eeKeys);
  }, []);

  const handleGenerate = useCallback(async () => {
    if (hasE2eeKeys) {
      const confirmed = window.confirm(
        'Regenerating keys will make previously encrypted messages unreadable. ' +
        'Make sure you have exported a backup first. Continue?'
      );
      if (!confirmed) return;
    }

    setGenerating(true);
    try {
      if (hasE2eeKeys) {
        await signalStore.clearAll();
      }

      const { setLocalResetFlag, redistributeOwnSenderKeys } = await import(
        '@/lib/e2ee'
      );

      setLocalResetFlag(true);
      await setupE2EEKeys('generate');
      setHasE2eeKeys(true);

      // Re-distribute new sender keys to all E2EE channel members
      redistributeOwnSenderKeys()
        .catch((err) =>
          console.error('[E2EE] Failed to redistribute sender keys:', err)
        )
        .finally(() => setLocalResetFlag(false));

      toast.success(hasE2eeKeys ? 'Keys regenerated successfully' : 'Keys generated successfully');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate keys';
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  }, [hasE2eeKeys]);

  const handleExport = useCallback(async () => {
    setExportError('');

    if (exportPassphrase.length < 8) {
      setExportError('Passphrase must be at least 8 characters');
      return;
    }

    if (exportPassphrase !== exportConfirm) {
      setExportError('Passphrases do not match');
      return;
    }

    setExporting(true);
    try {
      const blob = await exportKeys(exportPassphrase);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `pulse-keys-${Date.now()}.pulse-keys`;
      link.click();
      URL.revokeObjectURL(url);

      setExportPassphrase('');
      setExportConfirm('');
      toast.success('Keys exported successfully');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to export keys';
      setExportError(message);
      toast.error(message);
    } finally {
      setExporting(false);
    }
  }, [exportPassphrase, exportConfirm]);

  const handlePickFile = useCallback(async () => {
    try {
      const files = await openFilePicker('.pulse-keys', false);
      if (files[0]) {
        setImportFile(files[0]);
        setImportError('');
      }
    } catch {
      // User cancelled picker
    }
  }, [openFilePicker]);

  const handleImport = useCallback(async () => {
    setImportError('');

    if (!importFile) {
      setImportError('Please select a backup file');
      return;
    }

    if (!importPassphrase) {
      setImportError('Please enter the backup passphrase');
      return;
    }

    setImporting(true);
    try {
      await importKeys(importFile, importPassphrase);
      await initE2EE();

      setImportFile(null);
      setImportPassphrase('');
      setHasE2eeKeys(true);
      toast.success('Keys imported successfully');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to import keys';
      setImportError(message);
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }, [importFile, importPassphrase]);

  const handleServerBackup = useCallback(async () => {
    setBackupError('');

    if (backupPassphrase.length < 8) {
      setBackupError('Passphrase must be at least 8 characters');
      return;
    }

    if (backupPassphrase !== backupConfirm) {
      setBackupError('Passphrases do not match');
      return;
    }

    setBackingUp(true);
    try {
      await uploadBackupToServer(backupPassphrase);
      setBackupPassphrase('');
      setBackupConfirm('');
      toast.success('Keys backed up to server');
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to back up keys';
      setBackupError(message);
      toast.error(message);
    } finally {
      setBackingUp(false);
    }
  }, [backupPassphrase, backupConfirm]);

  return (
    <div className="space-y-8">
      {/* Status */}
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
        {hasE2eeKeys === null ? (
          <span className="text-sm text-muted-foreground">
            Checking encryption status...
          </span>
        ) : hasE2eeKeys ? (
          <>
            <ShieldCheck className="h-5 w-5 text-green-500" />
            <div>
              <p className="text-sm font-medium">
                End-to-end encryption keys are registered
              </p>
              <p className="text-xs text-muted-foreground">
                Your DM messages are encrypted with the Signal Protocol
              </p>
            </div>
          </>
        ) : (
          <>
            <ShieldAlert className="h-5 w-5 text-yellow-500" />
            <div>
              <p className="text-sm font-medium">
                No encryption keys found on this device
              </p>
              <p className="text-xs text-muted-foreground">
                Import a backup to restore your keys, or start a DM to generate
                new ones
              </p>
            </div>
          </>
        )}
      </div>

      {/* Generate / Regenerate */}
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-medium">
            {hasE2eeKeys ? 'Regenerate Keys' : 'Generate Keys'}
          </h3>
          <p className="text-sm text-muted-foreground">
            {hasE2eeKeys
              ? 'Create a new set of encryption keys. This will invalidate your current keys — export a backup first.'
              : 'Generate new encryption keys to enable end-to-end encrypted messaging.'}
          </p>
        </div>
        <Button onClick={handleGenerate} disabled={generating || hasE2eeKeys === null}>
          <KeyRound className="mr-2 h-4 w-4" />
          {generating
            ? 'Generating...'
            : hasE2eeKeys
              ? 'Regenerate Keys'
              : 'Generate Keys'}
        </Button>
      </div>

      {/* Server Backup */}
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-medium">Server Backup</h3>
          <p className="text-sm text-muted-foreground">
            Back up your encryption keys to the server, protected by a
            passphrase. You can restore them on any device by entering the same
            passphrase during login.
          </p>
        </div>

        <div className="space-y-3">
          <Input
            type="password"
            placeholder="Passphrase (min. 8 characters)"
            value={backupPassphrase}
            onChange={(e) => {
              setBackupPassphrase(e.target.value);
              setBackupError('');
            }}
          />
          <Input
            type="password"
            placeholder="Confirm passphrase"
            value={backupConfirm}
            onChange={(e) => {
              setBackupConfirm(e.target.value);
              setBackupError('');
            }}
          />
          {backupError && (
            <p className="text-sm text-destructive">{backupError}</p>
          )}
          <Button
            onClick={handleServerBackup}
            disabled={backingUp || hasE2eeKeys === false}
          >
            <Cloud className="mr-2 h-4 w-4" />
            {backingUp ? 'Backing up...' : 'Back Up to Server'}
          </Button>
        </div>
      </div>

      {/* Export */}
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-medium">Export Keys</h3>
          <p className="text-sm text-muted-foreground">
            Create a passphrase-protected backup of your encryption keys. Store
            this file somewhere safe — you will need it to restore your keys on
            another device or after clearing browser data.
          </p>
        </div>

        <div className="space-y-3">
          <Input
            type="password"
            placeholder="Passphrase (min. 8 characters)"
            value={exportPassphrase}
            onChange={(e) => {
              setExportPassphrase(e.target.value);
              setExportError('');
            }}
          />
          <Input
            type="password"
            placeholder="Confirm passphrase"
            value={exportConfirm}
            onChange={(e) => {
              setExportConfirm(e.target.value);
              setExportError('');
            }}
          />
          {exportError && (
            <p className="text-sm text-destructive">{exportError}</p>
          )}
          <Button
            onClick={handleExport}
            disabled={exporting || hasE2eeKeys === false}
          >
            <Download className="mr-2 h-4 w-4" />
            {exporting ? 'Exporting...' : 'Export Keys'}
          </Button>
        </div>
      </div>

      {/* Import */}
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-medium">Import Keys</h3>
          <p className="text-sm text-muted-foreground">
            Restore encryption keys from a backup file. This will replace any
            existing keys on this device.
          </p>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={handlePickFile}>
              Choose File
            </Button>
            <span className="text-sm text-muted-foreground">
              {importFile ? importFile.name : 'No file selected'}
            </span>
          </div>
          <Input
            type="password"
            placeholder="Backup passphrase"
            value={importPassphrase}
            onChange={(e) => {
              setImportPassphrase(e.target.value);
              setImportError('');
            }}
          />
          {importError && (
            <p className="text-sm text-destructive">{importError}</p>
          )}
          <Button onClick={handleImport} disabled={importing}>
            <Upload className="mr-2 h-4 w-4" />
            {importing ? 'Importing...' : 'Import Keys'}
          </Button>
        </div>
      </div>

      {/* Warning */}
      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
        <p className="text-sm text-yellow-600 dark:text-yellow-400">
          <strong>Important:</strong> Your encryption keys are the only way to
          read your encrypted messages. If you lose your keys and don't have a
          backup, past encrypted messages will be permanently unreadable. Keep
          your backup file and passphrase in a secure location.
        </p>
      </div>
    </div>
  );
});

export { Encryption };
