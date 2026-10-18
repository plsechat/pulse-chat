import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import reactYouMightNotNeedAnEffect from 'eslint-plugin-react-you-might-not-need-an-effect';
import unusedImports from 'eslint-plugin-unused-imports';
import { defineConfig, globalIgnores } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Local rule (audit A8-13): an icon-only <button>/<Button> — every child
 * is a lucide icon (or a conditional between lucide icons) and there is
 * no aria-label / aria-labelledby / title — has an EMPTY accessible
 * name: lucide renders its SVGs aria-hidden and our Tooltip only sets
 * aria-describedby while open. jsx-a11y/control-has-associated-label
 * cannot see this (a self-closing component child is assumed to be a
 * label), so this complements it. Text children (incl. sr-only spans),
 * spread props and non-icon components all count as "may be labelled".
 */
const iconOnlyButtonRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Icon-only buttons must carry an accessible name (aria-label, aria-labelledby or title).'
    },
    schema: []
  },
  create(context) {
    const iconNames = new Set();
    const LABEL_ATTRS = new Set(['aria-label', 'aria-labelledby', 'title']);
    const TARGETS = new Set(['button', 'Button']);

    const jsxName = (node) =>
      node.type === 'JSXIdentifier' ? node.name : null;

    const hasLabelAttr = (opening) =>
      opening.attributes.some(
        (a) =>
          a.type === 'JSXSpreadAttribute' ||
          (a.name && a.name.type === 'JSXIdentifier' && LABEL_ATTRS.has(a.name.name))
      );

    const isAriaHidden = (opening) =>
      opening.attributes.some(
        (a) =>
          a.type === 'JSXAttribute' &&
          a.name.type === 'JSXIdentifier' &&
          a.name.name === 'aria-hidden'
      );

    /** true when `node` definitely contributes NO accessible text. */
    const isSilent = (node) => {
      if (!node) return true;
      switch (node.type) {
        case 'JSXText':
          return node.value.trim().length === 0;
        case 'JSXElement': {
          const name = jsxName(node.openingElement.name);
          if (name && iconNames.has(name) && node.children.length === 0) return true;
          if (isAriaHidden(node.openingElement)) return true;
          // A wrapper (<Tooltip>, <div>, <span>…) is only as loud as its
          // children; a self-closing non-icon component is unknown → loud.
          if (node.children.length === 0) return false;
          if (hasLabelAttr(node.openingElement)) return false;
          return node.children.every(isSilent);
        }
        case 'JSXExpressionContainer':
          return isSilentExpr(node.expression);
        default:
          return false;
      }
    };
    const isSilentExpr = (expr) => {
      if (!expr) return true;
      switch (expr.type) {
        case 'JSXEmptyExpression':
          return true;
        case 'JSXElement':
          return isSilent(expr);
        case 'ConditionalExpression':
          return isSilentExpr(expr.consequent) && isSilentExpr(expr.alternate);
        case 'LogicalExpression':
          return isSilentExpr(expr.right);
        case 'Literal':
          return expr.value === null || expr.value === false || String(expr.value).trim() === '';
        default:
          return false;
      }
    };

    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'lucide-react') return;
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportSpecifier') iconNames.add(spec.local.name);
        }
      },
      JSXElement(node) {
        const name = jsxName(node.openingElement.name);
        if (!name || !TARGETS.has(name)) return;
        if (hasLabelAttr(node.openingElement)) return;
        const children = node.children.filter(
          (c) => !(c.type === 'JSXText' && c.value.trim().length === 0)
        );
        if (children.length === 0) return;
        if (!children.every(isSilent)) return;
        context.report({
          node: node.openingElement,
          message:
            'Icon-only button has no accessible name — add aria-label (or title); lucide icons are aria-hidden.'
        });
      }
    };
  }
};

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
      pulse: { rules: { 'icon-only-button-has-label': iconOnlyButtonRule } },
      'unused-imports': unusedImports,
      'react-you-might-not-need-an-effect': reactYouMightNotNeedAnEffect
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...reactRefresh.configs.recommended.rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_'
        }
      ],
      'react-refresh/only-export-components': 'warn',
      // Accessible names (audit A8-13): every control must carry a name a
      // screen reader (and Playwright's getByRole) can read — text content,
      // aria-label/aria-labelledby, or title. lucide icons are aria-hidden,
      // so an icon-only <Button> without one of those has an EMPTY name.
      // `Button` is our shadcn wrapper; the native ignore list keeps form
      // fields (labelled by <Label>) out of scope.
      'pulse/icon-only-button-has-label': 'error',
      'jsx-a11y/control-has-associated-label': [
        'error',
        {
          controlComponents: ['Button'],
          labelAttributes: ['title', 'aria-label', 'aria-labelledby'],
          ignoreElements: ['audio', 'canvas', 'embed', 'input', 'textarea', 'tr', 'video', 'select'],
          depth: 3
        }
      ],
      // Click/key handlers belong on interactive elements (or a role that
      // makes the element interactive), never on <li>/<img>/<p>/…
      'jsx-a11y/no-noninteractive-element-interactions': [
        'error',
        {
          handlers: ['onClick', 'onError', 'onLoad', 'onMouseDown', 'onMouseUp', 'onKeyPress', 'onKeyDown', 'onKeyUp'],
          alert: ['onKeyUp', 'onKeyDown', 'onKeyPress'],
          body: ['onError', 'onLoad'],
          dialog: ['onKeyUp', 'onKeyDown', 'onKeyPress'],
          iframe: ['onError', 'onLoad'],
          img: ['onError', 'onLoad']
        }
      ]
    }
  }
]);
