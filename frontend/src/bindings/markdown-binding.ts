/**
 * Binding for text/markdown: supports WYSIWYG + Source modes.
 * Manages two internal editors (Tiptap + CodeMirror) and switches between them.
 * Both bind to the same Y.Text when collaboration is active.
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
import { MarkdownContentHandler } from '../handlers/markdown-handler.js';
import { SourceEditorInstance } from './_source-editor.js';
import { WysiwygEditorInstance } from './_wysiwyg-editor.js';

export class MarkdownBinding implements IEditorBinding {
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
  private _options: MountOptions | null = null;
  private _contentCallbacks = new Set<ContentChangeCallback>();
  private _remoteCallbacks = new Set<RemoteChangeCallback>();
  private _textBindingModule: any = null; // lazy-loaded TextBinding

  constructor() {
    this._contentHandler = new MarkdownContentHandler();
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
      throw new Error(`MarkdownBinding does not support mode: ${mode}`);
    }

    this._container = container;
    this._collab = collab ?? null;
    this._options = options;

    // Create two sub-containers
    this._wysiwygContainer = document.createElement('div');
    this._wysiwygContainer.className = 'binding-wysiwyg';
    this._sourceContainer = document.createElement('div');
    this._sourceContainer.className = 'binding-source';
    container.appendChild(this._wysiwygContainer);
    container.appendChild(this._sourceContainer);

    // Create source editor (always, for collab binding via yCollab)
    this._sourceEditor = new SourceEditorInstance(this._sourceContainer, {
      language: 'markdown',
      readonly: options.readonly,
      theme: options.theme,
    }, this._collab);

    this._sourceEditor.onUpdate((content) => {
      this._contentCallbacks.forEach(cb => cb(content));
    });

    // Create WYSIWYG editor
    this._wysiwygEditor = new WysiwygEditorInstance(
      this._wysiwygContainer,
      this._contentHandler,
      { readonly: options.readonly, theme: options.theme, placeholder: options.placeholder },
    );
    await this._wysiwygEditor.whenReady();

    // Set up TextBinding for WYSIWYG ↔ Y.Text sync (if collaborative)
    if (this._collab) {
      const { TextBinding } = await import('../collab/text-binding.js');
      this._textBindingModule = new TextBinding(
        this._wysiwygEditor.editor,
        this._collab.sharedText,
        this._contentHandler,
      );

      // Listen for remote changes on Y.Text
      this._collab.sharedText.observe((event) => {
        if (!event.transaction.local) {
          this._remoteCallbacks.forEach(cb => cb({ origin: event.transaction.origin, isRemote: true }));
        }
      });
    }

    this._wysiwygEditor.onUpdate((content) => {
      this._contentCallbacks.forEach(cb => cb(content));
    });

    // Show the requested mode
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
    if (this._container) {
      this._container.innerHTML = '';
    }
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
    if (this._collab && this._collab.sharedText.length > 0) {
      // Y.Text already has content — bindings will render it
      return;
    }
    if (this._collab) {
      // Write to Y.Text — both yCollab and TextBinding pick it up
      this._collab.ydoc.transact(() => {
        this._collab!.sharedText.insert(0, text);
      });
      return;
    }
    // Non-collab: set on the active editor
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
    if (!this.supportedModes.includes(mode)) {
      throw new Error(`MarkdownBinding does not support mode: ${mode}`);
    }
    if (mode === this._activeMode) return;

    const previousMode = this._activeMode;

    // In non-collab mode, transfer content between editors
    if (!this._collab) {
      if (previousMode === 'wysiwyg' && mode === 'source') {
        const content = this._wysiwygEditor?.getContent() ?? '';
        this._sourceEditor?.setContent(content);
      } else if (previousMode === 'source' && mode === 'wysiwyg') {
        const content = this._sourceEditor?.getContent() ?? '';
        this._wysiwygEditor?.setContent(content);
      }
    }
    // In collab mode: Y.Text is shared, no transfer needed.
    // TextBinding keeps WYSIWYG in sync with Y.Text.
    // yCollab keeps Source in sync with Y.Text.

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
    if (this._wysiwygContainer) {
      this._wysiwygContainer.style.display = mode === 'wysiwyg' ? '' : 'none';
    }
    if (this._sourceContainer) {
      this._sourceContainer.style.display = mode === 'source' ? '' : 'none';
    }
  }
}
