/**
 * Binding for text/jsx: supports Preview + Source modes.
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
import { PreviewRendererInstance } from './_preview-renderer.js';

export class JsxBinding implements IEditorBinding {
  readonly supportedModes: readonly EditorMode[] = ['preview', 'source'];

  private _activeMode: EditorMode | null = null;
  private _mounted = false;
  private _container: HTMLElement | null = null;
  private _sourceContainer: HTMLElement | null = null;
  private _previewContainer: HTMLElement | null = null;
  private _sourceEditor: SourceEditorInstance | null = null;
  private _previewRenderer: PreviewRendererInstance | null = null;
  private _collab: CollaborationContext | null = null;
  private _contentCallbacks = new Set<ContentChangeCallback>();
  private _remoteCallbacks = new Set<RemoteChangeCallback>();

  get activeMode(): EditorMode | null { return this._activeMode; }
  get mounted(): boolean { return this._mounted; }

  async mount(
    container: HTMLElement,
    mode: EditorMode,
    options: MountOptions,
    collab?: CollaborationContext | null,
  ): Promise<void> {
    if (!this.supportedModes.includes(mode)) throw new Error(`JsxBinding does not support mode: ${mode}`);

    this._container = container;
    this._collab = collab ?? null;

    this._sourceContainer = document.createElement('div');
    this._sourceContainer.className = 'binding-source';
    this._previewContainer = document.createElement('div');
    this._previewContainer.className = 'binding-preview';
    container.appendChild(this._sourceContainer);
    container.appendChild(this._previewContainer);

    this._sourceEditor = new SourceEditorInstance(this._sourceContainer, {
      language: 'jsx',
      readonly: options.readonly,
      theme: options.theme,
    }, this._collab);

    this._sourceEditor.onUpdate((content) => {
      this._contentCallbacks.forEach(cb => cb(content));
    });

    if (this._collab) {
      this._collab.sharedText.observe((event) => {
        if (!event.transaction.local) {
          this._remoteCallbacks.forEach(cb => cb({ origin: event.transaction.origin, isRemote: true }));
        }
      });
    }

    this._showMode(mode);
    this._mounted = true;
    this._activeMode = mode;
  }

  unmount(): void {
    this._sourceEditor?.destroy();
    this._sourceEditor = null;
    this._previewRenderer?.destroy();
    this._previewRenderer = null;
    if (this._container) this._container.innerHTML = '';
    this._mounted = false;
    this._activeMode = null;
  }

  getContent(): string {
    return this._sourceEditor?.getContent() ?? '';
  }

  setContent(text: string): void {
    if (this._collab && this._collab.sharedText.length > 0) return;
    if (this._collab) {
      this._collab.ydoc.transact(() => {
        if (this._collab!.sharedText.length > 0) { this._collab!.sharedText.delete(0, this._collab!.sharedText.length); }
        this._collab!.sharedText.insert(0, text);
      });
      return;
    }
    this._sourceEditor?.setContent(text);
  }

  setReadonly(readonly: boolean): void {
    this._sourceEditor?.setReadonly(readonly);
  }

  async switchMode(mode: EditorMode): Promise<void> {
    if (!this.supportedModes.includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
    if (mode === this._activeMode) return;

    if (mode === 'preview') {
      // Lazy-create preview renderer
      if (!this._previewRenderer && this._previewContainer) {
        this._previewRenderer = new PreviewRendererInstance(this._previewContainer);
        await this._previewRenderer.whenReady();
      }
      // Render current source code
      const code = this._sourceEditor?.getContent() ?? '';
      this._previewRenderer?.render(code);
    }

    this._showMode(mode);
    this._activeMode = mode;
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

  private _showMode(mode: EditorMode): void {
    if (this._sourceContainer) this._sourceContainer.style.display = mode === 'source' ? '' : 'none';
    if (this._previewContainer) this._previewContainer.style.display = mode === 'preview' ? '' : 'none';
  }
}
