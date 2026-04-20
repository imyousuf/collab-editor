/**
 * Built-in status bar component for <multi-editor>.
 * Internal component — not part of the public API.
 *
 * Shows connection status, user identity.
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { CollabStatus } from '../interfaces/collaboration.js';
import type { StatusBarConfig } from '../interfaces/toolbar-config.js';

const STATUS_LABELS: Record<CollabStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting...',
  disconnected: 'Disconnected',
};

@customElement('editor-status-bar')
export class EditorStatusBar extends LitElement {
  @property({ attribute: false }) status: CollabStatus = 'disconnected';
  @property({ attribute: false }) userName: string = '';
  @property({ attribute: false }) config: StatusBarConfig | null = null;

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 4px 8px;
      background: var(--me-status-bg, rgba(248, 249, 250, 0.85));
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      font-size: var(--me-status-font-size, 12px);
      color: var(--me-status-color, #666);
      min-height: 24px;
      pointer-events: auto;
      z-index: 1;
    }

    .left, .right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .status-indicator {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.connected {
      background: var(--me-status-connected-color, #22c55e);
    }
    .status-dot.connecting {
      background: var(--me-status-connecting-color, #eab308);
    }
    .status-dot.disconnected {
      background: var(--me-status-disconnected-color, #ef4444);
    }

    .user-name {
      font-weight: 500;
    }
  `;

  render() {
    const showStatus = this.config?.showConnectionStatus !== false;
    const showUser = this.config?.showUserIdentity !== false;

    return html`
      <div class="left">
        ${showStatus ? this._renderStatus() : nothing}
      </div>
      <div class="right">
        ${showUser && this.userName ? this._renderUser() : nothing}
      </div>
    `;
  }

  private _renderStatus() {
    return html`
      <span class="status-indicator" part="status-indicator">
        <span class="status-dot ${this.status}"></span>
        <span class="status-text">${STATUS_LABELS[this.status]}</span>
      </span>
    `;
  }

  private _renderUser() {
    return html`
      <span class="user-name" part="user-name">Editing as ${this.userName}</span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'editor-status-bar': EditorStatusBar;
  }
}
