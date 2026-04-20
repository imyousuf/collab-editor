/**
 * Version history panel — dropdown anchored to the status bar.
 *
 * Shows version list, allows diff between versions, revert, and manual save.
 */

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { VersionListEntry, VersionEntry, DiffLine } from '../collab/version-manager.js';

@customElement('version-panel')
export class VersionPanel extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) versions: VersionListEntry[] = [];
  @property({ attribute: false }) diffResult: DiffLine[] | null = null;
  @property({ attribute: false }) selectedVersion: VersionEntry | null = null;

  @state() private _diffFrom: string | null = null;
  @state() private _diffTo: string | null = null;

  static override styles = css`
    :host {
      position: absolute;
      bottom: 32px;
      right: 0;
      z-index: 1000;
      display: none;
    }
    :host([open]) {
      display: block;
    }
    .panel {
      background: var(--me-bg, #fff);
      border: 1px solid var(--me-toolbar-border, #d0d7de);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.12);
      max-height: 400px;
      width: 380px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .header {
      padding: 10px 14px;
      border-bottom: 1px solid var(--me-toolbar-border, #d0d7de);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
      font-size: 13px;
    }
    .version-list {
      overflow-y: auto;
      max-height: 250px;
      padding: 4px 0;
    }
    .version-item {
      padding: 8px 14px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      border-bottom: 1px solid var(--me-toolbar-border, #eee);
    }
    .version-item:hover {
      background: var(--me-toolbar-hover-bg, #f5f5f5);
    }
    .version-item.selected {
      background: var(--me-toolbar-button-active-bg, #e8e8e8);
    }
    .version-meta {
      flex: 1;
    }
    .version-label {
      font-weight: 500;
    }
    .version-date {
      color: var(--me-status-text, #666);
      font-size: 11px;
    }
    .version-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--me-toolbar-border, #e0e0e0);
      margin-left: 8px;
    }
    .version-badge.manual {
      background: var(--me-version-badge-manual-bg, #dbeafe);
      color: var(--me-version-badge-manual-color, #1e40af);
    }
    .version-badge.auto {
      background: var(--me-version-badge-auto-bg, #dcfce7);
      color: var(--me-version-badge-auto-color, #166534);
    }
    .actions {
      padding: 8px 14px;
      border-top: 1px solid var(--me-toolbar-border, #d0d7de);
      display: flex;
      gap: 8px;
    }
    .btn {
      padding: 4px 10px;
      border: 1px solid var(--me-toolbar-border, #d0d7de);
      border-radius: 4px;
      background: var(--me-bg, #fff);
      cursor: pointer;
      font-size: 12px;
    }
    .btn:hover { background: var(--me-toolbar-hover-bg, #f5f5f5); }
    .btn-primary {
      background: var(--me-version-btn-primary-bg, #2563eb);
      color: var(--me-version-btn-primary-color, #fff);
      border-color: var(--me-version-btn-primary-bg, #2563eb);
    }
    .btn-primary:hover {
      background: var(--me-version-btn-primary-hover-bg, #1d4ed8);
    }
    .diff-view {
      max-height: 200px;
      overflow-y: auto;
      font-family: var(--me-source-font-family, monospace);
      font-size: 12px;
      padding: 8px;
      border-top: 1px solid var(--me-toolbar-border, #d0d7de);
    }
    .diff-line { padding: 1px 4px; white-space: pre-wrap; }
    .diff-added {
      background: var(--me-diff-added-bg, #dcfce7);
      color: var(--me-diff-added-color, #166534);
    }
    .diff-removed {
      background: var(--me-diff-removed-bg, #fce7e7);
      color: var(--me-diff-removed-color, #991b1b);
      text-decoration: line-through;
    }
    .diff-unchanged { color: var(--me-status-text, #666); }
    .empty { padding: 20px; text-align: center; color: var(--me-status-text, #999); font-size: 12px; }
  `;

  override render(): TemplateResult {
    if (!this.open) return html``;

    return html`
      <div class="panel">
        <div class="header">
          <span>Version History</span>
          <button class="btn btn-primary" @click=${this._onSaveVersion}>Save Version</button>
        </div>

        ${this.versions.length === 0
          ? html`<div class="empty">No versions yet</div>`
          : html`
            <div class="version-list">
              ${this.versions.map(v => this._renderVersionItem(v))}
            </div>
          `}

        ${this.diffResult
          ? html`
            <div class="diff-view">
              ${this.diffResult.map(line => html`
                <div class="diff-line ${line.type === 'added' ? 'diff-added' : line.type === 'removed' ? 'diff-removed' : 'diff-unchanged'}">${line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  '}${line.content}</div>
              `)}
            </div>
          ` : nothing}

        ${this.selectedVersion
          ? html`
            <div class="actions">
              <button class="btn" @click=${this._onViewVersion}>View</button>
              <button class="btn" @click=${this._onRevertVersion}>Revert to This</button>
              ${this._diffFrom ? html`
                <button class="btn" @click=${this._onDiff}>Show Diff</button>
              ` : nothing}
            </div>
          ` : nothing}
      </div>
    `;
  }

  private _renderVersionItem(v: VersionListEntry): TemplateResult {
    const isSelected = this.selectedVersion?.id === v.id;
    const date = new Date(v.created_at);
    const timeStr = date.toLocaleString();

    return html`
      <div
        class="version-item ${isSelected ? 'selected' : ''}"
        @click=${() => this._selectVersion(v)}
      >
        <div class="version-meta">
          <div class="version-label">${v.label || v.id.substring(0, 8)}</div>
          <div class="version-date">${timeStr} ${v.creator ? `by ${v.creator}` : ''}</div>
        </div>
        <span class="version-badge ${v.type}">${v.type}</span>
      </div>
    `;
  }

  private _selectVersion(v: VersionListEntry): void {
    if (this.selectedVersion?.id === v.id) {
      // Second click = set as diff target
      this._diffTo = v.id;
    } else {
      this._diffFrom = this.selectedVersion?.id ?? null;
    }

    this.dispatchEvent(new CustomEvent('version-select', {
      detail: { versionId: v.id },
      bubbles: true,
      composed: true,
    }));
  }

  private _onSaveVersion(): void {
    this.dispatchEvent(new CustomEvent('version-save', {
      bubbles: true,
      composed: true,
    }));
  }

  private _onViewVersion(): void {
    if (!this.selectedVersion) return;
    this.dispatchEvent(new CustomEvent('version-view', {
      detail: { versionId: this.selectedVersion.id },
      bubbles: true,
      composed: true,
    }));
  }

  private _onRevertVersion(): void {
    if (!this.selectedVersion) return;
    this.dispatchEvent(new CustomEvent('version-revert', {
      detail: { versionId: this.selectedVersion.id },
      bubbles: true,
      composed: true,
    }));
  }

  private _onDiff(): void {
    if (!this._diffFrom || !this.selectedVersion) return;
    this.dispatchEvent(new CustomEvent('version-diff', {
      detail: { fromId: this._diffFrom, toId: this.selectedVersion.id },
      bubbles: true,
      composed: true,
    }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'version-panel': VersionPanel;
  }
}
