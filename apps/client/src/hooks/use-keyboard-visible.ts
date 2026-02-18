import { useEffect, useState } from 'react';

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

const useKeyboardVisible = () => {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  useEffect(() => {
    const handleFocusIn = (e: FocusEvent) => {
      if (isTextInput(e.target as Element)) {
        setIsKeyboardVisible(true);
      }
    };

    const handleFocusOut = (_e: FocusEvent) => {
      // Small delay to handle focus moving between inputs
      setTimeout(() => {
        if (!isTextInput(document.activeElement)) {
          setIsKeyboardVisible(false);
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

  return isKeyboardVisible;
};

export { useKeyboardVisible };
