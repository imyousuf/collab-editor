import type { EditorMode, IEditorBinding } from './editor-binding.js';
import type { IContentHandler } from './content-handler.js';

/** Constructor function that creates a new IEditorBinding instance */
export type BindingConstructor = () => IEditorBinding;

/**
 * Registry that maps MIME types to their binding constructors and content handlers.
 * The multi-editor uses this to create bindings without knowing specific implementations.
 */
export interface IEditorBindingFactory {
  /**
   * Register a MIME type with its binding constructor and content handler.
   * The binding itself declares which modes it supports via supportedModes.
   */
  register(
    mimeType: string,
    createBinding: BindingConstructor,
    contentHandler: IContentHandler,
  ): void;

  /**
   * Create a binding for the given MIME type.
   * Throws if the MIME type is not registered.
   */
  create(mimeType: string): IEditorBinding;

  /** Get the content handler for a MIME type. */
  getContentHandler(mimeType: string): IContentHandler;

  /** Get the supported modes for a MIME type (from the binding's supportedModes). */
  getSupportedModes(mimeType: string): EditorMode[];

  /** Check if a MIME type + mode combination is supported. */
  supports(mimeType: string, mode: EditorMode): boolean;
}
