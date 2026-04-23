import { describe, test, expect } from 'vitest';
import { EditorBindingFactory, registerDefaults } from '../registry.js';
import { MarkdownContentHandler } from '../handlers/markdown-handler.js';
import { PlainTextContentHandler } from '../handlers/plaintext-handler.js';
import type { IEditorBinding, EditorMode, MountOptions, CollaborationContext, ContentChangeCallback, RemoteChangeCallback } from '../interfaces/editor-binding.js';

/** Minimal mock binding for testing the factory */
class MockBinding implements IEditorBinding {
  readonly supportedModes: readonly EditorMode[];
  activeMode: EditorMode | null = null;
  mounted = false;

  constructor(modes: EditorMode[]) {
    this.supportedModes = modes;
  }

  async mount(container: HTMLElement, mode: EditorMode, options: MountOptions): Promise<void> {
    this.mounted = true;
    this.activeMode = mode;
  }
  unmount(): void { this.mounted = false; this.activeMode = null; }
  getContent(): string { return ''; }
  setContent(text: string): void {}
  setReadonly(readonly: boolean): void {}
  async switchMode(mode: EditorMode): Promise<void> {
    if (!this.supportedModes.includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
    this.activeMode = mode;
  }
  onContentChange(callback: ContentChangeCallback): () => void { return () => {}; }
  onRemoteChange(callback: RemoteChangeCallback): () => void { return () => {}; }
  rebindSharedText(_yText: any): void {}
  getCurrentSerialized(): string { return ''; }
  destroy(): void { this.unmount(); }
}

describe('EditorBindingFactory', () => {
  test('register and create returns a binding', () => {
    const factory = new EditorBindingFactory();
    factory.register('text/markdown', () => new MockBinding(['wysiwyg', 'source']), new MarkdownContentHandler());
    const binding = factory.create('text/markdown');
    expect(binding).toBeDefined();
    expect(binding.supportedModes).toEqual(['wysiwyg', 'source']);
    binding.destroy();
  });

  test('create throws for unregistered MIME type', () => {
    const factory = new EditorBindingFactory();
    expect(() => factory.create('text/unknown')).toThrow('No binding registered');
  });

  test('getContentHandler returns the registered handler', () => {
    const factory = new EditorBindingFactory();
    const handler = new MarkdownContentHandler();
    factory.register('text/markdown', () => new MockBinding(['source']), handler);
    expect(factory.getContentHandler('text/markdown')).toBe(handler);
  });

  test('getContentHandler throws for unregistered MIME type', () => {
    const factory = new EditorBindingFactory();
    expect(() => factory.getContentHandler('text/unknown')).toThrow('No content handler');
  });

  test('getSupportedModes returns modes from the binding', () => {
    const factory = new EditorBindingFactory();
    factory.register('text/markdown', () => new MockBinding(['wysiwyg', 'source']), new MarkdownContentHandler());
    expect(factory.getSupportedModes('text/markdown')).toEqual(['wysiwyg', 'source']);
  });

  test('getSupportedModes returns [source] for unknown MIME type', () => {
    const factory = new EditorBindingFactory();
    expect(factory.getSupportedModes('text/unknown')).toEqual(['source']);
  });

  test('supports returns true for registered mode', () => {
    const factory = new EditorBindingFactory();
    factory.register('text/markdown', () => new MockBinding(['wysiwyg', 'source']), new MarkdownContentHandler());
    expect(factory.supports('text/markdown', 'wysiwyg')).toBe(true);
    expect(factory.supports('text/markdown', 'source')).toBe(true);
  });

  test('supports returns false for unsupported mode', () => {
    const factory = new EditorBindingFactory();
    factory.register('text/markdown', () => new MockBinding(['wysiwyg', 'source']), new MarkdownContentHandler());
    expect(factory.supports('text/markdown', 'preview')).toBe(false);
  });

  test('supports returns false for unregistered MIME type', () => {
    const factory = new EditorBindingFactory();
    expect(factory.supports('text/unknown', 'source')).toBe(true); // fallback
    expect(factory.supports('text/unknown', 'wysiwyg')).toBe(false);
  });

  test('getRegisteredMimeTypes returns all registered types', () => {
    const factory = new EditorBindingFactory();
    factory.register('text/markdown', () => new MockBinding(['source']), new MarkdownContentHandler());
    factory.register('text/plain', () => new MockBinding(['source']), new PlainTextContentHandler());
    expect(factory.getRegisteredMimeTypes().sort()).toEqual(['text/markdown', 'text/plain']);
  });

  test('registerDefaults populates all 11 MIME types', () => {
    const factory = new EditorBindingFactory();
    registerDefaults(factory);
    const mimes = factory.getRegisteredMimeTypes().sort();
    expect(mimes).toEqual([
      'application/json',
      'text/css',
      'text/html',
      'text/javascript',
      'text/jsx',
      'text/markdown',
      'text/plain',
      'text/tsx',
      'text/typescript',
      'text/x-python',
      'text/yaml',
    ]);
  });

  test('registerDefaults: markdown supports wysiwyg+source', () => {
    const factory = new EditorBindingFactory();
    registerDefaults(factory);
    expect(factory.supports('text/markdown', 'wysiwyg')).toBe(true);
    expect(factory.supports('text/markdown', 'source')).toBe(true);
    expect(factory.supports('text/markdown', 'preview')).toBe(false);
  });

  test('registerDefaults: jsx supports preview+source', () => {
    const factory = new EditorBindingFactory();
    registerDefaults(factory);
    expect(factory.supports('text/jsx', 'preview')).toBe(true);
    expect(factory.supports('text/jsx', 'source')).toBe(true);
    expect(factory.supports('text/jsx', 'wysiwyg')).toBe(false);
  });

  test('registerDefaults: python supports source only', () => {
    const factory = new EditorBindingFactory();
    registerDefaults(factory);
    expect(factory.supports('text/x-python', 'source')).toBe(true);
    expect(factory.supports('text/x-python', 'wysiwyg')).toBe(false);
    expect(factory.supports('text/x-python', 'preview')).toBe(false);
  });

  test('multiple registrations for different MIME types', () => {
    const factory = new EditorBindingFactory();
    factory.register('text/markdown', () => new MockBinding(['wysiwyg', 'source']), new MarkdownContentHandler());
    factory.register('text/plain', () => new MockBinding(['source']), new PlainTextContentHandler());

    expect(factory.supports('text/markdown', 'wysiwyg')).toBe(true);
    expect(factory.supports('text/plain', 'wysiwyg')).toBe(false);
    expect(factory.supports('text/plain', 'source')).toBe(true);
  });
});
