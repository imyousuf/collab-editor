/**
 * BlameCoordinator — owns the blame feature lifecycle.
 *
 * Manages: BlameEngine creation, Y.Doc update observer (debounced at 300ms),
 * blame toggle (enable/disable), and re-pushing segments on mode switch.
 *
 * The multi-editor orchestrator calls attach() when collaboration connects
 * and detach() on teardown. Event handlers are forwarded from toolbar events.
 */

import type * as Y from 'yjs';
import { BlameEngine, type BlameSegment } from './blame-engine.js';
import type { IBlameCapability } from '../interfaces/blame.js';
import { isBlameCapable } from '../interfaces/blame.js';
import type { IEditorBinding } from '../interfaces/editor-binding.js';

export interface BlameCoordinatorConfig {
  /** Whether live blame is available to end users. Default: true */
  liveBlameEnabled?: boolean;
  /** Whether version blame is available. Default: true */
  versionBlameEnabled?: boolean;
}

export class BlameCoordinator {
  private _engine: BlameEngine | null = null;
  private _binding: (IEditorBinding & IBlameCapability) | null = null;
  private _ydoc: Y.Doc | null = null;
  private _config: BlameCoordinatorConfig = {};
  private _active = false;
  private _updateTimer: ReturnType<typeof setTimeout> | null = null;
  private _updateUnsub: (() => void) | null = null;
  private _onActiveChange: ((active: boolean) => void) | null = null;

  /** Whether blame view is currently active. */
  get active(): boolean {
    return this._active;
  }

  /**
   * Register a callback for when blame active state changes.
   * Used by multi-editor to update its @state property.
   */
  onActiveChange(callback: (active: boolean) => void): void {
    this._onActiveChange = callback;
  }

  /**
   * Attach the coordinator to a live collaboration session.
   * Creates the BlameEngine and wires it to the binding.
   */
  attach(
    binding: IEditorBinding,
    ydoc: Y.Doc,
    awareness: any,
    documentId: string,
    config?: BlameCoordinatorConfig,
  ): void {
    this.detach();

    this._config = config ?? {};
    this._ydoc = ydoc;

    if (!isBlameCapable(binding)) {
      return;
    }
    this._binding = binding;

    this._engine = new BlameEngine(ydoc, documentId);
    this._engine.setAwareness(awareness);
  }

  /** Tear down — stop blame, remove observers, release references. */
  detach(): void {
    this._stopBlame();
    this._engine?.stopLiveBlame();
    this._engine = null;
    this._binding = null;
    this._ydoc = null;
    this._active = false;
    this._config = {};
  }

  /** Whether the blame toggle should be available in the toolbar. */
  get available(): boolean {
    return this._config.liveBlameEnabled !== false && this._engine !== null;
  }

  /**
   * Handle blame toggle from toolbar.
   * Starts/stops live blame and wires/unwires the debounced update observer.
   */
  toggle(active: boolean): void {
    if (this._config.liveBlameEnabled === false) return;

    this._active = active;
    this._onActiveChange?.(active);

    if (active) {
      this._startBlame();
    } else {
      this._stopBlame();
    }
  }

  /**
   * Re-push blame segments after a mode switch.
   * Called by multi-editor after binding.switchMode() completes, so the
   * newly-visible editor shows highlights immediately.
   */
  onModeSwitch(): void {
    if (!this._active || !this._engine || !this._binding) return;
    const segments = this._engine.getLiveBlame();
    this._binding.updateBlame(segments, this._buildContext());
  }

  /**
   * Enable version blame decorations (read-only mode).
   * Used when viewing a historical version with blame data.
   */
  enableVersionBlame(segments: BlameSegment[]): void {
    if (this._config.versionBlameEnabled === false) return;
    this._binding?.enableBlame(segments);
  }

  /** Disable version blame decorations. */
  disableVersionBlame(): void {
    this._binding?.disableBlame();
  }

  // --- Internal ---

  private _startBlame(): void {
    if (!this._engine || !this._binding) return;

    this._engine.startLiveBlame();
    const segments = this._engine.getLiveBlame();
    this._binding.enableBlame(segments, this._buildContext());

    // Debounced Y.Doc update observer — recomputes blame 300ms after
    // the last update. Avoids dispatching CodeMirror effects on every
    // keystroke, which disrupts typing.
    this._updateUnsub?.();
    const observer = () => {
      if (this._updateTimer) clearTimeout(this._updateTimer);
      this._updateTimer = setTimeout(() => {
        this._updateTimer = null;
        if (this._active && this._engine && this._binding) {
          const updated = this._engine.getLiveBlame();
          this._binding.updateBlame(updated, this._buildContext());
        }
      }, 300);
    };
    this._ydoc?.on('update', observer);
    this._updateUnsub = () => {
      this._ydoc?.off('update', observer);
      if (this._updateTimer) {
        clearTimeout(this._updateTimer);
        this._updateTimer = null;
      }
    };
  }

  private _stopBlame(): void {
    this._updateUnsub?.();
    this._updateUnsub = null;
    this._engine?.stopLiveBlame();
    this._binding?.disableBlame();
  }

  /** Build the extra context the WYSIWYG plugin needs for posMap + overrides. */
  private _buildContext(): import('../interfaces/blame.js').BlameContext {
    if (!this._engine) return {};
    return {
      ytext: this._engine.getYText(),
      clientToUser: this._engine.getClientToUserMap(),
    };
  }
}
