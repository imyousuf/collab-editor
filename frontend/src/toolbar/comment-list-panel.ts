/**
 * Resolved comments panel — dropdown anchored to the status bar.
 *
 * Resolved threads are hidden from the inline editor (no decorations)
 * so this panel is the only way to reach them. Click a row to open
 * the thread popover; the list panel closes itself on activation.
 */

import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { CommentThread } from '../interfaces/comments.js';

@customElement('comment-list-panel')
export class CommentListPanel extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) threads: CommentThread[] = [];

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
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
      width: 400px;
      max-height: 420px;
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
    .close {
      background: none;
      border: 1px solid var(--me-toolbar-border, #d0d7de);
      border-radius: 4px;
      padding: 2px 8px;
      cursor: pointer;
      font-size: 13px;
    }
    .close:hover {
      background: var(--me-toolbar-button-hover-bg, #f5f5f5);
    }
    .list {
      overflow-y: auto;
      max-height: 360px;
      padding: 4px 0;
    }
    .item {
      padding: 8px 14px;
      cursor: pointer;
      border-bottom: 1px solid var(--me-toolbar-border, #eee);
      border-left: 3px solid transparent;
    }
    .item:hover {
      background: var(--me-toolbar-button-hover-bg, #f5f5f5);
      border-left-color: var(--me-version-btn-primary-bg, #2563eb);
    }
    .item:last-child {
      border-bottom: none;
    }
    .quote {
      font-size: 12px;
      font-style: italic;
      color: var(--me-status-color, #444);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-bottom: 4px;
    }
    .meta {
      font-size: 11px;
      color: var(--me-comment-meta-color, #888);
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .empty {
      padding: 20px;
      text-align: center;
      color: var(--me-status-color, #999);
      font-size: 12px;
    }
  `;

  override render(): TemplateResult {
    if (!this.open) return html``;
    return html`
      <div class="panel">
        <div class="header">
          <span>Resolved Comments</span>
          <button class="close" @click=${this._onClose} title="Close">&times;</button>
        </div>
        ${this.threads.length === 0
          ? html`<div class="empty">No resolved comments.</div>`
          : html`<div class="list">${this.threads.map(t => this._renderItem(t))}</div>`}
      </div>
    `;
  }

  private _renderItem(t: CommentThread): TemplateResult {
    const first = t.comments[0];
    const author = first?.author_name ?? 'Unknown';
    const when = t.resolved_at ?? first?.created_at ?? '';
    const replyCount = Math.max(0, t.comments.length - 1);
    const quoted = t.anchor.quoted_text || '(orphaned)';
    return html`
      <div class="item" @click=${() => this._onSelect(t.id)}>
        <div class="quote" title="${quoted}">"${quoted}"</div>
        <div class="meta">
          <span>${author}${replyCount > 0 ? ` · ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}` : ''}</span>
          <span>${formatRelative(when)}</span>
        </div>
      </div>
    `;
  }

  private _onSelect(threadId: string): void {
    this.dispatchEvent(new CustomEvent('comment-thread-activate', {
      detail: { threadId },
      bubbles: true,
      composed: true,
    }));
  }

  private _onClose(): void {
    this.dispatchEvent(new CustomEvent('comment-list-close', {
      bubbles: true,
      composed: true,
    }));
  }
}

function formatRelative(iso: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = Date.now() - t;
  const mins = Math.round(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

declare global {
  interface HTMLElementTagNameMap {
    'comment-list-panel': CommentListPanel;
  }
}
