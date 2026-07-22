import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu';
import { Copy, Download, ExternalLink } from 'lucide-react';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';

type TImageContextMenuProps = {
  src: string;
  filename?: string;
  children: React.ReactNode;
};

/** Convert any image blob to PNG via canvas — used as a clipboard fallback. */
async function convertBlobToPng(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
        'image/png'
      )
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

const ImageContextMenu = memo(
  ({ src, filename, children }: TImageContextMenuProps) => {
    const onCopy = useCallback(async () => {
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        // First try: write the blob with its native MIME. This is the
        // happy path for PNG/JPEG/WebP — browsers accept those in the
        // clipboard and the user gets a true binary copy.
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob })
          ]);
          toast.success('Image copied');
          return;
        } catch {
          // Browser rejected the MIME (notably image/gif — every major
          // browser disallows GIF in ClipboardItem). Fall through.
        }
        // GIF (and other animated/non-allowlisted formats) special case:
        // when the source is an external URL, copy the URL as text/plain
        // instead of rasterizing. Pasting the URL into another chat app
        // produces a real animated GIF; rasterizing would lose every
        // frame after the first. For blob: URLs (E2EE-decrypted in
        // memory) the URL is only valid in this tab, so we still have
        // to rasterize and explain the limitation.
        const isAnimated = blob.type === 'image/gif';
        const isExternalUrl = /^https?:/i.test(src);
        if (isAnimated && isExternalUrl) {
          await navigator.clipboard.writeText(src);
          toast.success('GIF link copied — paste to share the animation');
          return;
        }
        const png = await convertBlobToPng(blob);
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': png })
        ]);
        toast.success(
          isAnimated
            ? 'Copied as static image (browser can’t place GIFs on the clipboard)'
            : 'Image copied'
        );
      } catch (err) {
        console.error('[ImageContextMenu] copy failed:', err);
        toast.error('Could not copy image');
      }
    }, [src]);

    const onSave = useCallback(async () => {
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename || 'image';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      } catch (err) {
        console.error('[ImageContextMenu] save failed:', err);
        toast.error('Could not save image');
      }
    }, [src, filename]);

    const onOpenNewTab = useCallback(() => {
      window.open(src, '_blank', 'noopener,noreferrer');
    }, [src]);

    return (
      // The previous shape used `<ContextMenuTrigger asChild>{children}</…>`
      // and relied on radix's Slot to forward its onContextMenu into the
      // ImageOverride child. ImageOverride is a memo'd component that only
      // accepts {src, alt} — every other prop, including the cloned
      // onContextMenu, was silently dropped. The browser's native image
      // menu fired because the radix trigger never actually saw the event.
      //
      // The fix is to mount the trigger on a real DOM node we control:
      // an explicit wrapping div that radix can attach its handler to.
      // We compose our own onContextMenu in too, so propagation stops
      // before the message-level ContextMenuTrigger upstream sees the
      // event (and opens its own menu on top of ours).
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            onContextMenu={(e) => e.stopPropagation()}
            className="contents"
          >
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem onClick={onCopy}>
            <Copy className="h-4 w-4" />
            Copy Image
          </ContextMenuItem>
          <ContextMenuItem onClick={onSave}>
            <Download className="h-4 w-4" />
            Save Image
          </ContextMenuItem>
          <ContextMenuItem onClick={onOpenNewTab}>
            <ExternalLink className="h-4 w-4" />
            Open in New Tab
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }
);

export { ImageContextMenu };
