/**
 * Binding for MIME types that only support source mode.
 * Used by: text/javascript, text/typescript, text/x-python, text/css,
 *          application/json, text/yaml, text/plain
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
import { setCollabContent, observeRemoteChanges } from './collab-helpers.js';
import type { IBlameCapability } from '../interfaces/blame.js';
import type { BlameSegment } from '../collab/blame-engine.js';
import type {
  CommentThread,
  ICommentCapability,
  SuggestionOverlayRegion,
} from '../interfaces/comments.js';
import type { PendingSuggestOverlay } from '../interfaces/suggest.js';

export class SourceOnlyBinding
  implements IEditorBinding, IBlameCapability, ICommentCapability
{
  readonly supportedModes: readonly EditorMode[] = ['source'];

  private _activeMode: EditorMode | null = null;
  private _mounted = false;
  private _editor: SourceEditorInstance | null = null;
  private _container: HTMLElement | null = null;
  private _sourceContainer: HTMLElement | null = null;
  private _language: string;
  private _collab: CollaborationContext | null = null;
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
    if (mode !== 'source') throw new Error(`SourceOnlyBinding only supports 'source' mode`);

    this._collab = collab ?? null;
    this._container = container;
    this._sourceContainer = document.createElement('div');
    this._sourceContainer.setAttribute('part', 'source-container');
    container.appendChild(this._sourceContainer);

    this._editor = new SourceEditorInstance(this._sourceContainer, {
      language: this._language,
      readonly: options.readonly,
      theme: options.theme,
    }, this._collab);

    this._editor.onUpdate((content) => {
      this._contentCallbacks.forEach(cb => cb(content));
    });

    if (this._collab) {
      observeRemoteChanges(this._collab, this._remoteCallbacks);
    }

    this._mounted = true;
    this._activeMode = 'source';
  }

  unmount(): void {
    this._editor?.destroy();
    this._editor = null;
    if (this._container) this._container.innerHTML = '';
    this._sourceContainer = null;
    this._mounted = false;
    this._activeMode = null;
  }

  getContent(): string { return this._editor?.getContent() ?? ''; }

  setContent(text: string): void {
    if (this._collab) {
      setCollabContent(this._collab, text);
      return;
    }
    this._editor?.setContent(text);
  }

  setReadonly(readonly: boolean): void { this._editor?.setReadonly(readonly); }

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

  // --- IBlameCapability ---

  enableBlame(segments: BlameSegment[]): void {
    this._editor?.enableBlame(segments);
  }

  disableBlame(): void {
    this._editor?.disableBlame();
  }

  updateBlame(segments: BlameSegment[]): void {
    this._editor?.updateBlame(segments);
  }

  // --- ICommentCapability ---

  enableComments(): void {
    this._editor?.enableComments();
  }

  disableComments(): void {
    this._editor?.disableComments();
  }

  updateComments(
    threads: CommentThread[],
    overlays: SuggestionOverlayRegion[],
    activeThreadId: string | null,
    pending: PendingSuggestOverlay | null = null,
  ): void {
    this._editor?.updateComments(threads, overlays, activeThreadId, pending);
  }

  destroy(): void {
    this.unmount();
    this._contentCallbacks.clear();
    this._remoteCallbacks.clear();
  }
}
