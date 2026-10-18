import type { LanguageFn } from 'highlight.js';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * One highlight.js instance for the app, built from `lib/core` plus a
 * curated grammar set. The package root registers all ~190 grammars
 * (~1 MB minified) although chat code blocks overwhelmingly use a
 * handful, so the common ones ship with the app and `highlightAuto`
 * only ever runs over this set. Anything else is fetched on demand by
 * `loadLanguage` when a block names it explicitly — the grammar lands
 * in its own chunk and is registered here on arrival, after which it
 * also takes part in auto-detection.
 */
const CURATED: Record<string, LanguageFn> = {
  bash,
  c,
  cpp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml
};

for (const [name, grammar] of Object.entries(CURATED)) {
  hljs.registerLanguage(name, grammar);
}

type TLanguageLoader = () => Promise<{ default: LanguageFn }>;

/**
 * Grammars available on demand. Each entry is an explicit import so
 * the bundler can see and chunk them; a template-string import would
 * not resolve through the package's export map.
 */
const LAZY_LANGUAGES: Record<string, TLanguageLoader> = {
  clojure: () => import('highlight.js/lib/languages/clojure'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  dart: () => import('highlight.js/lib/languages/dart'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  http: () => import('highlight.js/lib/languages/http'),
  ini: () => import('highlight.js/lib/languages/ini'),
  julia: () => import('highlight.js/lib/languages/julia'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  less: () => import('highlight.js/lib/languages/less'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  ocaml: () => import('highlight.js/lib/languages/ocaml'),
  perl: () => import('highlight.js/lib/languages/perl'),
  php: () => import('highlight.js/lib/languages/php'),
  plaintext: () => import('highlight.js/lib/languages/plaintext'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  properties: () => import('highlight.js/lib/languages/properties'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  r: () => import('highlight.js/lib/languages/r'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scss: () => import('highlight.js/lib/languages/scss'),
  shell: () => import('highlight.js/lib/languages/shell'),
  swift: () => import('highlight.js/lib/languages/swift'),
  vim: () => import('highlight.js/lib/languages/vim')
};

/**
 * Fence-label aliases for the lazy set. The curated grammars carry
 * their own aliases (ts, js, py, sh, ...) because highlight.js reads
 * them from the registered grammar; the lazy ones are not registered
 * yet when the alias is looked up, so the mapping lives here.
 */
const LAZY_ALIASES: Record<string, string> = {
  clj: 'clojure',
  cs: 'csharp',
  'c#': 'csharp',
  docker: 'dockerfile',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  gql: 'graphql',
  hs: 'haskell',
  toml: 'ini',
  jl: 'julia',
  kt: 'kotlin',
  kts: 'kotlin',
  make: 'makefile',
  mk: 'makefile',
  objc: 'objectivec',
  ml: 'ocaml',
  pl: 'perl',
  pm: 'perl',
  text: 'plaintext',
  txt: 'plaintext',
  ps: 'powershell',
  ps1: 'powershell',
  proto: 'protobuf',
  rb: 'ruby',
  console: 'shell',
  shellsession: 'shell'
};

const inFlight = new Map<string, Promise<string | null>>();

/** The canonical lazy grammar name for a fence label, if it has one. */
const resolveLazyLanguage = (language: string): string | undefined => {
  const key = language.toLowerCase();
  if (key in LAZY_LANGUAGES) return key;
  return LAZY_ALIASES[key];
};

/**
 * The name to hand `hljs.highlight` for a fence label: the label itself
 * when a registered grammar answers to it, else null. Checked by the
 * code block before and after a lazy load.
 */
const registeredName = (language: string): string | null => {
  if (hljs.getLanguage(language)) return language;
  const lazy = resolveLazyLanguage(language);
  return lazy && hljs.getLanguage(lazy) ? lazy : null;
};

/**
 * Register the grammar for `language` if it is in the lazy set.
 * Resolves to the registered name to highlight with, or null when the
 * label is unknown or the chunk failed to load — callers then render
 * the block unhighlighted, exactly as an unknown language renders.
 */
const loadLanguage = (language: string): Promise<string | null> => {
  const known = registeredName(language);
  if (known) return Promise.resolve(known);

  const name = resolveLazyLanguage(language);
  if (!name) return Promise.resolve(null);

  let pending = inFlight.get(name);
  if (!pending) {
    pending = LAZY_LANGUAGES[name]()
      .then((mod) => {
        if (!hljs.getLanguage(name)) hljs.registerLanguage(name, mod.default);
        return name;
      })
      .catch(() => null)
      .finally(() => inFlight.delete(name));
    inFlight.set(name, pending);
  }
  return pending;
};

export { hljs, loadLanguage, registeredName };
