/**
 * Version history panel — dropdown anchored to the status bar.
 *
 * Shows version list, allows diff between versions, revert, and manual save.
 */

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { VersionListEntry, VersionEntry, DiffLine } from '../collab/version-manager.js';

type PanelView = 'list' | 'diff';

@customElement('version-panel')
export class VersionPanel extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) versions: VersionListEntry[] = [];
  @property({ attribute: false }) diffResult: DiffLine[] | null = null;
  @property({ attribute: false }) selectedVersion: VersionEntry | null = null;

  @state() private _diffFrom: string | null = null;
  @state() private _diffTo: string | null = null;
  @state() private _view: PanelView = 'list';

  override willUpdate(changed: Map<string, unknown>): void {
    // Reset internal selection state when versions list changes (document switch)
    if (changed.has('versions')) {
      const oldVersions = changed.get('versions') as VersionListEntry[] | undefined;
      const newIds = this.versions.map(v => v.id).join(',');
      const oldIds = oldVersions?.map(v => v.id).join(',') ?? '';
      // Only reset if the version IDs actually changed (not just a re-render)
      if (newIds !== oldIds) {
        this._diffFrom = null;
        this._diffTo = null;
        this._view = 'list';
      }
    }
  }

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
      max-height: 420px;
      width: 400px;
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
    .hint {
      padding: 6px 14px;
      font-size: 11px;
      color: var(--me-status-color, #666);
      border-bottom: 1px solid var(--me-toolbar-border, #eee);
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
      border-left: 3px solid transparent;
    }
    .version-item:hover {
      background: var(--me-toolbar-button-hover-bg, #f5f5f5);
    }
    .version-item.diff-from {
      border-left-color: var(--me-version-btn-primary-bg, #2563eb);
      background: rgba(37, 99, 235, 0.06);
    }
    .version-item.diff-to {
      border-left-color: var(--me-version-badge-auto-color, #166534);
      background: rgba(22, 101, 52, 0.06);
    }
    .version-meta {
      flex: 1;
    }
    .version-label {
      font-weight: 500;
    }
    .version-date {
      color: var(--me-status-color, #666);
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
    .diff-tag {
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 3px;
      font-weight: 600;
      margin-left: 6px;
    }
    .diff-tag.from {
      background: var(--me-version-btn-primary-bg, #2563eb);
      color: #fff;
    }
    .diff-tag.to {
      background: var(--me-version-badge-auto-color, #166534);
      color: #fff;
    }
    .actions {
      padding: 8px 14px;
      border-top: 1px solid var(--me-toolbar-border, #d0d7de);
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .btn {
      padding: 4px 10px;
      border: 1px solid var(--me-toolbar-border, #d0d7de);
      border-radius: 4px;
      background: var(--me-bg, #fff);
      cursor: pointer;
      font-size: 12px;
    }
    .btn:hover { background: var(--me-toolbar-button-hover-bg, #f5f5f5); }
    .btn:disabled { opacity: 0.4; cursor: default; }
    .btn-primary {
      background: var(--me-version-btn-primary-bg, #2563eb);
      color: var(--me-version-btn-primary-color, #fff);
      border-color: var(--me-version-btn-primary-bg, #2563eb);
    }
    .btn-primary:hover {
      background: var(--me-version-btn-primary-hover-bg, #1d4ed8);
    }
    .diff-header {
      padding: 8px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      font-weight: 500;
      border-bottom: 1px solid var(--me-toolbar-border, #d0d7de);
    }
    .diff-view {
      overflow-y: auto;
      max-height: 280px;
      font-family: var(--me-source-font-family, monospace);
      font-size: 12px;
      padding: 8px;
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
    .diff-unchanged { color: var(--me-status-color, #666); }
    .empty { padding: 20px; text-align: center; color: var(--me-status-color, #999); font-size: 12px; }
  `;

  override render(): TemplateResult {
    if (!this.open) return html``;

    return html`
      <div class="panel">
        ${this._view === 'diff' && this.diffResult
          ? this._renderDiffView()
          : this._renderListView()}
      </div>
    `;
  }

  private _renderListView(): TemplateResult {
    return html`
      <div class="header">
        <span>Version History</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="btn btn-primary" @click=${this._onSaveVersion}>Save Version</button>
          <button class="btn" @click=${this._onClose} title="Close">&times;</button>
        </div>
      </div>

      ${this.versions.length === 0
        ? html`<div class="empty">No versions yet. Click "Save Version" to create one.</div>`
        : html`
          <div class="hint">Click two versions to compare, or click one to view/revert.</div>
          <div class="version-list">
            ${this.versions.map(v => this._renderVersionItem(v))}
          </div>
        `}

      ${this._diffFrom || this.selectedVersion ? html`
        <div class="actions">
          ${this.selectedVersion && !this._diffTo ? html`
            <button class="btn" @click=${this._onViewVersion}>View</button>
            <button class="btn" @click=${this._onRevertVersion}>Revert</button>
          ` : nothing}
          ${this._diffFrom && this._diffTo ? html`
            <button class="btn btn-primary" @click=${this._onDiff}>Compare</button>
          ` : nothing}
          <button class="btn" @click=${this._clearSelection}>Clear</button>
        </div>
      ` : nothing}
    `;
  }

  private _renderDiffView(): TemplateResult {
    const fromVersion = this.versions.find(v => v.id === this._diffFrom);
    const toVersion = this.versions.find(v => v.id === this._diffTo);
    const fromLabel = fromVersion?.label || fromVersion?.id?.substring(0, 8) || '?';
    const toLabel = toVersion?.label || toVersion?.id?.substring(0, 8) || '?';

    return html`
      <div class="diff-header">
        <span>${fromLabel} vs ${toLabel}</span>
        <button class="btn" @click=${this._backToList}>Back</button>
      </div>
      ${this.diffResult!.length === 0 || this.diffResult!.every(l => l.type === 'unchanged')
        ? html`<div class="empty">No differences between these versions.</div>`
        : html`
          <div class="diff-view">
            ${this.diffResult!.map(line => html`
              <div class="diff-line ${line.type === 'added' ? 'diff-added' : line.type === 'removed' ? 'diff-removed' : 'diff-unchanged'}">${line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  '}${line.content}</div>
            `)}
          </div>
        `}
    `;
  }

  private _renderVersionItem(v: VersionListEntry): TemplateResult {
    const isDiffFrom = this._diffFrom === v.id;
    const isDiffTo = this._diffTo === v.id;
    const date = new Date(v.created_at);
    const timeStr = date.toLocaleString();

    let itemClass = 'version-item';
    if (isDiffFrom) itemClass += ' diff-from';
    if (isDiffTo) itemClass += ' diff-to';

    return html`
      <div class="${itemClass}" @click=${() => this._selectVersion(v)}>
        <div class="version-meta">
          <div class="version-label">
            ${v.label || v.id.substring(0, 8)}
            ${isDiffFrom ? html`<span class="diff-tag from">FROM</span>` : nothing}
            ${isDiffTo ? html`<span class="diff-tag to">TO</span>` : nothing}
          </div>
          <div class="version-date">${timeStr} ${v.creator ? `by ${v.creator}` : ''}</div>
        </div>
        <span class="version-badge ${v.type}">${v.type}</span>
      </div>
    `;
  }

  private _selectVersion(v: VersionListEntry): void {
    if (this._diffFrom === null) {
      // First click — set as "from"
      this._diffFrom = v.id;
    } else if (this._diffFrom === v.id) {
      // Clicking same "from" again — deselect
      this._diffFrom = this._diffTo;
      this._diffTo = null;
    } else if (this._diffTo === v.id) {
      // Clicking same "to" again — deselect it
      this._diffTo = null;
    } else if (this._diffTo === null) {
      // Second click on different version — set as "to"
      this._diffTo = v.id;
    } else {
      // Already have from+to, clicking a third — replace "to"
      this._diffTo = v.id;
    }

    this.dispatchEvent(new CustomEvent('version-select', {
      detail: { versionId: v.id },
      bubbles: true,
      composed: true,
    }));
  }

  private _clearSelection(): void {
    this._diffFrom = null;
    this._diffTo = null;
    this._view = 'list';
    // Clear diffResult via event so parent resets its state
    this.dispatchEvent(new CustomEvent('version-diff-clear', {
      bubbles: true,
      composed: true,
    }));
  }

  private _backToList(): void {
    this._view = 'list';
  }

  private _onClose(): void {
    this.dispatchEvent(new CustomEvent('version-close', {
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
    const id = this._diffFrom; // single selection = diffFrom only
    if (!id) return;
    this.dispatchEvent(new CustomEvent('version-view', {
      detail: { versionId: id },
      bubbles: true,
      composed: true,
    }));
  }

  private _onRevertVersion(): void {
    const id = this._diffFrom;
    if (!id) return;
    this.dispatchEvent(new CustomEvent('version-revert', {
      detail: { versionId: id },
      bubbles: true,
      composed: true,
    }));
  }

  private _onDiff(): void {
    if (!this._diffFrom || !this._diffTo) return;
    this._view = 'diff';
    this.dispatchEvent(new CustomEvent('version-diff', {
      detail: { fromId: this._diffFrom, toId: this._diffTo },
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
