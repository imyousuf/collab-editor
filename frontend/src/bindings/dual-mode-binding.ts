/**
 * Base binding for MIME types that support WYSIWYG + Source modes.
 * Manages two internal editors (Tiptap + CodeMirror) and switches between them.
 * Both bind to the same Y.Text when collaboration is active.
 *
 * Used by: text/markdown, text/html
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
import type {
  IFormattingCapability,
  FormattingCommand,
  FormattingState,
  LinkParams,
} from '../interfaces/formatting.js';
import { ALL_FORMATTING_COMMANDS, emptyFormattingState } from '../interfaces/formatting.js';
import type { IBlameCapability } from '../interfaces/blame.js';
import type { BlameSegment } from '../collab/blame-engine.js';
import type {
  CommentThread,
  ICommentCapability,
  SuggestionOverlayRegion,
} from '../interfaces/comments.js';
import type { PendingSuggestOverlay } from '../interfaces/suggest.js';
import { SourceEditorInstance } from './_source-editor.js';
import { WysiwygEditorInstance } from './_wysiwyg-editor.js';
import { setCollabContent, observeRemoteChanges } from './collab-helpers.js';

export class DualModeBinding
  implements IEditorBinding, IFormattingCapability, IBlameCapability, ICommentCapability
{
  readonly supportedModes: readonly EditorMode[] = ['wysiwyg', 'source'];

  private _activeMode: EditorMode | null = null;
  private _mounted = false;
  private _container: HTMLElement | null = null;
  private _sourceContainer: HTMLElement | null = null;
  private _wysiwygContainer: HTMLElement | null = null;
  private _sourceEditor: SourceEditorInstance | null = null;
  private _wysiwygEditor: WysiwygEditorInstance | null = null;
  private _textBinding: any = null;
  private _collab: CollaborationContext | null = null;
  private _contentHandler: IContentHandler;
  private _language: string;
  private _contentCallbacks = new Set<ContentChangeCallback>();
  private _remoteCallbacks = new Set<RemoteChangeCallback>();
  private _formattingCallbacks = new Set<(state: FormattingState) => void>();

  constructor(contentHandler: IContentHandler, language: string) {
    this._contentHandler = contentHandler;
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
    if (!this.supportedModes.includes(mode)) {
      throw new Error(`DualModeBinding does not support mode: ${mode}`);
    }

    this._container = container;
    this._collab = collab ?? null;

    // Create sub-containers
    this._wysiwygContainer = document.createElement('div');
    this._wysiwygContainer.setAttribute('part', 'wysiwyg-container');
    this._sourceContainer = document.createElement('div');
    this._sourceContainer.setAttribute('part', 'source-container');
    container.appendChild(this._wysiwygContainer);
    container.appendChild(this._sourceContainer);

    // Create source editor with yCollab binding
    this._sourceEditor = new SourceEditorInstance(this._sourceContainer, {
      language: this._language,
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

    // Set up TextBinding for WYSIWYG ↔ Y.Text sync
    if (this._collab) {
      const { TextBinding } = await import('../collab/text-binding.js');
      this._textBinding = new TextBinding(
        this._wysiwygEditor.editor,
        this._collab.sharedText,
        this._contentHandler,
      );
      // If mounting in source mode, pause Tiptap→Y.Text immediately
      if (mode === 'source') {
        this._textBinding.setPaused(true);
      }
      observeRemoteChanges(this._collab, this._remoteCallbacks);
    }

    this._wysiwygEditor.onUpdate((content) => {
      this._contentCallbacks.forEach(cb => cb(content));
    });

    // Wire formatting state emission on selection/transaction changes
    this._wysiwygEditor.editor.on('selectionUpdate', () => this._emitFormattingState());
    this._wysiwygEditor.editor.on('transaction', () => this._emitFormattingState());

    this._showMode(mode);
    this._mounted = true;
    this._activeMode = mode;
  }

  unmount(): void {
    this._textBinding?.destroy();
    this._textBinding = null;
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
    if (this._collab) {
      setCollabContent(this._collab, text);
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

    // In non-collab mode, transfer content between editors
    if (!this._collab) {
      if (this._activeMode === 'wysiwyg' && mode === 'source') {
        this._sourceEditor?.setContent(this._wysiwygEditor?.getContent() ?? '');
      } else if (this._activeMode === 'source' && mode === 'wysiwyg') {
        this._wysiwygEditor?.setContent(this._sourceEditor?.getContent() ?? '');
      }
    }

    // In collab mode, pause/resume TextBinding's Tiptap→Y.Text sync.
    // In source mode, yCollab handles CodeMirror→Y.Text sync, so TextBinding
    // should only sync Y.Text→Tiptap (one-directional). Without pausing,
    // the hidden Tiptap's normalized markdown would corrupt Y.Text.
    if (this._textBinding) {
      this._textBinding.setPaused(mode === 'source');
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

  // --- IFormattingCapability ---

  executeCommand(command: FormattingCommand, params?: LinkParams): void {
    if (this._activeMode !== 'wysiwyg' || !this._wysiwygEditor) return;
    const editor = this._wysiwygEditor.editor;
    const chain = editor.chain().focus();

    switch (command) {
      case 'bold': chain.toggleBold().run(); break;
      case 'italic': chain.toggleItalic().run(); break;
      case 'strike': chain.toggleStrike().run(); break;
      case 'code': chain.toggleCode().run(); break;
      case 'heading1': chain.toggleHeading({ level: 1 }).run(); break;
      case 'heading2': chain.toggleHeading({ level: 2 }).run(); break;
      case 'heading3': chain.toggleHeading({ level: 3 }).run(); break;
      case 'bulletList': chain.toggleBulletList().run(); break;
      case 'orderedList': chain.toggleOrderedList().run(); break;
      case 'codeBlock': chain.toggleCodeBlock().run(); break;
      case 'blockquote': chain.toggleBlockquote().run(); break;
      case 'horizontalRule': chain.setHorizontalRule().run(); break;
      case 'link':
        if (params?.href) {
          chain.setLink({ href: params.href }).run();
        } else {
          chain.unsetLink().run();
        }
        break;
    }
  }

  getAvailableCommands(): FormattingCommand[] {
    if (this._activeMode !== 'wysiwyg') return [];
    return [...ALL_FORMATTING_COMMANDS];
  }

  onFormattingStateChange(callback: (state: FormattingState) => void): () => void {
    this._formattingCallbacks.add(callback);
    return () => this._formattingCallbacks.delete(callback);
  }

  private _emitFormattingState(): void {
    if (!this._wysiwygEditor || this._formattingCallbacks.size === 0) return;
    const editor = this._wysiwygEditor.editor;
    const state: FormattingState = {
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      strike: editor.isActive('strike'),
      code: editor.isActive('code'),
      heading1: editor.isActive('heading', { level: 1 }),
      heading2: editor.isActive('heading', { level: 2 }),
      heading3: editor.isActive('heading', { level: 3 }),
      bulletList: editor.isActive('bulletList'),
      orderedList: editor.isActive('orderedList'),
      codeBlock: editor.isActive('codeBlock'),
      blockquote: editor.isActive('blockquote'),
      horizontalRule: false,
      link: editor.isActive('link'),
    };
    this._formattingCallbacks.forEach(cb => cb(state));
  }

  // --- IBlameCapability ---

  enableBlame(segments: BlameSegment[], ctx?: import('../interfaces/blame.js').BlameContext): void {
    this._sourceEditor?.enableBlame(segments, ctx);
    this._wysiwygEditor?.enableBlame(segments, ctx);
  }

  disableBlame(): void {
    this._sourceEditor?.disableBlame();
    this._wysiwygEditor?.disableBlame();
  }

  updateBlame(segments: BlameSegment[], ctx?: import('../interfaces/blame.js').BlameContext): void {
    this._sourceEditor?.updateBlame(segments, ctx);
    this._wysiwygEditor?.updateBlame(segments, ctx);
  }

  // --- ICommentCapability ---

  enableComments(): void {
    this._sourceEditor?.enableComments();
    this._wysiwygEditor?.enableComments();
  }

  disableComments(): void {
    this._sourceEditor?.disableComments();
    this._wysiwygEditor?.disableComments();
  }

  updateComments(
    threads: CommentThread[],
    overlays: SuggestionOverlayRegion[],
    activeThreadId: string | null,
    pending: PendingSuggestOverlay | null = null,
  ): void {
    this._sourceEditor?.updateComments(threads, overlays, activeThreadId, pending);
    this._wysiwygEditor?.updateComments(threads, overlays, activeThreadId, pending);
  }

  destroy(): void {
    this.unmount();
    this._contentCallbacks.clear();
    this._remoteCallbacks.clear();
    this._formattingCallbacks.clear();
  }

  private _showMode(mode: EditorMode): void {
    if (this._wysiwygContainer) this._wysiwygContainer.style.display = mode === 'wysiwyg' ? '' : 'none';
    if (this._sourceContainer) this._sourceContainer.style.display = mode === 'source' ? '' : 'none';
  }
}
