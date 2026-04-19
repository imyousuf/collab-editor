import type { EditorMode, IEditorBinding } from './interfaces/editor-binding.js';
import type { IContentHandler } from './interfaces/content-handler.js';
import type { IEditorBindingFactory, BindingConstructor } from './interfaces/factory.js';

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
