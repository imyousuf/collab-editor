import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { WysiwygEditor } from './editors/wysiwyg-editor.js';
import { SourceEditor } from './editors/source-editor.js';
import { CollabProvider } from './collab/yjs-provider.js';
import { syncWysiwygToSource, syncSourceToWysiwyg } from './collab/view-sync.js';
import { EditorChangeEvent, ModeChangeEvent, EditorSaveEvent, CollabStatusEvent } from './events.js';
import type { EditorMode, EditorFormat, EditorTheme, CollaborationConfig } from './types.js';

@customElement('multi-editor')
export class MultiEditor extends LitElement {
  @property({ type: String, reflect: true }) mode: EditorMode = 'wysiwyg';
  @property({ type: String }) format: EditorFormat = 'markdown';
  @property({ type: String }) language: string = 'markdown';
  @property({ type: String }) placeholder: string = 'Start writing...';
  @property({ type: String, reflect: true }) theme: EditorTheme = 'light';
  @property({ type: Boolean }) readonly: boolean = false;

  @property({ attribute: false }) collaboration: CollaborationConfig | null = null;

  @state() private _collabStatus: 'connecting' | 'connected' | 'disconnected' = 'disconnected';

  private _collabProvider: CollabProvider | null = null;
  private _wysiwygEditor: WysiwygEditor | null = null;
  private _sourceEditor: SourceEditor | null = null;
  private _changeDebounce: ReturnType<typeof setTimeout> | null = null;
  private _initialized = false;
  private _lastCollabConfig: CollaborationConfig | null = null;

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
    `;
  }

  firstUpdated() {
    this._setupKeyboardShortcuts();
    this._setupCollaboration();
    this._createEditors();
    this._initialized = true;
    this._lastCollabConfig = this.collaboration;
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('collaboration') && this._initialized && this.collaboration !== this._lastCollabConfig) {
      this._lastCollabConfig = this.collaboration;
      this._setupCollaboration();
      // Enable collaboration on the WYSIWYG editor via dynamic import
      if (this._collabProvider && this._wysiwygEditor) {
        this._wysiwygEditor.enableCollaboration(this._collabProvider).catch((e) => {
          console.warn('Failed to enable collaboration:', e);
        });
      }
    }
    if (changed.has('readonly')) {
      this._wysiwygEditor?.setReadonly(this.readonly);
      this._sourceEditor?.setReadonly(this.readonly);
    }
    if (changed.has('language')) {
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

  private _createEditors() {
    const wysiwygContainer = this.renderRoot.querySelector('#wysiwyg-container') as HTMLElement;
    const sourceContainer = this.renderRoot.querySelector('#source-container') as HTMLElement;

    if (wysiwygContainer) {
      try {
        this._wysiwygEditor = new WysiwygEditor(
          wysiwygContainer,
          this._collabProvider,
          { placeholder: this.placeholder, readonly: this.readonly, theme: this.theme },
        );
        this._wysiwygEditor.editor.on('update', () => this._emitChange());
      } catch (e) {
        (window as any).__wysiwygErr = e instanceof Error ? e.message + '\n' + e.stack : String(e);
        console.error('Failed to create WYSIWYG editor: ' + (window as any).__wysiwygErr);
      }
    }

    if (sourceContainer) {
      try {
        this._sourceEditor = new SourceEditor(
          sourceContainer,
          this._collabProvider,
          { language: this.language, readonly: this.readonly, theme: this.theme },
        );
      } catch (e) {
        console.error('Failed to create Source editor: ' + (e instanceof Error ? e.message + ' ' + e.stack : String(e)));
      }
    }

    if (this.mode === 'wysiwyg') {
      this._sourceEditor?.deactivate();
    }
  }

  private _recreateEditors() {
    this._wysiwygEditor?.destroy();
    this._sourceEditor?.destroy();
    this._wysiwygEditor = null;
    this._sourceEditor = null;

    const wysiwygContainer = this.renderRoot.querySelector('#wysiwyg-container') as HTMLElement;
    const sourceContainer = this.renderRoot.querySelector('#source-container') as HTMLElement;
    if (wysiwygContainer) wysiwygContainer.innerHTML = '';
    if (sourceContainer) sourceContainer.innerHTML = '';

    this._createEditors();
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

    const cancelEvent = new CustomEvent('before-mode-change', {
      detail: { mode: newMode, previousMode: this.mode },
      cancelable: true,
      bubbles: true,
      composed: true,
    });
    if (!this.dispatchEvent(cancelEvent)) return;

    const previousMode = this.mode;

    if (previousMode === 'wysiwyg' && newMode === 'source') {
      if (this._wysiwygEditor && this._sourceEditor) {
        this._sourceEditor.deactivate();
        this._sourceEditor.setContent(this._wysiwygEditor.getContent(this.format));
      }
    } else if (previousMode === 'source' && newMode === 'wysiwyg') {
      if (this._sourceEditor && this._wysiwygEditor) {
        this._wysiwygEditor.setContent(this._sourceEditor.getContent());
        this._sourceEditor.deactivate();
      }
    }

    this.mode = newMode;
    this.dispatchEvent(new ModeChangeEvent({ mode: newMode, previousMode }));
  }

  getContent(format?: EditorFormat): string {
    const fmt = format ?? this.format;
    if (this.mode === 'wysiwyg') {
      return this._wysiwygEditor?.getContent(fmt) ?? '';
    }
    return this._sourceEditor?.getContent() ?? '';
  }

  setContent(content: string, format?: EditorFormat): void {
    if (this.mode === 'wysiwyg') {
      this._wysiwygEditor?.setContent(content);
    } else {
      this._sourceEditor?.setContent(content);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._changeDebounce) clearTimeout(this._changeDebounce);
    this._wysiwygEditor?.destroy();
    this._sourceEditor?.destroy();
    this._collabProvider?.destroy();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'multi-editor': MultiEditor;
  }
}
