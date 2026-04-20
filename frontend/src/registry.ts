import type { EditorMode, IEditorBinding } from './interfaces/editor-binding.js';
import type { IContentHandler } from './interfaces/content-handler.js';
import type { IEditorBindingFactory, BindingConstructor } from './interfaces/factory.js';
import { MarkdownContentHandler, HtmlContentHandler, PlainTextContentHandler } from './handlers/index.js';
import { SourceOnlyBinding, DualModeBinding, PreviewSourceBinding } from './bindings/index.js';

interface Registration {
  createBinding: BindingConstructor;
  contentHandler: IContentHandler;
  /** Cached supported modes from a probe binding */
  supportedModes?: readonly EditorMode[];
}

/**
 * Registry that maps MIME types to their binding constructors and content handlers.
 */
export class EditorBindingFactory implements IEditorBindingFactory {
  private _registry = new Map<string, Registration>();

  register(
    mimeType: string,
    createBinding: BindingConstructor,
    contentHandler: IContentHandler,
  ): void {
    this._registry.set(mimeType, { createBinding, contentHandler });
  }

  create(mimeType: string): IEditorBinding {
    const reg = this._registry.get(mimeType);
    if (!reg) {
      throw new Error(`No binding registered for MIME type: ${mimeType}`);
    }
    return reg.createBinding();
  }

  getContentHandler(mimeType: string): IContentHandler {
    const reg = this._registry.get(mimeType);
    if (!reg) {
      throw new Error(`No content handler registered for MIME type: ${mimeType}`);
    }
    return reg.contentHandler;
  }

  getSupportedModes(mimeType: string): EditorMode[] {
    const reg = this._registry.get(mimeType);
    if (!reg) return ['source'];

    // Cache the supported modes from a probe binding
    if (!reg.supportedModes) {
      const probe = reg.createBinding();
      reg.supportedModes = probe.supportedModes;
      probe.destroy();
    }
    return [...reg.supportedModes];
  }

  supports(mimeType: string, mode: EditorMode): boolean {
    return this.getSupportedModes(mimeType).includes(mode);
  }

  /** Get all registered MIME types */
  getRegisteredMimeTypes(): string[] {
    return Array.from(this._registry.keys());
  }
}

/**
 * Register all default MIME type bindings.
 */
export function registerDefaults(factory: EditorBindingFactory): void {
  const md = new MarkdownContentHandler();
  const htmlHandler = new HtmlContentHandler();
  const plain = new PlainTextContentHandler();

  // WYSIWYG + Source
  factory.register('text/markdown', () => new DualModeBinding(md, 'markdown'), md);
  factory.register('text/html', () => new DualModeBinding(htmlHandler, 'html'), htmlHandler);

  // Preview + Source
  factory.register('text/jsx', () => new PreviewSourceBinding('jsx'), plain);
  factory.register('text/tsx', () => new PreviewSourceBinding('tsx'), plain);

  // Source only — each just varies the CodeMirror language
  factory.register('text/javascript', () => new SourceOnlyBinding('javascript'), plain);
  factory.register('text/typescript', () => new SourceOnlyBinding('typescript'), plain);
  factory.register('text/x-python', () => new SourceOnlyBinding('python'), plain);
  factory.register('text/css', () => new SourceOnlyBinding('html'), plain);
  factory.register('application/json', () => new SourceOnlyBinding('javascript'), plain);
  factory.register('text/yaml', () => new SourceOnlyBinding('markdown'), plain);
  factory.register('text/plain', () => new SourceOnlyBinding('markdown'), plain);
}
