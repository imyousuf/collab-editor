import { describe, test, expect, vi } from 'vitest';
import { editorBindingContractTests } from '../interfaces/editor-binding.contract.js';
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
});
