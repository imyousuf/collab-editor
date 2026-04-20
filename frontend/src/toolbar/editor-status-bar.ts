/**
 * Built-in status bar component for <multi-editor>.
 * Internal component — not part of the public API.
 *
 * Shows connection status, current document name, user identity,
 * and collaborator presence with avatars.
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { CollabStatus } from '../interfaces/collaboration.js';
import type { StatusBarConfig, CollaboratorInfo } from '../interfaces/toolbar-config.js';

const STATUS_LABELS: Record<CollabStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting...',
  disconnected: 'Disconnected',
};

/** Truncate a path to show only the filename, prefixed with "..." if there's a directory part */
function truncatePath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 1) return path;
  return '\u2026' + parts[parts.length - 1];
}

/** Generate initials from a name (first letter of first two words) */
function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
}

@customElement('editor-status-bar')
export class EditorStatusBar extends LitElement {
  @property({ attribute: false }) status: CollabStatus = 'disconnected';
  @property({ attribute: false }) userName: string = '';
  @property({ attribute: false }) userImage: string = '';
  @property({ attribute: false }) userColor: string = '';
  @property({ attribute: false }) documentName: string = '';
  @property({ attribute: false }) collaborators: CollaboratorInfo[] = [];
  @property({ attribute: false }) config: StatusBarConfig | null = null;
  @property({ type: Number }) versionCount = 0;
  @property({ type: Boolean }) versionPanelOpen = false;

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
      min-height: 28px;
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
    .status-dot.connected { background: var(--me-status-connected-color, #22c55e); }
    .status-dot.connecting { background: var(--me-status-connecting-color, #eab308); }
    .status-dot.disconnected { background: var(--me-status-disconnected-color, #ef4444); }

    .doc-name {
      font-weight: 500;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .separator-dot {
      color: var(--me-toolbar-separator-color, var(--me-border-color, #ccc));
    }

    .presence {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .avatar {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 600;
      color: #fff;
      flex-shrink: 0;
      overflow: hidden;
      border: 1.5px solid var(--me-status-bg, rgba(248, 249, 250, 0.85));
    }
    .avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .collab-avatars {
      display: flex;
      align-items: center;
    }
    .collab-avatars .avatar {
      margin-left: -6px;
    }
    .collab-avatars .avatar:first-child {
      margin-left: 0;
    }

    .user-label {
      font-weight: 500;
    }

    .version-indicator {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .version-indicator:hover {
      background: var(--me-toolbar-hover-bg, rgba(0,0,0,0.06));
    }
    .version-indicator.active {
      background: var(--me-toolbar-button-active-bg, rgba(0,0,0,0.1));
    }
    .version-icon {
      font-size: 14px;
    }
  `;

  render() {
    const showStatus = this.config?.showConnectionStatus !== false;
    const showUser = this.config?.showUserIdentity !== false;
    const showPresence = this.config?.showPresence !== false;
    const showVersions = this.config?.showVersionHistory !== false && this.versionCount > 0;

    return html`
      <div class="left">
        ${showStatus ? this._renderStatus() : nothing}
        ${showStatus && this.documentName ? html`<span class="separator-dot">&middot;</span>` : nothing}
        ${this.documentName ? this._renderDocName() : nothing}
        ${showVersions ? html`<span class="separator-dot">&middot;</span>` : nothing}
        ${showVersions ? this._renderVersionIndicator() : nothing}
      </div>
      <div class="right">
        ${showPresence && this.collaborators.length > 0 ? this._renderCollaborators() : nothing}
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

  private _renderDocName() {
    return html`
      <span class="doc-name" part="document-name" title="${this.documentName}">${truncatePath(this.documentName)}</span>
    `;
  }

  private _renderCollaborators() {
    return html`
      <div class="collab-avatars" part="presence">
        ${this.collaborators.map(c => this._renderAvatar(c.name, c.color, c.image))}
      </div>
    `;
  }

  private _renderUser() {
    return html`
      <span class="presence" part="user-name">
        ${this._renderAvatar(this.userName, this.userColor, this.userImage)}
        <span class="user-label">${this.userName}</span>
      </span>
    `;
  }

  private _renderVersionIndicator() {
    return html`
      <span
        class="version-indicator ${this.versionPanelOpen ? 'active' : ''}"
        part="version-indicator"
        @click=${this._onVersionClick}
        title="Version History"
      >
        <span class="version-icon">&#x1f554;</span>
        <span>${this.versionCount} version${this.versionCount !== 1 ? 's' : ''}</span>
      </span>
    `;
  }

  private _onVersionClick() {
    this.dispatchEvent(new CustomEvent('version-toggle', {
      bubbles: true,
      composed: true,
    }));
  }

  private _renderAvatar(name: string, color: string, image?: string) {
    if (image) {
      return html`<span class="avatar" style="background:${color}" title="${name}"><img src="${image}" alt="${name}"></span>`;
    }
    return html`<span class="avatar" style="background:${color || '#888'}" title="${name}">${initials(name)}</span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'editor-status-bar': EditorStatusBar;
  }
}
