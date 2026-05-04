import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

const VIEWPORT_PX = 320;
const OUTPUT_PX = 256;
const MAX_ZOOM = 4;
// Output PNG quality knob — 1.0 keeps the crop lossless. We're already
// downscaling to 256x256, so re-encoding at full quality is fine.
const OUTPUT_TYPE = 'image/png';

type TAvatarCropDialogProps = {
  /**
   * The raw file the user picked. The dialog reads it via an object
   * URL and never holds onto the original beyond `onConfirm`.
   */
  file: File;
  open: boolean;
  onConfirm: (cropped: File) => void;
  onCancel: () => void;
};

/**
 * In-app crop step that runs between "user picked a file" and the
 * upload mutation. The viewport is a fixed 320px square; the loaded
 * image is rendered with a CSS transform driven by `position` (in
 * viewport pixels) and `zoom` (multiplier on the natural-size fit).
 *
 * The fit-to-cover scale (the minimum zoom — 1.0) is computed at
 * load time so the image always fully fills the viewport regardless
 * of whether it's portrait, landscape, or square. Pan is clamped at
 * each interaction so the image edges never move inside the
 * viewport — there's no way to leave a black gap on output.
 */
const AvatarCropDialog = memo(
  ({ file, open, onConfirm, onCancel }: TAvatarCropDialogProps) => {
    const objectUrl = useMemo(() => URL.createObjectURL(file), [file]);
    useEffect(() => () => URL.revokeObjectURL(objectUrl), [objectUrl]);

    const imgRef = useRef<HTMLImageElement | null>(null);
    const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(
      null
    );
    const [zoom, setZoom] = useState(1);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const dragRef = useRef<{
      startX: number;
      startY: number;
      origX: number;
      origY: number;
    } | null>(null);

    const fitScale = useMemo(() => {
      if (!imgNatural) return 1;
      // Cover-fit: scale so the smaller of the two natural axes maps to
      // exactly the viewport edge. The other axis overflows and pans.
      return Math.max(VIEWPORT_PX / imgNatural.w, VIEWPORT_PX / imgNatural.h);
    }, [imgNatural]);

    const effectiveScale = fitScale * zoom;

    // Pan clamp: the image must always cover the viewport. If image's
    // displayed width is W*effectiveScale and the image is centered at
    // position, the visible left edge is at -W*effectiveScale/2 - position.x
    // (relative to viewport center). We need the image's left edge to be
    // ≤ -VIEWPORT_PX/2 and right edge ≥ VIEWPORT_PX/2.
    const clampPosition = useCallback(
      (next: { x: number; y: number }) => {
        if (!imgNatural) return next;
        const dispW = imgNatural.w * effectiveScale;
        const dispH = imgNatural.h * effectiveScale;
        const maxX = Math.max(0, (dispW - VIEWPORT_PX) / 2);
        const maxY = Math.max(0, (dispH - VIEWPORT_PX) / 2);
        return {
          x: Math.max(-maxX, Math.min(maxX, next.x)),
          y: Math.max(-maxY, Math.min(maxY, next.y))
        };
      },
      [imgNatural, effectiveScale]
    );

    // Re-clamp whenever zoom changes — zooming out can otherwise leave
    // the image off-center beyond what the new scale allows.
    useEffect(() => {
      setPosition((prev) => clampPosition(prev));
    }, [clampPosition]);

    const handleImgLoad = useCallback(() => {
      const img = imgRef.current;
      if (!img) return;
      setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
      setPosition({ x: 0, y: 0 });
      setZoom(1);
    }, []);

    const handlePointerDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          origX: position.x,
          origY: position.y
        };
      },
      [position]
    );

    const handlePointerMove = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragRef.current) return;
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        setPosition(
          clampPosition({
            x: dragRef.current.origX + dx,
            y: dragRef.current.origY + dy
          })
        );
      },
      [clampPosition]
    );

    const handlePointerUp = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        dragRef.current = null;
      },
      []
    );

    const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      // 1 wheel notch ≈ 100px deltaY in most browsers; map to 8% zoom
      const delta = -e.deltaY * 0.0008;
      setZoom((z) => Math.max(1, Math.min(MAX_ZOOM, z + delta * z)));
    }, []);

    const handleConfirm = useCallback(async () => {
      const img = imgRef.current;
      if (!img || !imgNatural) return;
      // Map viewport coordinates back to the source image.
      // The image is centered at (VIEWPORT_PX/2 + position.x,
      // VIEWPORT_PX/2 + position.y) and scaled by `effectiveScale`.
      // The viewport's top-left in image coords is therefore:
      const sx =
        (imgNatural.w * effectiveScale - VIEWPORT_PX) / 2 / effectiveScale -
        position.x / effectiveScale;
      const sy =
        (imgNatural.h * effectiveScale - VIEWPORT_PX) / 2 / effectiveScale -
        position.y / effectiveScale;
      const sSize = VIEWPORT_PX / effectiveScale;

      const canvas = document.createElement('canvas');
      canvas.width = OUTPUT_PX;
      canvas.height = OUTPUT_PX;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUTPUT_PX, OUTPUT_PX);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), OUTPUT_TYPE, 1)
      );
      if (!blob) return;
      const cropped = new File([blob], `avatar-${Date.now()}.png`, {
        type: OUTPUT_TYPE
      });
      onConfirm(cropped);
    }, [effectiveScale, imgNatural, onConfirm, position.x, position.y]);

    return (
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) onCancel();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Crop your avatar</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col items-center gap-4 py-2">
            <div
              className="relative overflow-hidden rounded-full bg-muted touch-none cursor-grab active:cursor-grabbing select-none"
              style={{ width: VIEWPORT_PX, height: VIEWPORT_PX }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onWheel={handleWheel}
            >
              <img
                ref={imgRef}
                src={objectUrl}
                alt=""
                onLoad={handleImgLoad}
                draggable={false}
                className="absolute left-1/2 top-1/2 max-w-none pointer-events-none"
                style={{
                  width: imgNatural ? imgNatural.w : 'auto',
                  height: imgNatural ? imgNatural.h : 'auto',
                  transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px) scale(${effectiveScale})`,
                  transformOrigin: 'center center'
                }}
              />
            </div>

            <div className="w-full space-y-1">
              <label className="text-xs text-muted-foreground">Zoom</label>
              <Slider
                min={1}
                max={MAX_ZOOM}
                step={0.05}
                value={[zoom]}
                onValueChange={([v]) => setZoom(v)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={handleConfirm} disabled={!imgNatural}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

AvatarCropDialog.displayName = 'AvatarCropDialog';

export { AvatarCropDialog };
