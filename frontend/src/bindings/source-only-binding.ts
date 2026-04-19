/**
 * Base binding for MIME types that only support source mode.
 * Used by: JavaScript, TypeScript, Python, CSS, JSON, YAML, PlainText.
 */
import type {
  IEditorBinding,
  EditorMode,
  MountOptions,
  CollaborationContext,
  ContentChangeCallback,
  RemoteChangeCallback,
} from '../interfaces/editor-binding.js';
import { SourceEditorInstance } from './_source-editor.js';

export class SourceOnlyBinding implements IEditorBinding {
  readonly supportedModes: readonly EditorMode[] = ['source'];

  private _activeMode: EditorMode | null = null;
  private _mounted = false;
  private _editor: SourceEditorInstance | null = null;
  private _language: string;
  private _collab: CollaborationContext | null = null;
  private _contentCallbacks = new Set<ContentChangeCallback>();
  private _remoteCallbacks = new Set<RemoteChangeCallback>();
  private _unsubUpdate: (() => void) | null = null;

  constructor(language: string) {
    this._language = language;
  }

  get activeMode(): EditorMode | null { return this._activeMode; }
  get mounted(): boolean { return this._mounted; }

  async mount(
    container: HTMLElement,
    mode: EditorMode,
    options: MountOptions,
    collab?: CollaborationContext | null,
  ): Promise<void> {
    if (mode !== 'source') throw new Error(`SourceOnlyBinding only supports 'source' mode, got '${mode}'`);

    this._collab = collab ?? null;
    this._editor = new SourceEditorInstance(container, {
      language: this._language,
      readonly: options.readonly,
      theme: options.theme,
    }, this._collab);

    this._unsubUpdate = this._editor.onUpdate((content) => {
      this._contentCallbacks.forEach(cb => cb(content));
    });

    // Listen for Y.Text remote changes
    if (this._collab) {
      this._collab.sharedText.observe((event) => {
        if (!event.transaction.local) {
          this._remoteCallbacks.forEach(cb => cb({ origin: event.transaction.origin, isRemote: true }));
        }
      });
    }

    this._mounted = true;
    this._activeMode = 'source';
  }

  unmount(): void {
    this._unsubUpdate?.();
    this._unsubUpdate = null;
    this._editor?.destroy();
    this._editor = null;
    this._mounted = false;
    this._activeMode = null;
  }

  getContent(): string {
    return this._editor?.getContent() ?? '';
  }

  setContent(text: string): void {
    if (this._collab && this._collab.sharedText.length > 0) {
      // Y.Text already has content — yCollab will render it
      return;
    }
    if (this._collab) {
      // Write to Y.Text — yCollab picks it up
      this._collab.ydoc.transact(() => {
        this._collab!.sharedText.insert(0, text);
      });
      return;
    }
    this._editor?.setContent(text);
  }

  setReadonly(readonly: boolean): void {
    this._editor?.setReadonly(readonly);
  }

  async switchMode(mode: EditorMode): Promise<void> {
    if (mode !== 'source') throw new Error(`SourceOnlyBinding only supports 'source' mode`);
  }

  onContentChange(callback: ContentChangeCallback): () => void {
    this._contentCallbacks.add(callback);
    return () => this._contentCallbacks.delete(callback);
  }

  onRemoteChange(callback: RemoteChangeCallback): () => void {
    this._remoteCallbacks.add(callback);
    return () => this._remoteCallbacks.delete(callback);
  }

  destroy(): void {
    this.unmount();
    this._contentCallbacks.clear();
    this._remoteCallbacks.clear();
  }
}
