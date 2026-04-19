import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { WysiwygEditor, createWysiwygEditor } from './editors/wysiwyg-editor.js';
import type { WysiwygEditorOptions } from './editors/wysiwyg-editor.js';
import { SourceEditor } from './editors/source-editor.js';
import { CollabProvider } from './collab/yjs-provider.js';
import { EditorChangeEvent, ModeChangeEvent, EditorSaveEvent, CollabStatusEvent } from './events.js';
import { supportsWysiwyg, supportsPreview, getAlternateCapability, getLanguageForMime, getFormatForMime } from './types.js';
import type { EditorMode, EditorFormat, EditorTheme, AlternateCapability, CollaborationConfig } from './types.js';
import { JsxPreview } from './preview/jsx-preview.js';

@customElement('multi-editor')
export class MultiEditor extends LitElement {
  @property({ type: String, reflect: true }) mode: EditorMode = 'wysiwyg';
  @property({ type: String }) format: EditorFormat = 'markdown';
  @property({ type: String }) language: string = 'markdown';
  @property({ type: String }) mimeType: string = 'text/markdown';
  @property({ type: String }) placeholder: string = 'Start writing...';
  @property({ type: String, reflect: true }) theme: EditorTheme = 'light';
  @property({ type: Boolean }) readonly: boolean = false;
  @property({ type: Boolean, reflect: true }) wysiwygDisabled: boolean = false;
  @property({ type: String, reflect: true }) alternateCapability: AlternateCapability = 'wysiwyg';

  @property({ attribute: false }) collaboration: CollaborationConfig | null = null;

  @state() private _collabStatus: 'connecting' | 'connected' | 'disconnected' = 'disconnected';

  private _collabProvider: CollabProvider | null = null;
  private _wysiwygEditor: WysiwygEditor | null = null;
  private _sourceEditor: SourceEditor | null = null;
  private _jsxPreview: JsxPreview | null = null;
  private _changeDebounce: ReturnType<typeof setTimeout> | null = null;
  private _initialized = false;
  private _lastCollabConfig: CollaborationConfig | null = null;
  private _pendingContent: { content: string; mimeType: string } | null = null;

  static styles = css`
    :host {
      display: block;
      position: relative;
    }
    .editor-container {
      width: 100%;
      min-height: 200px;
    }
    .editor-container.hidden {
      display: none;
    }
    .ProseMirror {
      outline: none;
      padding: 12px;
      min-height: 200px;
    }
    .ProseMirror p.is-editor-empty:first-child::before {
      content: attr(data-placeholder);
      float: left;
      color: #adb5bd;
      pointer-events: none;
      height: 0;
    }
    .ProseMirror pre {
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
    }
    .ProseMirror code {
      background: #f0f0f0;
      padding: 2px 4px;
      border-radius: 2px;
      font-size: 0.9em;
    }
    .ProseMirror pre code {
      background: none;
      padding: 0;
    }
    .cm-editor {
      min-height: 200px;
    }
    .collaboration-cursor__caret {
      position: relative;
      margin-left: -1px;
      margin-right: -1px;
      border-left: 1px solid;
      border-right: 1px solid;
      word-break: normal;
      pointer-events: none;
    }
    .collaboration-cursor__label {
      position: absolute;
      top: -1.4em;
      left: -1px;
      font-size: 12px;
      font-style: normal;
      font-weight: 600;
      line-height: normal;
      user-select: none;
      color: #fff;
      padding: 0.1rem 0.3rem;
      border-radius: 3px 3px 3px 0;
      white-space: nowrap;
    }
  `;

  render() {
    return html`
      <div id="wysiwyg-container" class="editor-container ${this.mode !== 'wysiwyg' ? 'hidden' : ''}"></div>
      <div id="source-container" class="editor-container ${this.mode !== 'source' ? 'hidden' : ''}"></div>
      <div id="preview-container" class="editor-container ${this.mode !== 'preview' ? 'hidden' : ''}"></div>
    `;
  }

  firstUpdated() {
    this._setupKeyboardShortcuts();
    this._createSourceEditor();
    this._initialized = true;
    this._lastCollabConfig = this.collaboration;

    // If collaboration is already set (unlikely but possible), create WYSIWYG now
    if (this.collaboration?.enabled) {
      this._setupCollaboration();
      this._createWysiwygEditor();
    }
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('collaboration') && this._initialized && this.collaboration !== this._lastCollabConfig) {
      this._lastCollabConfig = this.collaboration;
      this._setupCollaboration();
      // Recreate BOTH editors with the collaboration provider
      this._recreateSourceEditor();
      this._createWysiwygEditor();
    }
    if (changed.has('mimeType') && this._initialized) {
      this.alternateCapability = getAlternateCapability(this.mimeType);
      this.wysiwygDisabled = this.alternateCapability !== 'wysiwyg';
      this.format = getFormatForMime(this.mimeType);
      this.language = getLanguageForMime(this.mimeType);
      this._sourceEditor?.setLanguage(this.language);

      // If current mode isn't supported, switch to source
      if (this.mode === 'wysiwyg' && this.alternateCapability !== 'wysiwyg') {
        this.switchMode('source');
      } else if (this.mode === 'preview' && this.alternateCapability !== 'preview') {
        this.switchMode('source');
      }
    }
    if (changed.has('readonly')) {
      this._wysiwygEditor?.setReadonly(this.readonly);
      this._sourceEditor?.setReadonly(this.readonly);
    }
    if (changed.has('language') && !changed.has('mimeType')) {
      this._sourceEditor?.setLanguage(this.language);
    }
  }

  private _setupCollaboration() {
    if (this._collabProvider) {
      this._collabProvider.destroy();
      this._collabProvider = null;
    }

    if (!this.collaboration?.enabled) {
      return;
    }

    this._collabProvider = new CollabProvider();
    this._collabProvider.connect(this.collaboration);

    const provider = this._collabProvider.provider;
    if (provider) {
      provider.on('status', (event: { status: string }) => {
        const status = event.status as 'connecting' | 'connected' | 'disconnected';
        this._collabStatus = status;
        this.dispatchEvent(new CollabStatusEvent({ status }));
      });

      this._collabProvider.meta.observe((event) => {
        if (event.keysChanged.has('activeView')) {
          const newMode = this._collabProvider!.meta.get('activeView') as EditorMode;
          if (newMode && newMode !== this.mode) {
            this.switchMode(newMode);
          }
        }
      });
    }
  }

  private _createSourceEditor() {
    const sourceContainer = this.renderRoot.querySelector('#source-container') as HTMLElement;
    if (!sourceContainer) return;
    try {
      this._sourceEditor = new SourceEditor(
        sourceContainer,
        this._collabProvider,
        { language: this.language, readonly: this.readonly, theme: this.theme },
      );
    } catch (e) {
      console.error('Failed to create Source editor:', e);
    }
  }

  private _recreateSourceEditor() {
    if (this._sourceEditor) {
      this._sourceEditor.destroy();
      this._sourceEditor = null;
    }
    const sourceContainer = this.renderRoot.querySelector('#source-container') as HTMLElement;
    if (sourceContainer) sourceContainer.innerHTML = '';
    this._createSourceEditor();
  }

  private _createWysiwygEditor() {
    // Destroy existing WYSIWYG editor if any
    if (this._wysiwygEditor) {
      this._wysiwygEditor.destroy();
      this._wysiwygEditor = null;
    }
    const wysiwygContainer = this.renderRoot.querySelector('#wysiwyg-container') as HTMLElement;
    if (!wysiwygContainer) return;
    wysiwygContainer.innerHTML = '';

    try {
      this._wysiwygEditor = createWysiwygEditor(
        wysiwygContainer,
        { placeholder: this.placeholder, readonly: this.readonly, theme: this.theme },
        this._collabProvider,
        this.mimeType,
      );
      this._wysiwygEditor.editor.on('update', () => this._emitChange());

      // Apply any content that was set before the editor was created
      if (this._pendingContent) {
        const { content, mimeType } = this._pendingContent;
        this._pendingContent = null;
        this._wysiwygEditor.setContent(content, mimeType);
      }

    } catch (e) {
      console.error('Failed to create WYSIWYG editor:', e);
    }
  }

  private _setupKeyboardShortcuts() {
    this.addEventListener('keydown', (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        const value = this.getContent();
        this.dispatchEvent(new EditorSaveEvent({ value, format: this.format }));
      }
    });
  }

  private _emitChange() {
    if (this._changeDebounce) clearTimeout(this._changeDebounce);
    this._changeDebounce = setTimeout(() => {
      const value = this.getContent();
      this.dispatchEvent(new EditorChangeEvent({ value, format: this.format, mode: this.mode }));
    }, 300);
  }

  async switchMode(newMode: EditorMode): Promise<void> {
    if (newMode === this.mode) return;
    if (newMode === 'wysiwyg' && this.alternateCapability !== 'wysiwyg') return;
    if (newMode === 'preview' && this.alternateCapability !== 'preview') return;

    const cancelEvent = new CustomEvent('before-mode-change', {
      detail: { mode: newMode, previousMode: this.mode },
      cancelable: true,
      bubbles: true,
      composed: true,
    });
    if (!this.dispatchEvent(cancelEvent)) return;

    const previousMode = this.mode;

    // Both editors share the same Y.Text via the collaboration layer.
    // No content transfer needed on mode switch — Y.Text is the source of truth.
    // For non-collaborative mode, transfer content directly.
    if (!this._collabProvider) {
      if (previousMode === 'wysiwyg' && newMode === 'source') {
        if (this._wysiwygEditor && this._sourceEditor) {
          this._sourceEditor.setContent(this._wysiwygEditor.getContent(this.format));
        }
      } else if (previousMode === 'source' && newMode === 'wysiwyg') {
        if (this._sourceEditor && this._wysiwygEditor) {
          this._wysiwygEditor.setContent(this._sourceEditor.getContent(), this.mimeType, true);
        }
      }
    }

    if (previousMode === 'source' && newMode === 'preview') {
      // Compile and render the source code in the preview iframe
      this._ensurePreview();
      if (this._sourceEditor && this._jsxPreview) {
        this._jsxPreview.render(this._sourceEditor.getContent());
      }
    } else if (previousMode === 'preview' && newMode === 'source') {
      // Just switch view — source content is unchanged
    }

    this.mode = newMode;
    this.dispatchEvent(new ModeChangeEvent({ mode: newMode, previousMode }));
  }

  private _ensurePreview(): void {
    if (this._jsxPreview) return;
    const container = this.renderRoot.querySelector('#preview-container') as HTMLElement;
    if (container) {
      this._jsxPreview = new JsxPreview(container);
    }
  }

  getContent(format?: EditorFormat): string {
    const fmt = format ?? this.format;
    if (this.mode === 'wysiwyg') {
      return this._wysiwygEditor?.getContent(fmt) ?? '';
    }
    return this._sourceEditor?.getContent() ?? '';
  }

  setContent(content: string, mimeType?: string): void {
    const mime = mimeType ?? this.mimeType;
    const wysiwygSupported = supportsWysiwyg(mime);

    if (wysiwygSupported && this.mode === 'wysiwyg') {
      if (this._wysiwygEditor) {
        this._wysiwygEditor.setContent(content, mime);
      } else {
        // WYSIWYG editor is still being created async — queue the content
        this._pendingContent = { content, mimeType: mime };
      }
    } else if (this._sourceEditor) {
      this._sourceEditor.setContent(content);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._changeDebounce) clearTimeout(this._changeDebounce);
    this._wysiwygEditor?.destroy();
    this._sourceEditor?.destroy();
    this._jsxPreview?.destroy();
    this._collabProvider?.destroy();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'multi-editor': MultiEditor;
  }
}
