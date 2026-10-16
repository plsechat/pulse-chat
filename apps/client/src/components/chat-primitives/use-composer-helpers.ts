import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useUploadFiles } from '@/hooks/use-upload-files';
import { throttle } from 'lodash-es';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';

/**
 * The composer plumbing both chat orchestrators (channel-view/text and
 * home-view/dm-conversation) used to carry as identical copies: the
 * editor focus helpers, the hidden file input, the staged-attachment
 * removal, and the GIF-send envelope (audit A8-17).
 *
 * What differs per surface stays with the caller and is handed in as
 * plain callbacks: HOW a GIF is sent (`sendGif`: channel encrypts and
 * posts through the server client, DM goes through sendDmMessage),
 * WHERE a removed temp upload is deleted (`deleteTemporaryFile`), and
 * the scroll controller (`detached`/`reattach`/`scrollToBottom`).
 *
 * `useUploadFiles` is called in here because its `onAfterUpload`
 * callback wants `focusEditor`, which needs `inputAreaRef` — the two
 * cannot be created in the caller without the ref/callback pair being
 * written twice. Everything the caller needs from the upload hook is
 * returned alongside.
 *
 * The options object is read through a ref at call time, so every
 * returned callback has a STABLE identity: the drifted `handleReply`
 * dependency arrays the audit found (A8-20) cannot recur because the
 * callers no longer own those closures.
 */
type TComposerHelpersOptions = {
  /** Uploads refused (no permission / read-only preview). */
  uploadDisabled: boolean;
  isE2ee: boolean;
  /** Send `gifUrl` as a message on this surface (may throw). */
  sendGif: (gifUrl: string) => Promise<void>;
  /** Runs after a successful GIF send (e.g. clear the reply target). */
  onGifSent?: () => void;
  /** Server-side delete of a staged temp upload the user removed. */
  deleteTemporaryFile?: (fileId: string) => Promise<unknown>;
  detached: boolean;
  reattach: () => Promise<void>;
  scrollToBottom: () => void;
};

const useComposerHelpers = (options: TComposerHelpersOptions) => {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const inputAreaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const focusEditor = useCallback(() => {
    requestAnimationFrame(() => {
      inputAreaRef.current
        ?.querySelector<HTMLElement>('.ProseMirror')
        ?.focus();
    });
  }, []);

  /** Reply affordance: focus the editor AND land on the live tail. */
  const focusEditorAtBottom = useCallback(() => {
    requestAnimationFrame(() => {
      inputAreaRef.current
        ?.querySelector<HTMLElement>('.ProseMirror')
        ?.focus();
      optionsRef.current.scrollToBottom();
    });
  }, []);

  const upload = useUploadFiles(
    options.uploadDisabled,
    options.isE2ee,
    focusEditor
  );
  const { handleUploadFiles, removeFile } = upload;

  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFiles = Array.from(e.target.files ?? []);
      if (selectedFiles.length > 0) {
        handleUploadFiles(selectedFiles);
      }
      // Same file picked twice in a row must fire change again.
      e.target.value = '';
    },
    [handleUploadFiles]
  );

  const onRemoveFileClick = useCallback(
    (fileId: string) => {
      removeFile(fileId);
      const del = optionsRef.current.deleteTemporaryFile;
      if (!del) return;
      // Best-effort: the staged upload is gone from the composer either
      // way; an orphaned temp file is reaped server-side.
      del(fileId).catch(() => {});
    },
    [removeFile]
  );

  const onGifSelect = useCallback(async (gifUrl: string) => {
    const { sendGif, onGifSent, detached, reattach, scrollToBottom } =
      optionsRef.current;
    try {
      await sendGif(gifUrl);
      onGifSent?.();
      if (detached) {
        // Sent from deep in history: the echo lands beyond the detached
        // window, so rejoin the live tail to show it.
        await reattach();
        requestAnimationFrame(scrollToBottom);
      }
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to send GIF'));
    }
  }, []);

  return {
    inputAreaRef,
    fileInputRef,
    focusEditor,
    focusEditorAtBottom,
    onFileInputChange,
    onRemoveFileClick,
    onGifSelect,
    ...upload
  };
};

/**
 * Throttled "I'm typing" signal: at most one `send` per `ms`, with the
 * trailing call lodash's throttle allows. The throttle is rebuilt when
 * `send` or `ms` changes (so a channel switch never signals the old
 * channel) and cancelled on unmount; callers cancel it themselves on a
 * successful send. `send` should be a stable useCallback.
 */
const useTypingSignal = (send: () => void | Promise<void>, ms: number) => {
  const throttled = useMemo(
    () =>
      throttle(() => {
        void send();
      }, ms),
    [send, ms]
  );

  useEffect(() => () => throttled.cancel(), [throttled]);

  return throttled;
};

export { useComposerHelpers, useTypingSignal };
