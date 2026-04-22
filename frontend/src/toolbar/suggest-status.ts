/**
 * Suggest-Mode status indicator — shown only while Suggest Mode is on.
 *
 * Renders a small pill with the user's color dot, a "Suggesting" label,
 * a pending-change count, and Submit / Discard buttons.
 */

import { LitElement, css, html, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('suggest-status')
export class SuggestStatus extends LitElement {
  @property({ type: Boolean, reflect: true }) active = false;
  @property({ type: Number }) pendingChanges = 0;
  @property({ type: String }) userColor = '#1f77b4';
  @property({ type: String }) userName = '';

  static override styles = css`
    :host {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: rgba(31, 119, 180, 0.08);
      border: 1px solid rgba(31, 119, 180, 0.2);
      border-radius: 999px;
      font-size: 12px;
    }
    :host([active]) { display: inline-flex; }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--me-suggest-color, #1f77b4);
    }
    .label { font-weight: 600; color: #333; }
    .count { color: #666; }
    button {
      border: 1px solid transparent;
      background: none;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
    }
    button.primary {
      border-color: rgba(31, 119, 180, 0.5);
      color: rgba(31, 119, 180, 1);
    }
    button:hover { background: rgba(31, 119, 180, 0.1); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
  `;

  override render(): TemplateResult {
    return html`
      <span class="dot" style="--me-suggest-color: ${this.userColor}"></span>
      <span class="label">Suggesting</span>
      <span class="count">
        ${this.pendingChanges === 0
          ? 'no pending changes'
          : `${this.pendingChanges} pending ${this.pendingChanges === 1 ? 'change' : 'changes'}`}
      </span>
      <button
        class="primary"
        ?disabled=${this.pendingChanges === 0}
        @click=${() => this._dispatch('suggest-submit')}
      >Submit</button>
      <button @click=${() => this._dispatch('suggest-discard')}>Discard</button>
      <button @click=${() => this._dispatch('suggest-toggle-off')}>Exit</button>
    `;
  }

  private _dispatch(name: string): void {
    this.dispatchEvent(
      new CustomEvent(name, { bubbles: true, composed: true }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'suggest-status': SuggestStatus;
  }
}
