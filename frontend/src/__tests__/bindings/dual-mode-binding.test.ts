import { describe, test, expect, vi } from 'vitest';
import { editorBindingContractTests } from '../interfaces/editor-binding.contract.js';
import { DualModeBinding } from '../../bindings/dual-mode-binding.js';
import { HtmlContentHandler } from '../../handlers/html-handler.js';
import { MarkdownContentHandler } from '../../handlers/markdown-handler.js';
import { isBlameCapable } from '../../interfaces/blame.js';
import { isFormattingCapable, emptyFormattingState } from '../../interfaces/formatting.js';
import type { FormattingState } from '../../interfaces/formatting.js';

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

  test('rebindSharedText routes writes from CodeMirror to the buffer', async () => {
    const Y = await import('yjs');
    const { Awareness } = await import('y-protocols/awareness.js');
    const baseDoc = new Y.Doc();
    const baseText = baseDoc.getText('source');
    const awareness = new Awareness(baseDoc);
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' }, {
      sharedText: baseText,
      awareness,
      ydoc: baseDoc,
    });

    const bufferDoc = new Y.Doc();
    const bufferText = bufferDoc.getText('source');
    binding.rebindSharedText(bufferText);

    // Drive the source editor directly — dispatch an insert through the
    // underlying CodeMirror view. With the rebind, the insert must land
    // on the buffer, not the base.
    const source = (binding as any)._sourceEditor;
    source.view.dispatch({ changes: { from: 0, insert: 'X' } });

    expect(bufferText.toString()).toBe('X');
    expect(baseText.toString()).toBe('');

    binding.destroy();
    awareness.destroy();
    baseDoc.destroy();
    bufferDoc.destroy();
  });

  test('rebindSharedText retargets TextBinding alongside the source editor', async () => {
    const Y = await import('yjs');
    const { Awareness } = await import('y-protocols/awareness.js');
    const baseDoc = new Y.Doc();
    const baseText = baseDoc.getText('source');
    const awareness = new Awareness(baseDoc);
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'wysiwyg', { readonly: false, theme: 'light' }, {
      sharedText: baseText,
      awareness,
      ydoc: baseDoc,
    });

    const bufferDoc = new Y.Doc();
    const bufferText = bufferDoc.getText('source');
    binding.rebindSharedText(bufferText);

    // TextBinding's exposed ytext getter confirms the swap.
    const tb = (binding as any)._textBinding;
    expect(tb.ytext).toBe(bufferText);

    binding.destroy();
    awareness.destroy();
    baseDoc.destroy();
    bufferDoc.destroy();
  });

  test('rebindSharedText is a no-op without a collab context', async () => {
    const Y = await import('yjs');
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    // Without collab, rebind does nothing — no throw.
    const bufferDoc = new Y.Doc();
    const bufferText = bufferDoc.getText('source');
    binding.rebindSharedText(bufferText);

    binding.destroy();
    bufferDoc.destroy();
  });
});

describe('DualModeBinding IFormattingCapability', () => {
  test('isFormattingCapable returns true', () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    expect(isFormattingCapable(binding)).toBe(true);
    binding.destroy();
  });

  test('getAvailableCommands returns commands in wysiwyg mode', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'wysiwyg', { readonly: false, theme: 'light' });

    const commands = binding.getAvailableCommands();
    expect(commands).toContain('bold');
    expect(commands).toContain('italic');
    expect(commands).toContain('heading1');
    expect(commands).toContain('bulletList');
    expect(commands).toContain('link');
    expect(commands.length).toBeGreaterThan(0);

    binding.destroy();
  });

  test('getAvailableCommands returns empty in source mode', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    expect(binding.getAvailableCommands()).toEqual([]);

    binding.destroy();
  });

  test('executeCommand does nothing in source mode', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    // Should not throw
    expect(() => binding.executeCommand('bold')).not.toThrow();

    binding.destroy();
  });

  test('executeCommand toggleBold in wysiwyg mode', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'wysiwyg', { readonly: false, theme: 'light' });

    // Should not throw — Tiptap processes the command
    expect(() => binding.executeCommand('bold')).not.toThrow();

    binding.destroy();
  });

  test('onFormattingStateChange fires on subscription', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'wysiwyg', { readonly: false, theme: 'light' });

    const states: FormattingState[] = [];
    const unsub = binding.onFormattingStateChange((state) => {
      states.push({ ...state });
    });

    // Trigger a transaction to fire state emission
    binding.executeCommand('bold');

    // Should have received at least one state update
    expect(states.length).toBeGreaterThan(0);
    expect(typeof states[0].bold).toBe('boolean');
    expect(typeof states[0].italic).toBe('boolean');

    unsub();
    binding.destroy();
  });

  test('unsubscribe stops state emission', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'wysiwyg', { readonly: false, theme: 'light' });

    let callCount = 0;
    const unsub = binding.onFormattingStateChange(() => { callCount++; });

    binding.executeCommand('bold');
    const countAfterFirst = callCount;

    unsub();
    binding.executeCommand('italic');
    expect(callCount).toBe(countAfterFirst);

    binding.destroy();
  });

  test('part attributes are set on containers', async () => {
    const binding = new DualModeBinding(htmlHandler, 'html');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    const wysiwyg = container.querySelector('[part="wysiwyg-container"]');
    const source = container.querySelector('[part="source-container"]');
    expect(wysiwyg).not.toBeNull();
    expect(source).not.toBeNull();

    binding.destroy();
  });

  test('implements IBlameCapability', () => {
    const handler = new MarkdownContentHandler();
    const binding = new DualModeBinding(handler, 'markdown');
    expect(isBlameCapable(binding)).toBe(true);
  });

  test('blame enable/disable/update do not throw when mounted', async () => {
    const handler = new MarkdownContentHandler();
    const binding = new DualModeBinding(handler, 'markdown');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    const segments = [{ start: 0, end: 5, userName: 'alice' }];
    expect(() => binding.enableBlame(segments)).not.toThrow();
    expect(() => binding.updateBlame(segments)).not.toThrow();
    expect(() => binding.disableBlame()).not.toThrow();

    binding.destroy();
  });

  test('blame enable/disable do not throw when unmounted', () => {
    const handler = new MarkdownContentHandler();
    const binding = new DualModeBinding(handler, 'markdown');
    expect(() => binding.enableBlame([])).not.toThrow();
    expect(() => binding.disableBlame()).not.toThrow();
  });

  test('blame updateBlame works after switchMode (re-push on mode switch)', async () => {
    const handler = new MarkdownContentHandler();
    const binding = new DualModeBinding(handler, 'markdown');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    const segments = [{ start: 0, end: 5, userName: 'alice' }];
    binding.enableBlame(segments);

    // Switch to WYSIWYG — blame plugin should still be registered
    await binding.switchMode('wysiwyg');
    expect(() => binding.updateBlame(segments)).not.toThrow();

    // Switch back to source — blame should still work
    await binding.switchMode('source');
    expect(() => binding.updateBlame(segments)).not.toThrow();

    binding.destroy();
  });

  test('blame persists through multiple mode switches', async () => {
    const handler = new MarkdownContentHandler();
    const binding = new DualModeBinding(handler, 'markdown');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    const segments = [{ start: 0, end: 3, userName: 'bob' }];
    binding.enableBlame(segments);

    // Multiple round-trips should not corrupt blame state
    await binding.switchMode('wysiwyg');
    await binding.switchMode('source');
    await binding.switchMode('wysiwyg');
    await binding.switchMode('source');

    // updateBlame should still function after multiple switches
    const updated = [{ start: 0, end: 3, userName: 'bob' }, { start: 4, end: 8, userName: 'carol' }];
    expect(() => binding.updateBlame(updated)).not.toThrow();

    // disableBlame should cleanly stop after all the switches
    expect(() => binding.disableBlame()).not.toThrow();

    binding.destroy();
  });
});
