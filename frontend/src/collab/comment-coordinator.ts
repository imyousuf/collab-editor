/**
 * CommentCoordinator — owns the comment feature lifecycle.
 *
 * Mirrors BlameCoordinator / VersionCoordinator. Wires a CommentEngine
 * (thread state + SPI persistence) and — lazily on first enable — a
 * SuggestEngine (the local buffer for Suggest Mode). Pushes decoration
 * updates to the binding via ICommentCapability.
 */

import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness.js';
import type { CommentEngine } from './comment-engine.js';
import type {
  CommentThread,
  ICommentCapability,
  SuggestionOverlayRegion,
} from '../interfaces/comments.js';
import { isCommentCapable } from '../interfaces/comments.js';
import type { PendingSuggestOverlay } from '../interfaces/suggest.js';
import type { IEditorBinding } from '../interfaces/editor-binding.js';

export interface CommentCoordinatorConfig {
  /** Whether comments UI is available at all. Default: true. */
  commentsEnabled?: boolean;
  /** Whether Suggest Mode UI is available. Forced false when commentsEnabled=false. */
  suggestEnabled?: boolean;
  /**
   * Deterministic color-per-user function used to tint suggestion overlays.
   * Typically supplied by the embedding app — falls back to a fixed palette.
   */
  userColor?: (userId: string) => string;
}

const DEFAULT_PALETTE = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
  '#9467bd', '#8c564b', '#e377c2', '#7f7f7f',
];

function paletteColor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
  return DEFAULT_PALETTE[Math.abs(h) % DEFAULT_PALETTE.length];
}

export class CommentCoordinator {
  private _engine: CommentEngine | null = null;
  private _binding: (IEditorBinding & ICommentCapability) | null = null;
  /**
   * When set, _pushDecorations sends an empty thread+overlay payload to
   * the binding. Used during reviewer-side suggestion preview to hide
   * carets and anchor highlights — their positions would otherwise
   * drift, since the PM doc shows the previewed editorText while the
   * comment plugin's position map is built from syncText.
   */
  private _decorationsMuted = false;
  private _ydoc: Y.Doc | null = null;
  private _awareness: Awareness | null = null;
  private _config: CommentCoordinatorConfig = {};
  private _unsubscribeThreads: (() => void) | null = null;
  private _unsubscribeYTextUpdate: (() => void) | null = null;
  private _activeThreadId: string | null = null;
  private _commentsActive = false;
  private _suggestActive = false;
  private _pendingOverlay: PendingSuggestOverlay | null = null;
  private _onThreadsChange: ((threads: CommentThread[]) => void) | null = null;
  private _onActiveThreadChange: ((threadId: string | null) => void) | null = null;

  get commentsActive(): boolean {
    return this._commentsActive;
  }

  get suggestActive(): boolean {
    return this._suggestActive;
  }

  get engine(): CommentEngine | null {
    return this._engine;
  }

  get effectiveConfig(): CommentCoordinatorConfig {
    return this._config;
  }

  /** Listener invoked whenever the Y.Map("comments") state changes. */
  onThreadsChange(cb: (threads: CommentThread[]) => void): void {
    this._onThreadsChange = cb;
  }

  onActiveThreadChange(cb: (threadId: string | null) => void): void {
    this._onActiveThreadChange = cb;
  }

  /**
   * Attach the coordinator. Comment decorations activate immediately; the
   * Suggest Mode buffer is created lazily on the first toggleSuggest(true).
   */
  attach(
    engine: CommentEngine,
    binding: IEditorBinding,
    ydoc: Y.Doc,
    awareness: Awareness,
    config: CommentCoordinatorConfig,
  ): void {
    this.detach();
    this._engine = engine;
    this._ydoc = ydoc;
    this._awareness = awareness;
    this._config = config;
    if (isCommentCapable(binding)) {
      this._binding = binding;
    }

    this._unsubscribeThreads = engine.onThreadsChange((threads) => {
      this._onThreadsChange?.(threads);
      this._pushDecorations();
    });

    // Also re-push overlays when the base Y.Text changes so suggestion
    // anchors follow the live content.
    if (this._ydoc) {
      const text = this._ydoc.getText('source');
      const observer = () => this._pushDecorations();
      text.observe(observer);
      this._unsubscribeYTextUpdate = () => text.unobserve(observer);
    }

    if (this.commentsAvailable) {
      this._commentsActive = true;
      this._binding?.enableComments();
      // Initial push.
      this._pushDecorations();
    }
  }

  detach(): void {
    this._unsubscribeThreads?.();
    this._unsubscribeThreads = null;
    this._unsubscribeYTextUpdate?.();
    this._unsubscribeYTextUpdate = null;
    if (this._commentsActive) this._binding?.disableComments();
    this._binding = null;
    this._engine = null;
    this._ydoc = null;
    this._awareness = null;
    this._config = {};
    this._commentsActive = false;
    this._suggestActive = false;
    this._activeThreadId = null;
    this._pendingOverlay = null;
  }

  /**
   * Re-push decorations after a mode switch (the newly-visible editor
   * has empty decoration state).
   */
  onModeSwitch(newBinding: IEditorBinding): void {
    if (isCommentCapable(newBinding)) {
      this._binding = newBinding;
    } else {
      this._binding = null;
    }
    if (this._commentsActive) {
      this._binding?.enableComments();
      this._pushDecorations();
    }
  }

  setActiveThread(threadId: string | null): void {
    if (this._activeThreadId === threadId) return;
    this._activeThreadId = threadId;
    this._onActiveThreadChange?.(threadId);
    this._pushDecorations();
  }

  /**
   * Push the author's local Suggest-Mode overlay to the binding so the
   * pending diff is rendered while the user is editing in Suggest Mode.
   * Pass null to clear.
   */
  setPendingOverlay(overlay: PendingSuggestOverlay | null): void {
    this._pendingOverlay = overlay;
    this._pushDecorations();
  }

  // --- Availability ---

  get commentsAvailable(): boolean {
    return this._config.commentsEnabled !== false && this._engine !== null;
  }

  get suggestAvailable(): boolean {
    return (
      this.commentsAvailable &&
      this._config.suggestEnabled !== false &&
      this._engine?.capabilities()?.suggestions === true
    );
  }

  // --- Internal ---

  private _pushDecorations(): void {
    if (!this._engine || !this._binding || !this._commentsActive) return;
    const ytext = this._ydoc?.getText('source');
    if (this._decorationsMuted) {
      this._binding.updateComments([], [], null, null, ytext);
      return;
    }
    const threads = this._engine.getThreads();
    const overlays = this._engine.getSuggestionOverlays(
      this._config.userColor ?? paletteColor,
    );
    // Pass the Y.Text handle so the WYSIWYG plugin's posMap can map
    // against the true Markdown/HTML source. Without this the plugin
    // falls back to serializing the PM doc, which strips the syntax
    // chars and makes stored Y.Text offsets land on wrong PM positions.
    this._binding.updateComments(
      threads,
      overlays,
      this._activeThreadId,
      this._pendingOverlay,
      ytext,
    );
  }

  /**
   * Mute (or un-mute) thread/overlay decorations. While muted, the
   * binding sees no caret or anchor highlights — used by the
   * reviewer-side preview flow so position drift between the rendered
   * PM doc (editorText with preview applied) and the comment plugin's
   * position map (built from syncText) doesn't manifest as carets
   * jumping around.
   */
  setDecorationsMuted(muted: boolean): void {
    if (this._decorationsMuted === muted) return;
    this._decorationsMuted = muted;
    this._pushDecorations();
  }

  // Suggest Mode toggling is owned here but the SuggestEngine itself is
  // wired in Phase 8. Until then these two methods are no-ops that just
  // track the flag so the toolbar renders correctly.
  setSuggestActive(active: boolean): void {
    if (!this.suggestAvailable) {
      this._suggestActive = false;
      return;
    }
    this._suggestActive = active;
  }

  /** Factor out the default palette color function for tests. */
  static defaultColor(userId: string): string {
    return paletteColor(userId);
  }

  /**
   * Expose the current suggestion overlays (for tests and the orchestrator
   * that routes them to the suggest-status UI).
   */
  getSuggestionOverlays(): SuggestionOverlayRegion[] {
    if (!this._engine) return [];
    return this._engine.getSuggestionOverlays(
      this._config.userColor ?? paletteColor,
    );
  }
}
