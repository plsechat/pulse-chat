/**
 * Zoom and font scale are pushed onto <html> as CSS `zoom` and
 * `--font-scale` — no body transform (which broke fixed overlays), and
 * stored values outside the slider bounds are clamped (D32).
 *
 * Run via: bun test apps/client/src/hooks/__tests__/appearance-zoom.test.ts
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { describe, expect, test } from 'bun:test';
import {
  applyAppearanceToDOM,
  FONT_SCALE_RANGE,
  ZOOM_LEVEL_RANGE
} from '@/hooks/use-appearance-settings';

const fresh = () => document.createElement('div');

describe('applyAppearanceToDOM', () => {
  test('100 % is the neutral state: no zoom, font scale 1', () => {
    const root = fresh();
    applyAppearanceToDOM({ fontScale: 100, zoomLevel: 100 }, root);
    expect(root.style.getPropertyValue('zoom')).toBe('');
    expect(root.style.getPropertyValue('--font-scale')).toBe('1');
  });

  test('zoom is a CSS zoom percentage on the root, never a body transform', () => {
    const root = fresh();
    applyAppearanceToDOM({ fontScale: 110, zoomLevel: 120 }, root);
    expect(root.style.getPropertyValue('zoom')).toBe('120%');
    expect(root.style.getPropertyValue('--font-scale')).toBe('1.1');
    expect(document.body.style.transform).toBe('');
    expect(document.body.style.width).toBe('');
  });

  test('returning to 100 % clears the zoom that was set before', () => {
    const root = fresh();
    applyAppearanceToDOM({ fontScale: 100, zoomLevel: 90 }, root);
    expect(root.style.getPropertyValue('zoom')).toBe('90%');
    applyAppearanceToDOM({ fontScale: 100, zoomLevel: 100 }, root);
    expect(root.style.getPropertyValue('zoom')).toBe('');
  });

  test('out-of-range and malformed stored values are clamped', () => {
    const root = fresh();
    applyAppearanceToDOM({ fontScale: 500, zoomLevel: 10 }, root);
    expect(root.style.getPropertyValue('--font-scale')).toBe(
      `${FONT_SCALE_RANGE.max / 100}`
    );
    expect(root.style.getPropertyValue('zoom')).toBe(`${ZOOM_LEVEL_RANGE.min}%`);

    applyAppearanceToDOM({ fontScale: Number.NaN, zoomLevel: Number.NaN }, root);
    expect(root.style.getPropertyValue('--font-scale')).toBe('1');
    expect(root.style.getPropertyValue('zoom')).toBe('');
  });
});

/**
 * --app-zoom mirrors the zoom as a bare factor. index.css derives
 * `--vvh: calc(100dvh / var(--app-zoom))` from it, because inside a
 * zoomed root every viewport unit is multiplied by the zoom: an
 * uncorrected 100dvh shell covered 80 % of the window at 80 % and
 * overflowed it at 120 % (finding #5).
 */
describe('applyAppearanceToDOM --app-zoom', () => {
  test('is the zoom as a factor, set at every level including 100 %', () => {
    const root = fresh();
    applyAppearanceToDOM({ fontScale: 100, zoomLevel: 80 }, root);
    expect(root.style.getPropertyValue('--app-zoom')).toBe('0.8');
    applyAppearanceToDOM({ fontScale: 100, zoomLevel: 120 }, root);
    expect(root.style.getPropertyValue('--app-zoom')).toBe('1.2');
    applyAppearanceToDOM({ fontScale: 100, zoomLevel: 100 }, root);
    expect(root.style.getPropertyValue('--app-zoom')).toBe('1');
  });

  test('follows the clamped zoom, so the shell and the zoom never disagree', () => {
    const root = fresh();
    applyAppearanceToDOM({ fontScale: 100, zoomLevel: 10 }, root);
    expect(root.style.getPropertyValue('zoom')).toBe(`${ZOOM_LEVEL_RANGE.min}%`);
    expect(root.style.getPropertyValue('--app-zoom')).toBe(
      `${ZOOM_LEVEL_RANGE.min / 100}`
    );
    applyAppearanceToDOM({ fontScale: 100, zoomLevel: Number.NaN }, root);
    expect(root.style.getPropertyValue('--app-zoom')).toBe('1');
  });
});
