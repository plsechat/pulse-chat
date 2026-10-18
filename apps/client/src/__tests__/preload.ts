/**
 * bun:test preload for the client workspace (wired via bunfig.toml).
 *
 * Import order is load-bearing: register-dom installs the happy-dom
 * globals first, then the in-memory indexedDB shim is layered on top so
 * the registrator cannot clobber it and the e2ee store tests see a
 * working `indexedDB`. Static imports evaluate in source order, so the
 * DOM module has fully run before fake-indexeddb executes.
 */
import './register-dom';
import 'fake-indexeddb/auto';
