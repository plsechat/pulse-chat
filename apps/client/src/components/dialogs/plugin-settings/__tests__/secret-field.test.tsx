/**
 * The write-only field for a `secret` plugin setting: it says whether a
 * value is set, never what it is, and the input is masked.
 *
 * Run via: bun test apps/client/src/components/dialogs/plugin-settings/__tests__/secret-field.test.tsx
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SecretSettingField } from '../secret-field';
import { secretIsSet } from '../secret-value';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const mount = (props: { isSet: boolean; draft: string; onChange: (value: string) => void }) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(SecretSettingField, { id: 'setting-botToken', ...props })));
  return container;
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('SecretSettingField', () => {
  test('a set secret is announced without its value, behind a masked input', () => {
    const el = mount({ isSet: true, draft: '', onChange: () => {} });
    const input = el.querySelector('input')!;

    expect(el.textContent).toContain('A value is set.');
    expect(el.textContent).toContain('never shown here');
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('New value');
    expect(input.getAttribute('autocomplete')).toBe('new-password');
  });

  test('an unset secret says so and takes a value; typing reaches the draft', () => {
    const typed: string[] = [];
    const el = mount({ isSet: false, draft: '', onChange: (v) => typed.push(v) });
    const input = el.querySelector('input')!;

    expect(el.textContent).toContain('No value is set yet.');
    expect(input.placeholder).toBe('Value');

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'tok-123');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(typed).toEqual(['tok-123']);
  });

  test('secretIsSet reads the masked value the route returns and nothing else', () => {
    expect(secretIsSet({ set: true })).toBe(true);
    expect(secretIsSet({ set: false })).toBe(false);
    expect(secretIsSet('tok-123')).toBe(false);
    expect(secretIsSet(undefined)).toBe(false);
  });
});
