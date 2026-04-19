import type * as Y from 'yjs';

/** Modes an editor can operate in */
export type EditorMode = 'wysiwyg' | 'source' | 'preview';

/** Options passed when mounting an editor binding */
export interface MountOptions {
  readonly: boolean;
  theme: 'light' | 'dark';
  language?: string;
  placeholder?: string;
}

/** Collaboration context provided to bindings that support it */
export interface CollaborationContext {
  readonly sharedText: Y.Text;
  readonly awareness: any;
  readonly ydoc: Y.Doc;
}

/** Callback for content changes */
export type ContentChangeCallback = (content: string) => void;

/** Callback for remote changes received via collaboration */
export type RemoteChangeCallback = (detail: { origin: any; isRemote: boolean }) => void;

/**
 * Core interface that every editor binding must implement.
 * Each MIME type has a concrete class implementing this.
 *
 * The binding itself declares which modes it supports (e.g., ['wysiwyg', 'source']).
 * The binding manages its own mode switching internally.
 *
 * Lifecycle:
 *   new Binding() → mount() → [getContent/setContent/switchMode]* → unmount() → destroy()
 */
export interface IEditorBinding {
  /** Which modes this binding supports */
  readonly supportedModes: readonly EditorMode[];

  /** Currently active mode, or null when not mounted */
  readonly activeMode: EditorMode | null;

  /** Whether this binding is currently mounted to the DOM */
  readonly mounted: boolean;

  /**
   * Mount the editor into the given container element in the specified mode.
   * If a CollaborationContext is provided, the editor binds to Y.Text.
   * Returns a Promise that resolves when the editor is fully interactive.
   */
  mount(
    container: HTMLElement,
    mode: EditorMode,
    options: MountOptions,
    collab?: CollaborationContext | null,
  ): Promise<void>;

  /** Unmount the editor from the DOM. Can be re-mounted after. */
  unmount(): void;

  /** Get the current content as a plain text string. */
  getContent(): string;

  /**
   * Set the content from a plain text string.
   * When collaboration is active and Y.Text already has content,
   * this should NOT overwrite the collaborative state.
   */
  setContent(text: string): void;

  /** Toggle readonly mode */
  setReadonly(readonly: boolean): void;

  /**
   * Switch to a different mode within this binding's supported modes.
   * The binding handles the internal transition (e.g., hiding CodeMirror, showing Tiptap).
   */
  switchMode(mode: EditorMode): Promise<void>;

  /**
   * Register a callback for content changes.
   * Returns an unsubscribe function.
   */
  onContentChange(callback: ContentChangeCallback): () => void;

  /**
   * Register a callback for remote changes received via collaboration.
   * Returns an unsubscribe function.
   */
  onRemoteChange(callback: RemoteChangeCallback): () => void;

  /** Permanently destroy this binding and release all resources. */
  destroy(): void;
}
