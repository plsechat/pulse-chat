import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { defineConfig } from 'vite';
import pkg from './package.json';

/**
 * Vendor chunking. Each group is a library family that changes on its
 * own release cadence, so splitting it out lets a returning browser
 * reuse the cached vendor file across app releases (the app chunk
 * changes every release; these rarely do). A group that only lazy
 * screens import — emoji data, mediasoup, supabase — stays out of the
 * initial download because nothing on the critical path imports it.
 *
 * `vendor-misc` is the catch-all for the remaining node_modules code,
 * restricted to modules the entry reaches through STATIC imports: a
 * library used only by a lazily loaded screen must land next to that
 * screen, not be hoisted into a chunk the first paint waits on.
 */
const VENDOR_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['vendor-react', ['react/', 'react-dom/', 'scheduler/', 'react-is/']],
  ['vendor-radix', ['@radix-ui/']],
  ['vendor-tiptap', ['@tiptap/', 'prosemirror-']],
  [
    'vendor-signal',
    ['@privacyresearch/', 'protobufjs/', '@protobufjs/', 'long/', 'base64-js/']
  ],
  [
    'vendor-mediasoup',
    [
      'mediasoup-client/',
      'sdp-transform/',
      'h264-profile-level-id/',
      'awaitqueue/',
      'fake-mediastreamtrack/'
    ]
  ],
  ['vendor-emoji', ['emoji-mart/', '@emoji-mart/']],
  ['vendor-supabase', ['@supabase/']]
];

const NODE_MODULES = '/node_modules/';

type TModuleInfoLookup = (id: string) => {
  isEntry: boolean;
  importers: readonly string[];
} | null;

/**
 * Whether `id` is reachable from an entry through static imports only.
 * Walks the static `importers` edges upward; a module whose every
 * import chain passes through a dynamic import() is lazy and must not
 * be grouped into the eagerly loaded vendor chunk.
 */
const createInitialGraphCheck = (getModuleInfo: TModuleInfoLookup) => {
  const memo = new Map<string, boolean>();

  const isInitial = (id: string, visiting: Set<string>): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return false;
    visiting.add(id);

    const info = getModuleInfo(id);
    let result = false;
    if (info) {
      result =
        info.isEntry ||
        info.importers.some((importer) => isInitial(importer, visiting));
    }

    visiting.delete(id);
    memo.set(id, result);
    return result;
  };

  return (id: string) => isInitial(id, new Set());
};

// One reachability memo per build: manualChunks is called once per
// module, and the walk is shared across those calls.
let initialGraphCheck: {
  lookup: TModuleInfoLookup;
  isInitial: (id: string) => boolean;
} | null = null;

const isInitialModule = (id: string, getModuleInfo: TModuleInfoLookup) => {
  if (initialGraphCheck?.lookup !== getModuleInfo) {
    initialGraphCheck = {
      lookup: getModuleInfo,
      isInitial: createInitialGraphCheck(getModuleInfo)
    };
  }
  return initialGraphCheck.isInitial(id);
};

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    target: 'esnext',
    // Read by scripts/check-bundle-size.ts: the manifest records each
    // chunk's static vs dynamic imports, which is how the size gate
    // tells the initial download from lazily loaded screens.
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id, { getModuleInfo }) {
          const at = id.lastIndexOf(NODE_MODULES);
          if (at === -1) return undefined;

          const packagePath = id.slice(at + NODE_MODULES.length);
          for (const [chunk, prefixes] of VENDOR_GROUPS) {
            if (prefixes.some((prefix) => packagePath.startsWith(prefix))) {
              return chunk;
            }
          }

          return isInitialModule(id, getModuleInfo) ? 'vendor-misc' : undefined;
        }
      }
    }
  },
  esbuild: {
    // Strip chatty/dev-time logging in production but keep warn/error —
    // those communicate real failures a user might surface to us. The
    // original `drop: ['console']` stripped EVERY console method, which
    // also silenced `console.warn` / `console.error`, making prod
    // failures invisible to anyone reading DevTools.
    pure: mode === 'production'
      ? ['console.log', 'console.debug', 'console.info', 'console.trace']
      : [],
    drop: mode === 'production' ? ['debugger'] : []
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  define: {
    VITE_APP_VERSION: JSON.stringify(pkg.version)
  }
}));
