/**
 * Version manager — handles version lifecycle, auto-snapshots, and revert.
 *
 * Makes HTTP calls to the relay's /api proxy endpoints for version CRUD.
 * Uses the diff engine for comparing version contents.
 */

import * as Y from 'yjs';
import { computeLineDiff, type DiffLine } from './diff-engine.js';

export interface VersionEntry {
  id: string;
  created_at: string;
  type: 'auto' | 'manual';
  label?: string;
  creator?: string;
  content?: string;
  mime_type?: string;
  blame?: Array<{ start: number; end: number; user_name: string }>;
}

export interface VersionListEntry {
  id: string;
  created_at: string;
  type: 'auto' | 'manual';
  label?: string;
  creator?: string;
  mime_type?: string;
}

export interface VersionManagerConfig {
  relayUrl: string;
  documentId: string;
  authToken?: string;
  /** Create auto-snapshot every N updates. 0 = disabled. Default: 50. */
  autoSnapshotUpdates?: number;
  /** Create auto-snapshot every N minutes. 0 = disabled. Default: 5. */
  autoSnapshotMinutes?: number;
  /** User name for the creator field. */
  userName?: string;
}

export class VersionManager {
  private _ydoc: Y.Doc;
  private _config: VersionManagerConfig;
  private _updateCount = 0;
  private _lastSnapshotTime = Date.now();
  private _observer: ((update: Uint8Array, origin: any) => void) | null = null;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _destroyed = false;
  private _snapshotInFlight = false;

  constructor(ydoc: Y.Doc, config: VersionManagerConfig) {
    this._ydoc = ydoc;
    this._config = config;

    // Start auto-snapshot observer
    const threshold = config.autoSnapshotUpdates ?? 50;
    if (threshold > 0) {
      this._observer = () => {
        this._updateCount++;
        if (this._updateCount >= threshold) {
          this._autoSnapshot();
          this._updateCount = 0;
        }
      };
      this._ydoc.on('update', this._observer);
    }

    // Start time-based auto-snapshot
    const minutes = config.autoSnapshotMinutes ?? 5;
    if (minutes > 0) {
      this._timer = setInterval(() => {
        const elapsed = Date.now() - this._lastSnapshotTime;
        if (elapsed >= minutes * 60 * 1000 && this._updateCount > 0) {
          this._autoSnapshot();
          this._updateCount = 0;
        }
      }, 60 * 1000); // check every minute
    }
  }

  /** Create a version snapshot of the current document state. */
  async createVersion(label?: string, creator?: string): Promise<VersionListEntry | null> {
    const content = this._ydoc.getText('source').toString();
    const body = {
      content,
      label,
      creator: creator ?? this._config.userName ?? 'unknown',
      type: 'manual' as const,
    };

    const resp = await this._fetch('POST', '/documents/versions', body);
    if (!resp.ok) return null;

    this._lastSnapshotTime = Date.now();
    return resp.json();
  }

  /** List all versions for the document. */
  async listVersions(): Promise<VersionListEntry[]> {
    const resp = await this._fetch('GET', '/documents/versions');
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.versions ?? [];
  }

  /** Get a full version with content and blame. */
  async getVersion(versionId: string): Promise<VersionEntry | null> {
    const resp = await this._fetch(
      'GET',
      `/documents/versions/detail?version=${encodeURIComponent(versionId)}`,
    );
    if (!resp.ok) return null;
    return resp.json();
  }

  /** Compute a line diff between two versions' content. */
  diffVersions(v1: VersionEntry, v2: VersionEntry): DiffLine[] {
    return computeLineDiff(v1.content ?? '', v2.content ?? '');
  }

  /**
   * Revert to a version = delete all text, insert old content, create new version.
   * This preserves full history — it's a new edit, not a rollback.
   */
  async revertToVersion(version: VersionEntry): Promise<void> {
    const oldContent = version.content ?? '';
    const ytext = this._ydoc.getText('source');

    this._ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, oldContent);
    });

    await this.createVersion(
      `Reverted to ${version.label || version.id}`,
      this._config.userName,
    );
  }

  destroy(): void {
    this._destroyed = true;
    if (this._observer) {
      this._ydoc.off('update', this._observer);
      this._observer = null;
    }
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // --- Internal ---

  private async _autoSnapshot(): Promise<void> {
    if (this._destroyed || this._snapshotInFlight) return;
    this._snapshotInFlight = true;
    try {
      const content = this._ydoc.getText('source').toString();
      await this._fetch('POST', '/documents/versions', {
        content,
        type: 'auto',
        creator: this._config.userName ?? 'system',
      });
      this._lastSnapshotTime = Date.now();
    } catch {
      // Auto-snapshot failures are non-fatal
    } finally {
      this._snapshotInFlight = false;
    }
  }

  private async _fetch(method: string, path: string, body?: any): Promise<Response> {
    const separator = path.includes('?') ? '&' : '?';
    const url = `${this._config.relayUrl}/api${path}${separator}path=${encodeURIComponent(this._config.documentId)}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this._config.authToken) {
      headers['Authorization'] = `Bearer ${this._config.authToken}`;
    }

    return fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }
}

export type { DiffLine };
