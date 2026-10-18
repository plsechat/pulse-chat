/**
 * Registers happy-dom on globalThis so modules that touch the DOM
 * (DOMParser, localStorage, Node constants) can be imported in bun:test.
 * Imported first by preload.ts; keep it a standalone module so the DOM
 * globals exist before any later preload import evaluates.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();
