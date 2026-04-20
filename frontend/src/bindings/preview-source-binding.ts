/**
 * Base binding for MIME types that support Preview + Source modes.
 * Used by: text/jsx, text/tsx
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
import { setCollabContent, observeRemoteChanges } from './collab-helpers.js';
import type { IBlameCapability } from '../interfaces/blame.js';
import type { BlameSegment } from '../collab/blame-engine.js';

export class PreviewSourceBinding implements IEditorBinding, IBlameCapability {
  readonly supportedModes: readonly EditorMode[] = ['preview', 'source'];

  private _activeMode: EditorMode | null = null;
  private _mounted = false;
  private _container: HTMLElement | null = null;
  private _sourceContainer: HTMLElement | null = null;
  private _previewContainer: HTMLElement | null = null;
  private _sourceEditor: SourceEditorInstance | null = null;
  private _previewRenderer: PreviewRendererInstance | null = null;
  private _collab: CollaborationContext | null = null;
  private _language: string;
  private _contentCallbacks = new Set<ContentChangeCallback>();
  private _remoteCallbacks = new Set<RemoteChangeCallback>();

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
    if (!this.supportedModes.includes(mode)) throw new Error(`Unsupported mode: ${mode}`);

    this._container = container;
    this._collab = collab ?? null;

    this._sourceContainer = document.createElement('div');
    this._sourceContainer.setAttribute('part', 'source-container');
    this._previewContainer = document.createElement('div');
    this._previewContainer.setAttribute('part', 'preview-container');
    container.appendChild(this._sourceContainer);
    container.appendChild(this._previewContainer);

    this._sourceEditor = new SourceEditorInstance(this._sourceContainer, {
      language: this._language,
      readonly: options.readonly,
      theme: options.theme,
    }, this._collab);

    this._sourceEditor.onUpdate((content) => {
      this._contentCallbacks.forEach(cb => cb(content));
      // Re-render preview when source changes (e.g., Y.Text sync after mount)
      if (this._activeMode === 'preview' && this._previewRenderer) {
        this._previewRenderer.render(content);
      }
    });

    if (this._collab) {
      observeRemoteChanges(this._collab, this._remoteCallbacks);
    }

    // Create preview renderer eagerly if mounting in preview mode.
    // Don't render yet — content arrives via Y.Text seed after mount,
    // and the onUpdate callback above will trigger the render.
    if (mode === 'preview' && this._previewContainer) {
      this._previewRenderer = new PreviewRendererInstance(this._previewContainer);
      await this._previewRenderer.whenReady();
    }

    this._showMode(mode);
    this._mounted = true;
    this._activeMode = mode;

    // If mounting in preview mode, render current content.
    // Handles the race where Y.Text was already populated (from stored messages)
    // and yCollab synced it during SourceEditorInstance construction — that
    // onUpdate fires before _activeMode/_previewRenderer are set, so the
    // render guard skips it. This catches up.
    if (mode === 'preview' && this._previewRenderer && this._sourceEditor) {
      const content = this._sourceEditor.getContent();
      if (content) {
        this._previewRenderer.render(content);
      }
    }
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

  getContent(): string { return this._sourceEditor?.getContent() ?? ''; }

  setContent(text: string): void {
    if (this._collab) {
      setCollabContent(this._collab, text);
      return;
    }
    this._sourceEditor?.setContent(text);
  }

  setReadonly(readonly: boolean): void { this._sourceEditor?.setReadonly(readonly); }

  async switchMode(mode: EditorMode): Promise<void> {
    if (!this.supportedModes.includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
    if (mode === this._activeMode) return;

    if (mode === 'preview') {
      if (!this._previewRenderer && this._previewContainer) {
        this._previewRenderer = new PreviewRendererInstance(this._previewContainer);
        await this._previewRenderer.whenReady();
      }
      this._previewRenderer?.render(this._sourceEditor?.getContent() ?? '');
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

  // --- IBlameCapability ---

  enableBlame(segments: BlameSegment[]): void {
    this._sourceEditor?.enableBlame(segments);
  }

  disableBlame(): void {
    this._sourceEditor?.disableBlame();
  }

  updateBlame(segments: BlameSegment[]): void {
    this._sourceEditor?.updateBlame(segments);
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
