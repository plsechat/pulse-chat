import {
  getLocalStorageItem,
  LocalStorageKey,
  setLocalStorageItem
} from '@/helpers/storage';
import { useSyncExternalStore } from 'react';
import type { TActiveView } from './slice';

/**
 * State of the "deck" layout: which communities are open as tabs across
 * the top, which right-hand panel is open, and a back/forward history of
 * visited tabs. The ACTIVE tab is never stored here — it is derived from
 * the app slice (active view, server, instance), so there is one source
 * of truth for what is on screen; this module only orders and remembers.
 *
 * Tab keys: `home` · `discover` · `server:<id>` · `fed:<domain>:<id>`.
 */

type TDeckPanel = 'friends' | 'messages' | 'inbox' | 'profile';
type TMessagesView = 'list' | 'conversation';

type TDeckState = {
  /** Open community tabs, in display order. `home` is implicit and first. */
  tabs: string[];
  panel: TDeckPanel | null;
  panelWidth: number;
  panelExpanded: boolean;
  messagesView: TMessagesView;
  history: string[];
  historyIndex: number;
};

const PANEL_MIN = 320;
const PANEL_MAX = 720;
const PANEL_DEFAULT = 400;
const PANEL_EXPANDED = 720;
const HISTORY_MAX = 50;

const tabKeyFor = (
  view: TActiveView,
  serverId: number | undefined,
  instanceDomain: string | null
): string => {
  if (view === 'discover') return 'discover';
  if (view === 'server' && serverId !== undefined) {
    return instanceDomain
      ? `fed:${instanceDomain}:${serverId}`
      : `server:${serverId}`;
  }
  return 'home';
};

type TParsedTabKey =
  | { kind: 'home' }
  | { kind: 'discover' }
  | { kind: 'server'; serverId: number }
  | { kind: 'fed'; instanceDomain: string; serverId: number };

const parseTabKey = (key: string): TParsedTabKey => {
  if (key === 'discover') return { kind: 'discover' };
  if (key.startsWith('server:')) {
    return { kind: 'server', serverId: Number(key.slice('server:'.length)) };
  }
  if (key.startsWith('fed:')) {
    const rest = key.slice('fed:'.length);
    const at = rest.lastIndexOf(':');
    return {
      kind: 'fed',
      instanceDomain: rest.slice(0, at),
      serverId: Number(rest.slice(at + 1))
    };
  }
  return { kind: 'home' };
};

/**
 * Which tab takes focus when `closing` is closed while `active` is on
 * screen: the neighbour to the right, else the left, else home. Closing
 * an inactive tab changes nothing (returns the active key).
 */
const nextActiveAfterClose = (
  tabs: string[],
  closing: string,
  active: string
): string => {
  if (closing !== active) return active;
  const index = tabs.indexOf(closing);
  if (index === -1) return active;
  return tabs[index + 1] ?? tabs[index - 1] ?? 'home';
};

const readTabs = (): string[] => {
  try {
    const raw = getLocalStorageItem(LocalStorageKey.DECK_TABS);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === 'string' && t !== 'home')
      : [];
  } catch {
    return [];
  }
};

const readPanelWidth = (): number => {
  const raw = Number(getLocalStorageItem(LocalStorageKey.DECK_PANEL_WIDTH));
  return Number.isFinite(raw) && raw >= PANEL_MIN && raw <= PANEL_MAX
    ? raw
    : PANEL_DEFAULT;
};

let state: TDeckState = {
  tabs: readTabs(),
  panel: null,
  panelWidth: readPanelWidth(),
  panelExpanded: false,
  messagesView: 'list',
  history: [],
  historyIndex: -1
};

const listeners = new Set<() => void>();

const setState = (patch: Partial<TDeckState>) => {
  state = { ...state, ...patch };
  if (patch.tabs) {
    setLocalStorageItem(LocalStorageKey.DECK_TABS, JSON.stringify(state.tabs));
  }
  if (patch.panelWidth !== undefined) {
    setLocalStorageItem(
      LocalStorageKey.DECK_PANEL_WIDTH,
      String(state.panelWidth)
    );
  }
  listeners.forEach((l) => l());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getDeckState = () => state;

const useDeck = () => useSyncExternalStore(subscribe, getDeckState);

/** Adds a tab at the end if it is not open yet. `home` is never stored. */
const openTab = (key: string) => {
  if (key === 'home' || state.tabs.includes(key)) return;
  setState({ tabs: [...state.tabs, key] });
};

const closeTab = (key: string) => {
  if (!state.tabs.includes(key)) return;
  setState({ tabs: state.tabs.filter((t) => t !== key) });
};

const moveTab = (from: number, to: number) => {
  if (from === to || from < 0 || to < 0) return;
  if (from >= state.tabs.length || to >= state.tabs.length) return;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved!);
  setState({ tabs });
};

const setPanel = (panel: TDeckPanel | null) => {
  if (panel === state.panel) return;
  setState({ panel });
};

const togglePanel = (panel: TDeckPanel) => {
  setState({ panel: state.panel === panel ? null : panel });
};

const setPanelWidth = (width: number) => {
  const clamped = Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(width)));
  if (clamped === state.panelWidth) return;
  setState({ panelWidth: clamped });
};

const togglePanelExpanded = () => {
  setState({ panelExpanded: !state.panelExpanded });
};

const setMessagesView = (view: TMessagesView) => {
  if (view === state.messagesView) return;
  setState({ messagesView: view });
};

/** Opens the Messages panel on one conversation. */
const openConversationPanel = () => {
  setState({ panel: 'messages', messagesView: 'conversation' });
};

// Back/forward navigate by re-activating a visited tab; the activation
// flows back through recordVisit, which must not push a new entry then.
let navigating = false;

const recordVisit = (key: string) => {
  if (navigating) {
    navigating = false;
    // The activation a step asked for: already at this entry. Anything
    // else means the step did not land (switch failed) and this is a
    // genuine visit.
    if (state.history[state.historyIndex] === key) return;
  }
  if (state.history[state.historyIndex] === key) return;
  const history = [
    ...state.history.slice(0, state.historyIndex + 1),
    key
  ].slice(-HISTORY_MAX);
  setState({ history, historyIndex: history.length - 1 });
};

const canGoBack = () => state.historyIndex > 0;
const canGoForward = () => state.historyIndex < state.history.length - 1;

/** Steps the history pointer and returns the key to activate, if any. */
const stepHistory = (direction: -1 | 1): string | undefined => {
  const next = state.historyIndex + direction;
  if (next < 0 || next >= state.history.length) return undefined;
  navigating = true;
  setState({ historyIndex: next });
  return state.history[next];
};

/** Drops a tab from the history too (the community was left). */
const forgetTab = (key: string) => {
  if (!state.history.includes(key)) return;
  const history = state.history.filter((k) => k !== key);
  setState({
    history,
    historyIndex: Math.min(state.historyIndex, history.length - 1)
  });
};

/** Test-only: resets to a clean state. */
const resetDeckForTests = () => {
  navigating = false;
  state = {
    tabs: [],
    panel: null,
    panelWidth: PANEL_DEFAULT,
    panelExpanded: false,
    messagesView: 'list',
    history: [],
    historyIndex: -1
  };
  listeners.forEach((l) => l());
};

export {
  canGoBack,
  canGoForward,
  closeTab,
  forgetTab,
  moveTab,
  nextActiveAfterClose,
  openConversationPanel,
  openTab,
  PANEL_EXPANDED,
  PANEL_MAX,
  PANEL_MIN,
  parseTabKey,
  recordVisit,
  resetDeckForTests,
  setMessagesView,
  setPanel,
  setPanelWidth,
  stepHistory,
  tabKeyFor,
  togglePanel,
  togglePanelExpanded,
  useDeck
};
export type { TDeckPanel };
