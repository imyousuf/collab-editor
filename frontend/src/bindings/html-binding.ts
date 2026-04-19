/**
 * Binding for text/html: supports WYSIWYG + Source modes.
 * Same architecture as MarkdownBinding but uses HtmlContentHandler.
 */
import type {
  IEditorBinding,
  EditorMode,
  MountOptions,
  CollaborationContext,
  ContentChangeCallback,
  RemoteChangeCallback,
} from '../interfaces/editor-binding.js';
import type { IContentHandler } from '../interfaces/content-handler.js';
import { HtmlContentHandler } from '../handlers/html-handler.js';
import { SourceEditorInstance } from './_source-editor.js';
import { WysiwygEditorInstance } from './_wysiwyg-editor.js';

export class HtmlBinding implements IEditorBinding {
  readonly supportedModes: readonly EditorMode[] = ['wysiwyg', 'source'];

  private _activeMode: EditorMode | null = null;
  private _mounted = false;
  private _container: HTMLElement | null = null;
  private _sourceContainer: HTMLElement | null = null;
  private _wysiwygContainer: HTMLElement | null = null;
  private _sourceEditor: SourceEditorInstance | null = null;
  private _wysiwygEditor: WysiwygEditorInstance | null = null;
  private _contentHandler: IContentHandler;
  private _collab: CollaborationContext | null = null;
  private _contentCallbacks = new Set<ContentChangeCallback>();
  private _remoteCallbacks = new Set<RemoteChangeCallback>();
  private _textBindingModule: any = null;

  constructor() {
    this._contentHandler = new HtmlContentHandler();
  }

  get activeMode(): EditorMode | null { return this._activeMode; }
  get mounted(): boolean { return this._mounted; }

  async mount(
    container: HTMLElement,
    mode: EditorMode,
    options: MountOptions,
    collab?: CollaborationContext | null,
  ): Promise<void> {
    if (!this.supportedModes.includes(mode)) {
      throw new Error(`HtmlBinding does not support mode: ${mode}`);
    }

    this._container = container;
    this._collab = collab ?? null;

    this._wysiwygContainer = document.createElement('div');
    this._wysiwygContainer.className = 'binding-wysiwyg';
    this._sourceContainer = document.createElement('div');
    this._sourceContainer.className = 'binding-source';
    container.appendChild(this._wysiwygContainer);
    container.appendChild(this._sourceContainer);

    this._sourceEditor = new SourceEditorInstance(this._sourceContainer, {
      language: 'html',
      readonly: options.readonly,
      theme: options.theme,
    }, this._collab);

    this._sourceEditor.onUpdate((content) => {
      this._contentCallbacks.forEach(cb => cb(content));
    });

    this._wysiwygEditor = new WysiwygEditorInstance(
      this._wysiwygContainer,
      this._contentHandler,
      { readonly: options.readonly, theme: options.theme, placeholder: options.placeholder },
    );
    await this._wysiwygEditor.whenReady();

    if (this._collab) {
      const { TextBinding } = await import('../collab/text-binding.js');
      this._textBindingModule = new TextBinding(
        this._wysiwygEditor.editor,
        this._collab.sharedText,
        this._contentHandler,
      );

      this._collab.sharedText.observe((event) => {
        if (!event.transaction.local) {
          this._remoteCallbacks.forEach(cb => cb({ origin: event.transaction.origin, isRemote: true }));
        }
      });
    }

    this._wysiwygEditor.onUpdate((content) => {
      this._contentCallbacks.forEach(cb => cb(content));
    });

    this._showMode(mode);
    this._mounted = true;
    this._activeMode = mode;
  }

  unmount(): void {
    this._textBindingModule?.destroy();
    this._textBindingModule = null;
    this._sourceEditor?.destroy();
    this._sourceEditor = null;
    this._wysiwygEditor?.destroy();
    this._wysiwygEditor = null;
    if (this._container) this._container.innerHTML = '';
    this._mounted = false;
    this._activeMode = null;
  }

  getContent(): string {
    if (this._activeMode === 'wysiwyg' && this._wysiwygEditor) {
      return this._wysiwygEditor.getContent();
    }
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
    if (this._activeMode === 'wysiwyg') {
      this._wysiwygEditor?.setContent(text);
    } else {
      this._sourceEditor?.setContent(text);
    }
  }

  setReadonly(readonly: boolean): void {
    this._sourceEditor?.setReadonly(readonly);
    this._wysiwygEditor?.setReadonly(readonly);
  }

  async switchMode(mode: EditorMode): Promise<void> {
    if (!this.supportedModes.includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
    if (mode === this._activeMode) return;

    if (!this._collab) {
      if (this._activeMode === 'wysiwyg' && mode === 'source') {
        this._sourceEditor?.setContent(this._wysiwygEditor?.getContent() ?? '');
      } else if (this._activeMode === 'source' && mode === 'wysiwyg') {
        this._wysiwygEditor?.setContent(this._sourceEditor?.getContent() ?? '');
      }
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
    if (this._wysiwygContainer) this._wysiwygContainer.style.display = mode === 'wysiwyg' ? '' : 'none';
    if (this._sourceContainer) this._sourceContainer.style.display = mode === 'source' ? '' : 'none';
  }
}
