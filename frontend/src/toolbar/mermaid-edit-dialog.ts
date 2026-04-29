/**
 * Modal dialog for editing the source of a Mermaid code block.
 *
 * Mounted on demand by the WYSIWYG editor when the user clicks the
 * pencil on a rendered Mermaid block. The dialog is independent of the
 * Tiptap editor — it just hands back the new source via a `mermaid-save`
 * event. The host (in _wysiwyg-editor.ts) is responsible for translating
 * that into a single ProseMirror transaction so the change flows through
 * the normal Y.Text path.
 *
 * Events:
 *   - mermaid-save   { source }
 *   - mermaid-cancel
 *
 * Keyboard:
 *   - Esc       → cancel
 *   - Cmd/Ctrl+Enter → save
 */

import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { renderMermaid } from '../collab/mermaid-renderer.js';

@customElement('mermaid-edit-dialog')
export class MermaidEditDialog extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) source = '';

  @state() private _draft = '';
  @state() private _previewSvg: SVGElement | null = null;
  @state() private _previewError: string | null = null;

  private _previewTimer: ReturnType<typeof setTimeout> | null = null;
  private _previewSeq = 0;

  static override styles = css`
    :host {
      display: none;
      position: fixed;
      inset: 0;
      z-index: var(--me-z-overlay, 2000);
    }
    :host([open]) { display: block; }
    .scrim {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
    }
    .dialog {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(880px, 92vw);
      max-height: 88vh;
      display: flex;
      flex-direction: column;
      background: var(--me-mermaid-dialog-bg, var(--me-bg, #fff));
      color: var(--me-fg, #1c1c1c);
      border: 1px solid var(--me-toolbar-border, #d0d7de);
      border-radius: 10px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.24);
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--me-toolbar-border, #eee);
      font-weight: 600;
    }
    header button {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      color: inherit;
      padding: 4px 8px;
      border-radius: 4px;
    }
    header button:hover { background: var(--me-hover, rgba(0, 0, 0, 0.06)); }
    .body {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      padding: 12px 16px;
      overflow: hidden;
      min-height: 280px;
    }
    @media (max-width: 700px) {
      .body { grid-template-columns: 1fr; }
    }
    .pane {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .pane label {
      font-size: 12px;
      color: var(--me-status-color, #555);
      margin-bottom: 6px;
    }
    textarea {
      flex: 1;
      width: 100%;
      box-sizing: border-box;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.5;
      padding: 10px;
      border: 1px solid var(--me-toolbar-border, #d0d7de);
      border-radius: 6px;
      resize: none;
      background: var(--me-mermaid-textarea-bg, #fafbfc);
      color: inherit;
    }
    .preview {
      flex: 1;
      border: 1px solid var(--me-toolbar-border, #d0d7de);
      border-radius: 6px;
      padding: 12px;
      overflow: auto;
      background: var(--me-mermaid-bg, #fafbfc);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .preview svg { max-width: 100%; height: auto; }
    .preview .error {
      color: var(--me-error-color, #b42318);
      font-family: ui-monospace, monospace;
      font-size: 12px;
      white-space: pre-wrap;
      align-self: stretch;
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid var(--me-toolbar-border, #eee);
      background: var(--me-mermaid-footer-bg, #f6f8fa);
    }
    footer button {
      padding: 6px 14px;
      border-radius: 6px;
      border: 1px solid var(--me-toolbar-border, #d0d7de);
      background: var(--me-bg, #fff);
      color: inherit;
      cursor: pointer;
      font-size: 13px;
    }
    footer button:hover { background: var(--me-hover, #f0f1f3); }
    footer button.primary {
      background: var(--me-accent, #2563eb);
      color: #fff;
      border-color: var(--me-accent, #2563eb);
    }
    footer button.primary:hover { background: var(--me-accent-hover, #1d4ed8); }
  `;

  override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has('open') && this.open) {
      this._draft = this.source;
      this._scheduleRender(this._draft, /*immediate*/ true);
    }
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('open') && this.open) {
      // Focus the textarea after layout so the user can start typing.
      const ta = this.renderRoot.querySelector('textarea');
      ta?.focus();
      ta?.setSelectionRange(this._draft.length, this._draft.length);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._previewTimer) {
      clearTimeout(this._previewTimer);
      this._previewTimer = null;
    }
  }

  private _onInput(e: Event): void {
    this._draft = (e.target as HTMLTextAreaElement).value;
    this._scheduleRender(this._draft, /*immediate*/ false);
  }

  private _scheduleRender(code: string, immediate: boolean): void {
    if (this._previewTimer) clearTimeout(this._previewTimer);
    const run = () => {
      const seq = ++this._previewSeq;
      renderMermaid(code).then((out) => {
        if (seq !== this._previewSeq) return; // a newer render superseded us
        if (out.ok) {
          this._previewSvg = out.svg;
          this._previewError = null;
        } else {
          this._previewSvg = null;
          this._previewError = out.message;
        }
      });
    };
    if (immediate) run();
    else this._previewTimer = setTimeout(run, 250);
  }

  private _onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this._cancel();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this._save();
    }
  }

  private _save(): void {
    this.dispatchEvent(
      new CustomEvent('mermaid-save', {
        detail: { source: this._draft },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _cancel(): void {
    this.dispatchEvent(
      new CustomEvent('mermaid-cancel', { bubbles: true, composed: true }),
    );
  }

  override render() {
    return html`
      <div class="scrim" @click=${this._cancel}></div>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="Edit Mermaid diagram">
        <header>
          <span>Edit Mermaid diagram</span>
          <button type="button" @click=${this._cancel} aria-label="Close">×</button>
        </header>
        <div class="body">
          <div class="pane">
            <label for="mermaid-src">Source</label>
            <textarea
              id="mermaid-src"
              spellcheck="false"
              .value=${this._draft}
              @input=${this._onInput}
              @keydown=${this._onKeydown}
            ></textarea>
          </div>
          <div class="pane">
            <label>Preview</label>
            <div class="preview">
              ${this._previewError
                ? html`<div class="error">${this._previewError}</div>`
                : this._previewSvg
                  ? this._previewSvg
                  : html`<span style="color: var(--me-status-color, #888)">Loading…</span>`}
            </div>
          </div>
        </div>
        <footer>
          <button type="button" @click=${this._cancel}>Cancel</button>
          <button type="button" class="primary" @click=${this._save}>Save</button>
        </footer>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mermaid-edit-dialog': MermaidEditDialog;
  }
}
