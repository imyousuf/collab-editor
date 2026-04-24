/**
 * VersionCoordinator — owns the version history feature lifecycle.
 *
 * Manages: VersionManager creation, version panel interactions (save, select,
 * view, revert, diff), and the read-only "version view" mode.
 *
 * The multi-editor orchestrator calls attach() when collaboration connects
 * and detach() on teardown. Panel event handlers are forwarded directly.
 */

import type * as Y from 'yjs';
import { VersionManager, type VersionListEntry, type VersionEntry, type DiffLine } from './version-manager.js';
import type { BlameSegment } from './blame-engine.js';
import type { IEditorBinding } from '../interfaces/editor-binding.js';
import type { BlameCoordinator } from './blame-coordinator.js';

export interface VersionCoordinatorConfig {
  relayUrl: string;
  documentId: string;
  userName: string;
  authToken?: string;
  autoSnapshot?: boolean;
  autoSnapshotUpdates?: number;
  autoSnapshotMinutes?: number;
  /** Whether version blame is available. */
  versionBlameEnabled?: boolean;
}

export interface VersionCoordinatorCallbacks {
  /** Called when the version list changes (new version created, list refreshed). */
  onVersionsChange: (versions: VersionListEntry[]) => void;
  /** Called when a version is selected for detail view. */
  onSelectedVersionChange: (version: VersionEntry | null) => void;
  /** Called when diff result changes. */
  onDiffResultChange: (diff: DiffLine[] | null) => void;
  /** Called when version view mode changes. */
  onViewingVersionChange: (viewing: boolean) => void;
}

export class VersionCoordinator {
  private _manager: VersionManager | null = null;
  private _binding: IEditorBinding | null = null;
  private _blameCoordinator: BlameCoordinator | null = null;
  private _config: VersionCoordinatorConfig | null = null;
  private _callbacks: VersionCoordinatorCallbacks | null = null;
  private _collabProvider: any = null;

  private _versions: VersionListEntry[] = [];
  private _selectedVersion: VersionEntry | null = null;
  private _diffResult: DiffLine[] | null = null;
  private _viewingVersion = false;
  private _panelOpen = false;
  private _readonly = false;

  get versions(): VersionListEntry[] { return this._versions; }
  get selectedVersion(): VersionEntry | null { return this._selectedVersion; }
  get diffResult(): DiffLine[] | null { return this._diffResult; }
  get viewingVersion(): boolean { return this._viewingVersion; }
  get panelOpen(): boolean { return this._panelOpen; }
  get available(): boolean { return this._manager !== null; }

  /**
   * Attach the coordinator to a live collaboration session.
   * Creates the VersionManager and loads the initial version list.
   */
  attach(
    binding: IEditorBinding,
    ydoc: Y.Doc,
    collabProvider: any,
    config: VersionCoordinatorConfig,
    callbacks: VersionCoordinatorCallbacks,
    blameCoordinator?: BlameCoordinator,
    readonly?: boolean,
  ): void {
    this.detach();

    this._binding = binding;
    this._config = config;
    this._callbacks = callbacks;
    this._blameCoordinator = blameCoordinator ?? null;
    this._collabProvider = collabProvider;
    this._readonly = readonly ?? false;

    this._manager = new VersionManager(ydoc, {
      relayUrl: config.relayUrl,
      documentId: config.documentId,
      userName: config.userName,
      authToken: config.authToken,
      autoSnapshotUpdates: config.autoSnapshot === false
        ? 0 : (config.autoSnapshotUpdates ?? 50),
      autoSnapshotMinutes: config.autoSnapshot === false
        ? 0 : (config.autoSnapshotMinutes ?? 5),
      onAutoSnapshot: (entry) => {
        this._versions = [entry, ...this._versions];
        this._callbacks?.onVersionsChange(this._versions);
      },
    });

    // Load initial version list
    this._manager.listVersions()
      .then(v => {
        this._versions = v;
        this._callbacks?.onVersionsChange(v);
      })
      .catch(() => {});
  }

  /** Tear down — exit version view, destroy manager, release references. */
  detach(): void {
    if (this._viewingVersion) {
      this._exitVersionView();
    }
    this._manager?.destroy();
    this._manager = null;
    this._binding = null;
    this._blameCoordinator = null;
    this._config = null;
    this._callbacks = null;
    this._collabProvider = null;
    this._versions = [];
    this._selectedVersion = null;
    this._diffResult = null;
    this._viewingVersion = false;
    this._panelOpen = false;
  }

  /** Handle version-created app messages from the relay. */
  handleAppMessage(data: any): void {
    if (data?.type === 'version-created' && data.version) {
      this._versions = [data.version, ...this._versions];
      this._callbacks?.onVersionsChange(this._versions);
    }
  }

  // --- Panel event handlers ---

  togglePanel(): void {
    this._panelOpen = !this._panelOpen;
    if (this._panelOpen) {
      this._manager?.listVersions()
        .then(v => {
          this._versions = v;
          this._callbacks?.onVersionsChange(v);
        })
        .catch(() => {});
    } else if (this._viewingVersion) {
      this._exitVersionView();
    }
  }

  closePanel(): void {
    this._panelOpen = false;
    if (this._viewingVersion) {
      this._exitVersionView();
    }
  }

  async save(): Promise<void> {
    const entry = await this._manager?.createVersion();
    if (entry) {
      this._versions = [entry, ...this._versions];
      this._callbacks?.onVersionsChange(this._versions);
    }
  }

  async select(versionId: string): Promise<void> {
    const version = await this._manager?.getVersion(versionId);
    if (version) {
      this._selectedVersion = version;
      this._callbacks?.onSelectedVersionChange(version);
    }
  }

  async view(versionId: string): Promise<void> {
    const version = await this._manager?.getVersion(versionId);
    if (!version || !this._binding) return;

    this._selectedVersion = version;
    this._callbacks?.onSelectedVersionChange(version);

    // Enter read-only version view mode
    this._viewingVersion = true;
    this._callbacks?.onViewingVersionChange(true);
    this._binding.setReadonly(true);
    this._binding.setContent(version.content ?? '');

    // Apply version blame if enabled and available
    if (this._config?.versionBlameEnabled !== false &&
        version.blame && version.blame.length > 0 &&
        this._blameCoordinator) {
      const segments: BlameSegment[] = version.blame.map(b => ({
        start: b.start,
        end: b.end,
        userName: b.user_name,
      }));
      this._blameCoordinator.enableVersionBlame(segments);
    }
  }

  async revert(versionId: string): Promise<void> {
    const version = await this._manager?.getVersion(versionId);
    if (!version) return;

    this._exitVersionView();

    await this._manager?.revertToVersion(version);
    this._versions = await this._manager?.listVersions() ?? [];
    this._callbacks?.onVersionsChange(this._versions);
  }

  async diff(fromId: string, toId: string): Promise<void> {
    if (!this._manager) return;
    const fromVersion = await this._manager.getVersion(fromId);
    const toVersion = await this._manager.getVersion(toId);
    if (!fromVersion || !toVersion) return;

    this._diffResult = this._manager.diffVersions(fromVersion, toVersion);
    this._callbacks?.onDiffResultChange(this._diffResult);
  }

  clearDiff(): void {
    this._diffResult = null;
    this._callbacks?.onDiffResultChange(null);
  }

  // --- Internal ---

  private _exitVersionView(): void {
    if (!this._viewingVersion) return;
    this._viewingVersion = false;
    this._callbacks?.onViewingVersionChange(false);

    if (this._binding) {
      this._binding.setReadonly(this._readonly);
      this._blameCoordinator?.disableVersionBlame();

      // Restore live content from the editor's Y.Text.
      if (this._collabProvider) {
        this._binding.setContent(this._collabProvider.editorText.toString());
      }
    }
    this._selectedVersion = null;
    this._callbacks?.onSelectedVersionChange(null);
  }
}
