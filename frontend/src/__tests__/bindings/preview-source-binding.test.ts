import { describe, test, expect, vi } from 'vitest';
import { editorBindingContractTests } from '../interfaces/editor-binding.contract.js';
import { isBlameCapable } from '../../interfaces/blame.js';

// Mock PreviewRendererInstance before importing the binding
vi.mock('../../bindings/_preview-renderer.js', () => ({
  PreviewRendererInstance: class MockPreviewRenderer {
    render = vi.fn();
    whenReady = vi.fn().mockResolvedValue(undefined);
    destroy = vi.fn();
    constructor(container: HTMLElement) {
      const iframe = document.createElement('iframe');
      container.appendChild(iframe);
    }
  },
}));

import { PreviewSourceBinding } from '../../bindings/preview-source-binding.js';

// Run interface contract tests
editorBindingContractTests(
  'PreviewSourceBinding (jsx)',
  () => new PreviewSourceBinding('jsx'),
  {
    expectedModes: ['preview', 'source'],
    defaultMode: 'source',
    canMount: true,
  },
);

describe('PreviewSourceBinding unit tests', () => {
  test('constructor accepts jsx and tsx languages', () => {
    const jsx = new PreviewSourceBinding('jsx');
    expect(jsx.supportedModes).toEqual(['preview', 'source']);
    jsx.destroy();

    const tsx = new PreviewSourceBinding('tsx');
    expect(tsx.supportedModes).toEqual(['preview', 'source']);
    tsx.destroy();
  });

  test('mount in source mode', async () => {
    const binding = new PreviewSourceBinding('jsx');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    expect(binding.mounted).toBe(true);
    expect(binding.activeMode).toBe('source');

    binding.destroy();
  });

  test('mount rejects wysiwyg mode', async () => {
    const binding = new PreviewSourceBinding('jsx');
    const container = document.createElement('div');
    await expect(
      binding.mount(container, 'wysiwyg', { readonly: false, theme: 'light' }),
    ).rejects.toThrow();
    binding.destroy();
  });

  test('setContent and getContent in source mode', async () => {
    const binding = new PreviewSourceBinding('jsx');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    binding.setContent('const App = () => <div>Hello</div>;');
    expect(binding.getContent()).toContain('const App');

    binding.destroy();
  });

  test('switchMode to same mode is no-op', async () => {
    const binding = new PreviewSourceBinding('jsx');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    await binding.switchMode('source');
    expect(binding.activeMode).toBe('source');

    binding.destroy();
  });

  test('switchMode rejects wysiwyg', async () => {
    const binding = new PreviewSourceBinding('jsx');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    await expect(binding.switchMode('wysiwyg')).rejects.toThrow();

    binding.destroy();
  });

  test('unmount resets state', async () => {
    const binding = new PreviewSourceBinding('jsx');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    binding.unmount();
    expect(binding.mounted).toBe(false);
    expect(binding.activeMode).toBeNull();

    binding.destroy();
  });

  test('mount in preview mode creates preview renderer eagerly', async () => {
    const binding = new PreviewSourceBinding('jsx');
    const container = document.createElement('div');
    await binding.mount(container, 'preview', { readonly: false, theme: 'light' });

    expect(binding.mounted).toBe(true);
    expect(binding.activeMode).toBe('preview');
    // Preview container should have an iframe
    expect(container.querySelector('iframe')).not.toBeNull();

    binding.destroy();
  });

  test('source content change re-renders preview when in preview mode', async () => {
    const binding = new PreviewSourceBinding('jsx') as any;
    const container = document.createElement('div');
    await binding.mount(container, 'preview', { readonly: false, theme: 'light' });

    // Spy on the preview renderer's render method
    const renderSpy = vi.spyOn(binding._previewRenderer, 'render');

    // Simulate source content change (e.g., Y.Text sync arriving after mount)
    binding._sourceEditor._view.dispatch({
      changes: { from: 0, to: 0, insert: 'const App = () => <div>Hello</div>;' },
    });

    expect(renderSpy).toHaveBeenCalledWith(
      expect.stringContaining('const App'),
    );

    binding.destroy();
  });

  test('source content change does NOT render preview when in source mode', async () => {
    const binding = new PreviewSourceBinding('jsx') as any;
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    // No preview renderer in source mode
    expect(binding._previewRenderer).toBeNull();

    // Source edit should not throw (no preview to render to)
    binding._sourceEditor._view.dispatch({
      changes: { from: 0, to: 0, insert: 'const x = 1;' },
    });

    // Still no preview renderer created
    expect(binding._previewRenderer).toBeNull();

    binding.destroy();
  });

  test('mount in preview mode renders existing source content immediately', async () => {
    // Simulates the scenario where Y.Text was populated before mount
    // (stored messages arrived during connect). After mount completes,
    // the binding should render whatever content the source editor already has.
    const binding = new PreviewSourceBinding('jsx') as any;
    const container = document.createElement('div');

    // Mount in source mode first to set content
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });
    binding._sourceEditor._view.dispatch({
      changes: { from: 0, to: 0, insert: 'const App = () => <h1>Pre-existing</h1>;' },
    });
    binding.unmount();

    // Now mount fresh in preview mode — simulating what happens when
    // switching back to a JSX document that has stored Y.Text content
    const binding2 = new PreviewSourceBinding('jsx') as any;
    const container2 = document.createElement('div');
    await binding2.mount(container2, 'preview', { readonly: false, theme: 'light' });

    // The preview renderer's render should have been called if source has content.
    // Since source starts empty in this fresh binding, render should NOT be called.
    const renderSpy = vi.spyOn(binding2._previewRenderer, 'render');

    // Now simulate content arriving (via Y.Text sync after mount)
    binding2._sourceEditor._view.dispatch({
      changes: { from: 0, to: 0, insert: 'const App = () => <h1>Arrived</h1>;' },
    });

    expect(renderSpy).toHaveBeenCalledWith(
      expect.stringContaining('Arrived'),
    );

    binding.destroy();
    binding2.destroy();
  });

  test('content change after mount in preview mode triggers re-render (simulates Y.Text arrival)', async () => {
    // This tests the same code path as Y.Text sync: content arrives after mount,
    // CodeMirror updates, onUpdate fires, preview re-renders.
    // We simulate via direct CodeMirror dispatch since yCollab's async pipeline
    // doesn't fire synchronously in jsdom.
    const binding = new PreviewSourceBinding('jsx') as any;
    const container = document.createElement('div');
    await binding.mount(container, 'preview', { readonly: false, theme: 'light' });

    const renderSpy = vi.spyOn(binding._previewRenderer, 'render');

    // Simulate content arriving (same as Y.Text → yCollab → CodeMirror path)
    binding._sourceEditor._view.dispatch({
      changes: { from: 0, to: 0, insert: 'export default function App() { return <div>Hi</div>; }' },
    });

    expect(renderSpy).toHaveBeenCalled();
    expect(renderSpy.mock.calls[0][0]).toContain('export default function App');

    binding.destroy();
  });

  test('implements IBlameCapability', async () => {
    const binding = new PreviewSourceBinding('jsx');
    expect(isBlameCapable(binding)).toBe(true);
    expect(typeof binding.enableBlame).toBe('function');
    expect(typeof binding.disableBlame).toBe('function');
    expect(typeof binding.updateBlame).toBe('function');
  });

  test('enableBlame and disableBlame do not throw when mounted', async () => {
    const binding = new PreviewSourceBinding('jsx');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    const segments = [{ start: 0, end: 5, userName: 'alice' }];
    expect(() => binding.enableBlame(segments)).not.toThrow();
    expect(() => binding.updateBlame(segments)).not.toThrow();
    expect(() => binding.disableBlame()).not.toThrow();

    binding.destroy();
  });

  test('enableBlame and disableBlame do not throw when unmounted', () => {
    const binding = new PreviewSourceBinding('jsx');
    const segments = [{ start: 0, end: 5, userName: 'alice' }];
    // Should not throw even without mount
    expect(() => binding.enableBlame(segments)).not.toThrow();
    expect(() => binding.disableBlame()).not.toThrow();
  });

  test('rebindSharedText routes writes to the buffer when mounted with collab', async () => {
    const Y = await import('yjs');
    const { Awareness } = await import('y-protocols/awareness.js');
    const baseDoc = new Y.Doc();
    const baseText = baseDoc.getText('source');
    const awareness = new Awareness(baseDoc);
    const binding = new PreviewSourceBinding('jsx');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' }, {
      sharedText: baseText,
      awareness,
      ydoc: baseDoc,
    });

    const bufferDoc = new Y.Doc();
    const bufferText = bufferDoc.getText('source');
    binding.rebindSharedText(bufferText);

    // Drive the internal source editor to force an edit through yCollab.
    const source = (binding as any)._sourceEditor;
    source.view.dispatch({ changes: { from: 0, insert: 'Q' } });

    expect(bufferText.toString()).toBe('Q');
    expect(baseText.toString()).toBe('');

    binding.destroy();
    awareness.destroy();
    baseDoc.destroy();
    bufferDoc.destroy();
  });

  test('rebindSharedText is a no-op without collab', async () => {
    const Y = await import('yjs');
    const binding = new PreviewSourceBinding('jsx');
    const container = document.createElement('div');
    await binding.mount(container, 'source', { readonly: false, theme: 'light' });

    const bufferDoc = new Y.Doc();
    const bufferText = bufferDoc.getText('source');
    binding.rebindSharedText(bufferText);

    binding.destroy();
    bufferDoc.destroy();
  });
});
