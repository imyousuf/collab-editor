/**
 * Built-in toolbar component for <multi-editor>.
 * Internal component — not part of the public API.
 *
 * Renders mode switcher buttons and formatting buttons (WYSIWYG only).
 * Communicates with multi-editor via CustomEvents.
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { EditorMode } from '../interfaces/editor-binding.js';
import type { FormattingCommand, FormattingState } from '../interfaces/formatting.js';
import { emptyFormattingState } from '../interfaces/formatting.js';
import type { ToolbarConfig, ToolbarGroup, DocumentEntry } from '../interfaces/toolbar-config.js';

/** Mode button definitions with icons */
const MODE_LABELS: Record<EditorMode, string> = {
  wysiwyg: 'WYSIWYG',
  source: 'Source',
  preview: 'Preview',
};

/** SVG icon paths for mode buttons (viewBox 0 0 24 24, stroke-based) */
const MODE_ICONS: Record<EditorMode, string> = {
  wysiwyg: 'M4 6h16M4 10h16M4 14h10M4 18h12',  // rich text lines
  source: 'M16 18l6-6-6-6M8 6l-6 6 6 6',        // code brackets </>
  preview: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', // eye
};

/** Formatting button definitions */
interface FormattingButton {
  command: FormattingCommand;
  label: string;
  /** SVG path data for the icon (viewBox 0 0 24 24) */
  icon: string;
}

const FORMATTING_BUTTONS: FormattingButton[] = [
  { command: 'bold', label: 'Bold', icon: 'M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6zm0 8h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z' },
  { command: 'italic', label: 'Italic', icon: 'M10 4h4l-2 16h-4z M14 4h4 M6 20h4' },
  { command: 'strike', label: 'Strikethrough', icon: 'M16 4c-1.5 0-3 .5-3 2s1.5 2 3 2 3 .5 3 2-1.5 2-3 2M4 12h16' },
  { command: 'code', label: 'Code', icon: 'M16 18l6-6-6-6M8 6l-6 6 6 6' },
  { command: 'heading1', label: 'Heading 1', icon: 'M4 4v16M4 12h8M12 4v16M20 8v8M20 8h-2' },
  { command: 'heading2', label: 'Heading 2', icon: 'M4 4v16M4 12h8M12 4v16M18 8a2 2 0 1 1 0 4c-2 0 0 4-2 4h4' },
  { command: 'heading3', label: 'Heading 3', icon: 'M4 4v16M4 12h8M12 4v16M18 8a2 2 0 1 1 0 3 2 2 0 1 1 0 3' },
  { command: 'bulletList', label: 'Bullet List', icon: 'M9 6h11M9 12h11M9 18h11M5 6h.01M5 12h.01M5 18h.01' },
  { command: 'orderedList', label: 'Ordered List', icon: 'M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1' },
  { command: 'blockquote', label: 'Blockquote', icon: 'M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2z M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4z' },
  { command: 'horizontalRule', label: 'Horizontal Rule', icon: 'M4 12h16' },
  { command: 'link', label: 'Link', icon: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' },
  { command: 'codeBlock', label: 'Code Block', icon: 'M8 6l-4 6 4 6M16 6l4 6-4 6M14 4l-4 16' },
];

@customElement('editor-toolbar')
export class EditorToolbar extends LitElement {
  @property({ attribute: false }) mode: EditorMode = 'source';
  @property({ attribute: false }) supportedModes: EditorMode[] = ['source'];
  @property({ attribute: false }) formattingState: FormattingState = emptyFormattingState();
  @property({ attribute: false }) availableCommands: FormattingCommand[] = [];
  @property({ attribute: false }) config: ToolbarConfig | null = null;
  @property({ attribute: false }) documents: DocumentEntry[] = [];
  @property({ attribute: false }) currentDocumentId: string = '';
  @property({ type: Boolean }) readonly: boolean = false;
  @property({ type: Boolean }) blameActive: boolean = false;
  @property({ type: Boolean }) blameAvailable: boolean = false;

  static styles = css`
    :host {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--me-toolbar-gap, 2px);
      padding: var(--me-toolbar-padding, 6px 8px);
      background: var(--me-toolbar-bg, #f8f9fa);
      border-bottom: 1px solid var(--me-toolbar-border, var(--me-border-color, #e0e0e0));
    }
    :host([position="bottom"]) {
      border-bottom: none;
      border-top: 1px solid var(--me-toolbar-border, var(--me-border-color, #e0e0e0));
    }

    .group {
      display: flex;
      align-items: center;
      gap: var(--me-toolbar-gap, 2px);
    }

    .separator {
      width: 1px;
      height: 20px;
      background: var(--me-toolbar-separator-color, var(--me-border-color, #e0e0e0));
      margin: 0 4px;
    }

    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      background: var(--me-toolbar-button-bg, transparent);
      color: var(--me-icon-color, var(--me-color, #1a1a1a));
      border-radius: var(--me-toolbar-button-radius, 4px);
      transition: background 0.15s, color 0.15s;
    }
    button:hover:not(:disabled) {
      background: var(--me-toolbar-button-hover-bg, #e9ecef);
    }
    button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    button.active {
      background: var(--me-toolbar-button-active-bg, #333);
      color: var(--me-toolbar-button-active-color, #fff);
    }

    .mode-btn {
      padding: 4px;
      min-width: 28px;
      min-height: 28px;
    }
    .mode-btn svg {
      width: var(--me-icon-size, 18px);
      height: var(--me-icon-size, 18px);
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .fmt-btn {
      padding: 4px;
      min-width: 28px;
      min-height: 28px;
    }
    .fmt-btn svg {
      width: var(--me-icon-size, 18px);
      height: var(--me-icon-size, 18px);
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .doc-switcher {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    .doc-switcher .fmt-btn {
      pointer-events: none;
    }
    .doc-select-hidden {
      position: absolute;
      inset: 0;
      opacity: 0;
      cursor: pointer;
      width: 100%;
      font-size: 13px;
    }

    .spacer {
      flex: 1;
    }
  `;

  private _shouldShowGroup(group: ToolbarGroup): boolean {
    if (!this.config?.groups) return true;
    return this.config.groups.includes(group);
  }

  private _shouldShowCommand(command: FormattingCommand): boolean {
    if (!this.config?.formattingCommands) return true;
    return this.config.formattingCommands.includes(command);
  }

  render() {
    const showModeSwitcher = this.config?.showModeSwitcher !== false && this._shouldShowGroup('mode-switcher');
    const showFormatting = this.mode === 'wysiwyg' &&
      this.availableCommands.length > 0 &&
      this._shouldShowGroup('formatting');
    const showDocSwitcher = this.documents.length > 0 &&
      this.config?.showDocumentSwitcher !== false &&
      this._shouldShowGroup('document-switcher');

    const hasLeftContent = showModeSwitcher || showFormatting;

    return html`
      ${showModeSwitcher ? this._renderModeSwitcher() : nothing}
      ${showModeSwitcher && showFormatting ? html`<div class="separator" part="separator"></div>` : nothing}
      ${showFormatting ? this._renderFormattingButtons() : nothing}
      ${showDocSwitcher || this.blameAvailable ? html`<div class="spacer"></div>` : nothing}
      ${this.blameAvailable ? this._renderBlameToggle() : nothing}
      ${showDocSwitcher ? this._renderDocumentSwitcher() : nothing}
    `;
  }

  private _renderModeSwitcher() {
    return html`
      <div class="group">
        ${this.supportedModes.map(m => html`
          <button
            class="mode-btn ${m === this.mode ? 'active' : ''}"
            part="mode-button"
            title="${MODE_LABELS[m]}"
            @click=${() => this._dispatchModeSwitch(m)}
          ><svg viewBox="0 0 24 24"><path d="${MODE_ICONS[m]}"/></svg></button>
        `)}
      </div>
    `;
  }

  private _renderFormattingButtons() {
    const buttons = FORMATTING_BUTTONS.filter(
      b => this.availableCommands.includes(b.command) && this._shouldShowCommand(b.command),
    );

    return html`
      <div class="group">
        ${buttons.map(b => html`
          <button
            class="fmt-btn ${this.formattingState[b.command] ? 'active' : ''}"
            part="format-button"
            title="${b.label}"
            ?disabled=${this.readonly}
            @click=${() => this._dispatchCommand(b.command)}
          >
            <svg viewBox="0 0 24 24"><path d="${b.icon}"></path></svg>
          </button>
        `)}
      </div>
    `;
  }

  private _renderDocumentSwitcher() {
    return html`
      <div class="doc-switcher" part="document-switcher">
        <button class="fmt-btn" title="Switch document">
          <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
        </button>
        <select
          class="doc-select-hidden"
          .value=${this.currentDocumentId}
          @change=${(e: Event) => this._dispatchDocumentSwitch((e.target as HTMLSelectElement).value)}
        >
          ${this.documents.map(d => html`
            <option value=${d.id} ?selected=${d.id === this.currentDocumentId}>${d.name}</option>
          `)}
        </select>
      </div>
    `;
  }

  private _dispatchDocumentSwitch(documentId: string): void {
    this.dispatchEvent(new CustomEvent('toolbar-document-switch', {
      detail: { documentId },
      bubbles: true,
      composed: true,
    }));
  }

  private _dispatchModeSwitch(mode: EditorMode): void {
    this.dispatchEvent(new CustomEvent('toolbar-mode-switch', {
      detail: { mode },
      bubbles: true,
      composed: true,
    }));
  }

  private _dispatchCommand(command: FormattingCommand): void {
    this.dispatchEvent(new CustomEvent('toolbar-command', {
      detail: { command },
      bubbles: true,
      composed: true,
    }));
  }

  private _renderBlameToggle() {
    return html`
      <button
        class="fmt-btn ${this.blameActive ? 'active' : ''}"
        part="blame-button"
        title="${this.blameActive ? 'Disable Blame View' : 'Enable Blame View'}"
        @click=${this._dispatchBlameToggle}
      >
        <svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"></path></svg>
      </button>
    `;
  }

  private _dispatchBlameToggle(): void {
    this.dispatchEvent(new CustomEvent('toolbar-blame-toggle', {
      detail: { active: !this.blameActive },
      bubbles: true,
      composed: true,
    }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'editor-toolbar': EditorToolbar;
  }
}
