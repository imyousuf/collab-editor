import { describe, test, expect, vi } from 'vitest';
import type { IEditorBinding, EditorMode } from '../../interfaces/editor-binding.js';

/**
 * Contract tests for IEditorBinding implementations.
 * Call this function once per binding class to verify it meets the interface contract.
 *
 * Note: These tests create a real DOM container via jsdom.
 * Bindings that require browser-only APIs (CodeMirror, Tiptap) should
 * be tested with mocked internals in their own test files.
 */
export function editorBindingContractTests(
  name: string,
  createBinding: () => IEditorBinding,
  options: {
    expectedModes: readonly EditorMode[];
    defaultMode: EditorMode;
    canMount: boolean; // false if the binding requires real browser APIs not in jsdom
  },
) {
  describe(`IEditorBinding contract: ${name}`, () => {
    test('supportedModes is non-empty', () => {
      const binding = createBinding();
      expect(binding.supportedModes.length).toBeGreaterThan(0);
    });

    test('supportedModes matches expected', () => {
      const binding = createBinding();
      expect([...binding.supportedModes].sort()).toEqual([...options.expectedModes].sort());
    });

    test('activeMode is null before mount', () => {
      const binding = createBinding();
      expect(binding.activeMode).toBeNull();
    });

    test('mounted is false before mount', () => {
      const binding = createBinding();
      expect(binding.mounted).toBe(false);
    });

    if (options.canMount) {
      test('mount resolves and sets mounted=true', async () => {
        const binding = createBinding();
        const container = document.createElement('div');
        await binding.mount(container, options.defaultMode, { readonly: false, theme: 'light' });
        expect(binding.mounted).toBe(true);
        expect(binding.activeMode).toBe(options.defaultMode);
        binding.destroy();
      });

      test('getContent returns a string after mount', async () => {
        const binding = createBinding();
        const container = document.createElement('div');
        await binding.mount(container, options.defaultMode, { readonly: false, theme: 'light' });
        expect(typeof binding.getContent()).toBe('string');
        binding.destroy();
      });

      test('setContent then getContent returns the content', async () => {
        const binding = createBinding();
        const container = document.createElement('div');
        await binding.mount(container, options.defaultMode, { readonly: false, theme: 'light' });
        binding.setContent('test content 123');
        expect(binding.getContent()).toContain('test content 123');
        binding.destroy();
      });

      test('onContentChange returns an unsubscribe function', async () => {
        const binding = createBinding();
        const container = document.createElement('div');
        await binding.mount(container, options.defaultMode, { readonly: false, theme: 'light' });
        const callback = vi.fn();
        const unsub = binding.onContentChange(callback);
        expect(typeof unsub).toBe('function');
        unsub();
        binding.destroy();
      });

      test('onRemoteChange returns an unsubscribe function', async () => {
        const binding = createBinding();
        const container = document.createElement('div');
        await binding.mount(container, options.defaultMode, { readonly: false, theme: 'light' });
        const callback = vi.fn();
        const unsub = binding.onRemoteChange(callback);
        expect(typeof unsub).toBe('function');
        unsub();
        binding.destroy();
      });

      test('unmount sets mounted=false and activeMode=null', async () => {
        const binding = createBinding();
        const container = document.createElement('div');
        await binding.mount(container, options.defaultMode, { readonly: false, theme: 'light' });
        binding.unmount();
        expect(binding.mounted).toBe(false);
        expect(binding.activeMode).toBeNull();
        binding.destroy();
      });

      test('destroy after unmount does not throw', async () => {
        const binding = createBinding();
        const container = document.createElement('div');
        await binding.mount(container, options.defaultMode, { readonly: false, theme: 'light' });
        binding.unmount();
        expect(() => binding.destroy()).not.toThrow();
      });
    }

    test('destroy without mount does not throw', () => {
      const binding = createBinding();
      expect(() => binding.destroy()).not.toThrow();
    });

    test('switchMode rejects unsupported mode', async () => {
      const binding = createBinding();
      const unsupported = (['wysiwyg', 'source', 'preview'] as EditorMode[])
        .find(m => !binding.supportedModes.includes(m));
      if (unsupported) {
        await expect(binding.switchMode(unsupported)).rejects.toThrow();
      }
      binding.destroy();
    });
  });
}
