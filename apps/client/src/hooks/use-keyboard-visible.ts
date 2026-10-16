import { useEffect, useState } from 'react';
import { useVisualViewportKeyboard } from './use-visual-viewport';

const isTextInput = (el: Element | null): boolean => {
  if (!el) return false;

  if (el instanceof HTMLInputElement) {
    const textTypes = ['text', 'search', 'url', 'tel', 'email', 'password', 'number'];
    return textTypes.includes(el.type);
  }

  if (el instanceof HTMLTextAreaElement) return true;

  if (el.getAttribute('contenteditable') === 'true') return true;

  // ProseMirror (TiptapInput) uses .ProseMirror contenteditable
  if (el.closest('.ProseMirror')) return true;

  return false;
};

/**
 * Whether the soft keyboard is (probably) up. Two signals, either one
 * counts: a text field holds focus, or the visual viewport shrank by a
 * keyboard's height. The second one covers Android Back dismissing the
 * keyboard while the field keeps focus — focus alone would then keep
 * the bottom nav hidden with nothing on screen to bring it back.
 */
const useKeyboardVisible = () => {
  const [focusInText, setFocusInText] = useState(false);
  const viewportKeyboard = useVisualViewportKeyboard();
  const viewportSupported =
    typeof window !== 'undefined' && !!window.visualViewport;

  useEffect(() => {
    const handleFocusIn = (e: FocusEvent) => {
      if (isTextInput(e.target as Element)) {
        setFocusInText(true);
      }
    };

    const handleFocusOut = (_e: FocusEvent) => {
      // Small delay to handle focus moving between inputs
      setTimeout(() => {
        if (!isTextInput(document.activeElement)) {
          setFocusInText(false);
        }
      }, 100);
    };

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);

    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
    };
  }, []);

  // Where the viewport reports (touch devices with visualViewport) it
  // is the truth — focus can outlive the keyboard; elsewhere focus is
  // all there is.
  return viewportSupported ? viewportKeyboard : focusInText;
};

export { useKeyboardVisible };
