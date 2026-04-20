import { describe, test, expect, vi } from 'vitest';
import { editorBindingContractTests } from '../interfaces/editor-binding.contract.js';
import { DualModeBinding } from '../../bindings/dual-mode-binding.js';
import { HtmlContentHandler } from '../../handlers/html-handler.js';
import { MarkdownContentHandler } from '../../handlers/markdown-handler.js';

const htmlHandler = new HtmlContentHandler();
const mdHandler = new MarkdownContentHandler();

// Run interface contract tests for HTML binding
editorBindingContractTests(
  'DualModeBinding (html)',
  () => new DualModeBinding(htmlHandler, 'html'),
  {
    expectedModes: ['wysiwyg', 'source'],
    defaultMode: 'source', // source mode is safer for jsdom (CodeMirror)
    canMount: true,
  },
);

// Run interface contract tests for Markdown binding
editorBindingContractTests(
  'DualModeBinding (markdown)',
  () => new DualModeBinding(mdHandler, 'markdown'),
  {
    expectedModes: ['wysiwyg', 'source'],
    defaultMode: 'source',
    canMount: true,
  },
);

describe('DualModeBinding unit tests', () => {
  test('mount in source mode creates CodeMirror', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    expect(binding.mounted).toBe(true);
    expect(binding.activeMode).toBe('source');
    // Container should have child elements (editor DOM)
    expect(container.children.length).toBeGreaterThan(0);

    binding.destroy();
  });

  test('mount in wysiwyg mode creates Tiptap', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'wysiwyg', { readonly: false, theme: 'light' });

    expect(binding.mounted).toBe(true);
    expect(binding.activeMode).toBe('wysiwyg');

    binding.destroy();
  });

  test('mount rejects preview mode', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await expect(
      binding.mount(container, 'preview', { readonly: false, theme: 'light' }),
    ).rejects.toThrow();
    binding.destroy();
  });

  test('switchMode between source and wysiwyg', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    expect(binding.activeMode).toBe('source');
    await binding.switchMode('wysiwyg');
    expect(binding.activeMode).toBe('wysiwyg');
    await binding.switchMode('source');
    expect(binding.activeMode).toBe('source');

    binding.destroy();
  });

  test('switchMode to same mode is no-op', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    await binding.switchMode('source');
    expect(binding.activeMode).toBe('source');

    binding.destroy();
  });

  test('setContent in source mode', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    binding.setContent('<p>hello</p>');
    expect(binding.getContent()).toContain('hello');

    binding.destroy();
  });

  test('unmount clears container', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    expect(container.children.length).toBeGreaterThan(0);
    binding.unmount();
    expect(container.innerHTML).toBe('');

    binding.destroy();
  });

  test('setReadonly applies to both editors', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    expect(() => binding.setReadonly(true)).not.toThrow();
    expect(() => binding.setReadonly(false)).not.toThrow();

    binding.destroy();
  });

  test('mount with collaboration context', async () => {
    const Y = await import('yjs');
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('source');

    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' }, {
      sharedText: ytext,
      awareness: null as any,
      ydoc,
    });

    expect(binding.mounted).toBe(true);

    binding.destroy();
    ydoc.destroy();
  });
});
