/**
 * <multi-editor> web component — v2 (interface-driven architecture)
 *
 * Thin orchestrator that delegates to IEditorBinding instances
 * created by the EditorBindingFactory.
 *
 * Domain-specific concerns are managed by coordinators:
 * - BlameCoordinator — blame view lifecycle, debounced updates, mode switch
 * - VersionCoordinator — version history, version view mode, panel events
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type {
  EditorMode,
  IEditorBinding,
  CollaborationContext,
  IEditorEventEmitter,
  ContentChangeDetail,
  ModeChangeDetail,
  SaveDetail,
  CollabStatusDetail,
  RemoteChangeDetail,
  BeforeModeChangeDetail,
  CollabStatus,
  CollaborationConfig,
  ToolbarConfig,
  StatusBarConfig,
  FormattingState,
  FormattingCommand,
  DocumentEntry,
  CollaboratorInfo,
} from './interfaces/index.js';
import { isFormattingCapable, emptyFormattingState } from './interfaces/index.js';
import {
  EditorChangeEvent,
  ModeChangeEvent,
  EditorSaveEvent,
  CollabStatusEvent,
} from './interfaces/events.js';
import { EditorBindingFactory, registerDefaults } from './registry.js';
import { CollaborationProvider } from './collab/collab-provider.js';
import { BlameCoordinator } from './collab/blame-coordinator.js';
import { VersionCoordinator } from './collab/version-coordinator.js';
import * as Y from 'yjs';
import { pmRangeToYText } from './collab/pm-position-map.js';
import { CommentCoordinator } from './collab/comment-coordinator.js';
import { CommentEngine } from './collab/comment-engine.js';
import { SuggestEngine } from './collab/suggest-engine.js';
import type { VersionListEntry, VersionEntry, DiffLine } from './collab/version-manager.js';
import type {
  CommentThread,
  CommentsCapabilities,
  MentionCandidate,
} from './interfaces/comments.js';

// Register internal toolbar components
import './toolbar/editor-toolbar.js';
import './toolbar/editor-status-bar.js';
import './toolbar/version-panel.js';
import './toolbar/comment-panel.js';
import './toolbar/suggest-status.js';

@customElement('multi-editor')
export class MultiEditor extends LitElement implements IEditorEventEmitter {
  @property({ type: String, reflect: true }) mode: EditorMode = 'source';
  @property({ type: String }) mimeType: string = 'text/plain';
  @property({ type: String }) placeholder: string = 'Start writing...';
  @property({ type: String, reflect: true }) theme: 'light' | 'dark' = 'light';
  @property({ type: Boolean }) readonly: boolean = false;
  @property({ attribute: false }) collaboration: CollaborationConfig | null = null;
  @property({ attribute: false }) initialContent: string = '';
  @property({ attribute: false }) toolbarConfig: ToolbarConfig | null = null;
  @property({ attribute: false }) statusBarConfig: StatusBarConfig | null = null;
  @property({ attribute: false }) documents: DocumentEntry[] = [];
  @property({ attribute: false }) currentDocumentId: string = '';

  @state() private _collabStatus: CollabStatus = 'disconnected';
  @state() private _formattingState: FormattingState = emptyFormattingState();
  @state() private _availableCommands: FormattingCommand[] = [];
  @state() private _collaborators: CollaboratorInfo[] = [];
  @state() private _blameActive = false;
  @state() private _versionPanelOpen = false;
  @state() private _versions: VersionListEntry[] = [];
  @state() private _selectedVersion: VersionEntry | null = null;
  @state() private _diffResult: DiffLine[] | null = null;
  @state() private _viewingVersion = false;
  @state() private _commentsAvailable = false;
  @state() private _suggestAvailable = false;
  @state() private _suggestActive = false;
  @state() private _suggestPendingCount = 0;
  @state() private _activeCommentThread: CommentThread | null = null;
  @state() private _commentPanelPos: { x: number; y: number } | null = null;
  @state() private _commentCapabilities: CommentsCapabilities | null = null;

  private _factory: EditorBindingFactory;
  private _binding: IEditorBinding | null = null;
  private _collabProvider: CollaborationProvider | null = null;
  private _commentThreadActivatedHandler: EventListener | null = null;
  private _readyResolve: (() => void) | null = null;
  private _readyPromise: Promise<void>;
  private _lastCollabConfig: CollaborationConfig | null = null;
  private _lastMimeType: string | null = null;
  private _changeDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Serialized init chain — ensures only one _performInit runs at a time */
  private _initChain: Promise<void> = Promise.resolve();

  // Event callback subscriptions
  private _contentChangeCallbacks = new Set<(detail: ContentChangeDetail) => void>();
  private _modeChangeCallbacks = new Set<(detail: ModeChangeDetail) => void>();
  private _saveCallbacks = new Set<(detail: SaveDetail) => void>();
  private _collabStatusCallbacks = new Set<(detail: CollabStatusDetail) => void>();
  private _remoteChangeCallbacks = new Set<(detail: RemoteChangeDetail) => void>();
  private _beforeModeChangeCallbacks = new Set<(detail: BeforeModeChangeDetail) => boolean>();
  private _formattingUnsub: (() => void) | null = null;
  private _awarenessHandler: (() => void) | null = null;

  // Domain coordinators
  private _blameCoordinator = new BlameCoordinator();
  private _versionCoordinator = new VersionCoordinator();
  private _commentCoordinator = new CommentCoordinator();
  private _commentEngine: CommentEngine | null = null;
  private _suggestEngine: SuggestEngine | null = null;

  constructor() {
    super();
    this._factory = new EditorBindingFactory();
    registerDefaults(this._factory);
    this._readyPromise = new Promise(resolve => { this._readyResolve = resolve; });
  }

  /** Public Promise that resolves when the editor is fully initialized and content can be set */
  get whenReady(): Promise<void> {
    return this._readyPromise;
  }

  /** Supported modes for the current MIME type */
  get supportedModes(): EditorMode[] {
    return this._binding?.supportedModes ? [...this._binding.supportedModes] : this._factory.getSupportedModes(this.mimeType);
  }

  static styles = css`
    /* ── Root tokens ── */
    :host {
      display: flex;
      flex-direction: column;
      position: relative;
      overflow: hidden;

      --me-font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      --me-font-size: 14px;
      --me-line-height: 1.6;
      --me-color: #1a1a1a;
      --me-bg: #ffffff;
      --me-border-color: #e0e0e0;
      --me-border-radius: 4px;
      --me-focus-ring-color: rgba(59, 130, 246, 0.5);
      --me-selection-bg: rgba(59, 130, 246, 0.2);
      --me-min-height: 200px;
      --me-padding: 12px;

      /* Source / CodeMirror tokens */
      --me-source-bg: var(--me-bg);
      --me-source-color: var(--me-color);
      --me-source-font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      --me-source-font-size: 13px;
      --me-source-line-height: 1.5;
      --me-source-gutter-bg: #f5f5f5;
      --me-source-gutter-color: #999;
      --me-source-gutter-border: var(--me-border-color);
      --me-source-cursor-color: #000;
      --me-source-selection-bg: var(--me-selection-bg);
      --me-source-active-line-bg: rgba(0, 0, 0, 0.04);
      --me-source-matching-bracket-bg: rgba(0, 0, 0, 0.1);

      /* WYSIWYG / ProseMirror tokens */
      --me-wysiwyg-bg: var(--me-bg);
      --me-wysiwyg-color: var(--me-color);
      --me-wysiwyg-font-family: var(--me-font-family);
      --me-wysiwyg-font-size: var(--me-font-size);
      --me-wysiwyg-padding: var(--me-padding);
      --me-wysiwyg-placeholder-color: #adb5bd;
      --me-wysiwyg-link-color: #2563eb;
      --me-wysiwyg-heading-color: var(--me-color);
      --me-wysiwyg-heading-font-weight: 600;
      --me-wysiwyg-blockquote-border: var(--me-border-color);
      --me-wysiwyg-blockquote-color: #666;
      --me-wysiwyg-hr-color: var(--me-border-color);

      /* Code block tokens (inside WYSIWYG) */
      --me-code-bg: #1e1e1e;
      --me-code-color: #d4d4d4;
      --me-code-padding: 12px;
      --me-code-border-radius: var(--me-border-radius);
      --me-code-font-family: var(--me-source-font-family);
      --me-code-font-size: 0.9em;
      --me-code-inline-bg: #f0f0f0;
      --me-code-inline-color: var(--me-color);
      --me-code-inline-padding: 2px 4px;
      --me-code-inline-border-radius: 2px;

      /* Preview tokens */
      --me-preview-bg: #ffffff;
      --me-preview-min-height: 300px;
      --me-preview-border: none;

      /* Toolbar tokens */
      --me-toolbar-bg: #f8f9fa;
      --me-toolbar-border: var(--me-border-color);
      --me-toolbar-button-bg: transparent;
      --me-toolbar-button-hover-bg: #e9ecef;
      --me-toolbar-button-active-bg: #333;
      --me-toolbar-button-active-color: #fff;
      --me-toolbar-button-radius: var(--me-border-radius);
      --me-toolbar-gap: 2px;
      --me-toolbar-padding: 6px 8px;
      --me-toolbar-separator-color: var(--me-border-color);

      /* Status bar tokens */
      --me-status-bg: #f8f9fa;
      --me-status-color: #666;
      --me-status-font-size: 12px;
      --me-status-connected-color: #22c55e;
      --me-status-connecting-color: #eab308;
      --me-status-disconnected-color: #ef4444;

      /* Icon tokens */
      --me-icon-color: var(--me-color);
      --me-icon-size: 18px;

      /* Scrollbar tokens */
      --me-scrollbar-width: 8px;
      --me-scrollbar-track: transparent;
      --me-scrollbar-thumb: rgba(0, 0, 0, 0.2);
      --me-scrollbar-thumb-hover: rgba(0, 0, 0, 0.35);
    }

    /* ── Dark theme overrides ── */
    :host([theme="dark"]) {
      --me-bg: #1e1e1e;
      --me-color: #e0e0e0;
      --me-border-color: #333;
      --me-selection-bg: rgba(59, 130, 246, 0.35);
      --me-focus-ring-color: rgba(96, 165, 250, 0.5);

      --me-source-gutter-bg: #252525;
      --me-source-gutter-color: #666;
      --me-source-cursor-color: #fff;
      --me-source-active-line-bg: rgba(255, 255, 255, 0.04);
      --me-source-matching-bracket-bg: rgba(255, 255, 255, 0.1);

      --me-wysiwyg-placeholder-color: #555;
      --me-wysiwyg-link-color: #60a5fa;
      --me-wysiwyg-blockquote-color: #aaa;

      --me-code-inline-bg: #2d2d2d;
      --me-code-inline-color: #e0e0e0;

      --me-preview-bg: #1e1e1e;

      --me-toolbar-bg: #2d2d2d;
      --me-toolbar-button-hover-bg: #3d3d3d;
      --me-toolbar-button-active-bg: #e0e0e0;
      --me-toolbar-button-active-color: #1a1a1a;

      --me-status-bg: rgba(45, 45, 45, 0.85);
      --me-status-color: #aaa;

      --me-scrollbar-thumb: rgba(255, 255, 255, 0.2);
      --me-scrollbar-thumb-hover: rgba(255, 255, 255, 0.35);

      /* Version panel dark mode */
      --me-version-badge-manual-bg: #1e3a5f;
      --me-version-badge-manual-color: #93c5fd;
      --me-version-badge-auto-bg: #14532d;
      --me-version-badge-auto-color: #86efac;
      --me-version-btn-primary-bg: #3b82f6;
      --me-version-btn-primary-color: #fff;
      --me-version-btn-primary-hover-bg: #2563eb;
      --me-diff-added-bg: rgba(34, 197, 94, 0.15);
      --me-diff-added-color: #86efac;
      --me-diff-removed-bg: rgba(239, 68, 68, 0.15);
      --me-diff-removed-color: #fca5a5;
    }

    /* ── Editor wrapper (positions the status bar overlay) ── */
    .editor-wrapper {
      position: relative;
      flex: 1;
      width: 100%;
      min-height: 0; /* allow flex child to shrink below content size */
      overflow: hidden;
    }

    /* ── Editor area ── */
    .editor-root {
      width: 100%;
      height: 100%;
      overflow-y: auto;
      background: var(--me-bg);
      color: var(--me-color);
      font-family: var(--me-font-family);
      font-size: var(--me-font-size);
      line-height: var(--me-line-height);
    }

    /* ── ProseMirror / WYSIWYG ── */
    .ProseMirror {
      outline: none;
      padding: var(--me-wysiwyg-padding);
      padding-bottom: 32px;
      font-family: var(--me-wysiwyg-font-family);
      font-size: var(--me-wysiwyg-font-size);
      color: var(--me-wysiwyg-color);
      background: var(--me-wysiwyg-bg);
    }
    .ProseMirror p.is-editor-empty:first-child::before {
      content: attr(data-placeholder);
      float: left;
      color: var(--me-wysiwyg-placeholder-color);
      pointer-events: none;
      height: 0;
    }
    .ProseMirror a { color: var(--me-wysiwyg-link-color); }
    .ProseMirror h1, .ProseMirror h2, .ProseMirror h3,
    .ProseMirror h4, .ProseMirror h5, .ProseMirror h6 {
      color: var(--me-wysiwyg-heading-color);
      font-weight: var(--me-wysiwyg-heading-font-weight);
    }
    .ProseMirror blockquote {
      border-left: 3px solid var(--me-wysiwyg-blockquote-border);
      color: var(--me-wysiwyg-blockquote-color);
      padding-left: 1em;
      margin-left: 0;
    }
    .ProseMirror hr {
      border: none;
      border-top: 1px solid var(--me-wysiwyg-hr-color);
    }
    .ProseMirror pre {
      background: var(--me-code-bg);
      color: var(--me-code-color);
      padding: var(--me-code-padding);
      border-radius: var(--me-code-border-radius);
      overflow-x: auto;
      font-family: var(--me-code-font-family);
    }
    .ProseMirror code {
      background: var(--me-code-inline-bg);
      color: var(--me-code-inline-color);
      padding: var(--me-code-inline-padding);
      border-radius: var(--me-code-inline-border-radius);
      font-size: var(--me-code-font-size);
      font-family: var(--me-code-font-family);
    }
    .ProseMirror pre code {
      background: none;
      padding: 0;
      color: inherit;
    }

    /* ── CodeMirror ── */
    .cm-editor { padding-bottom: 32px; }

    /* ── Preview iframe ── */
    .me-preview-iframe {
      width: 100%;
      min-height: var(--me-preview-min-height);
      border: var(--me-preview-border);
      background: var(--me-preview-bg);
    }

    /* ── Scrollbar ── */
    .editor-root ::-webkit-scrollbar { width: var(--me-scrollbar-width); }
    .editor-root ::-webkit-scrollbar-track { background: var(--me-scrollbar-track); }
    .editor-root ::-webkit-scrollbar-thumb {
      background: var(--me-scrollbar-thumb);
      border-radius: 4px;
    }
    .editor-root ::-webkit-scrollbar-thumb:hover { background: var(--me-scrollbar-thumb-hover); }
  `;

  render() {
    const toolbarVisible = this.toolbarConfig?.visible !== false;
    const statusBarVisible = this.statusBarConfig?.visible !== false;
    const toolbarOnTop = this.toolbarConfig?.position !== 'bottom';

    return html`
      ${toolbarOnTop && toolbarVisible ? this._renderToolbarSlot() : nothing}
      <div class="editor-wrapper" style="position: relative;">
        <div id="editor-root" class="editor-root" part="editor-area"></div>
        ${statusBarVisible ? this._renderStatusBarSlot() : nothing}
        ${this._suggestActive ? this._renderSuggestStatus() : nothing}
        ${this._activeCommentThread ? this._renderCommentPanel() : nothing}
      </div>
      ${!toolbarOnTop && toolbarVisible ? this._renderToolbarSlot() : nothing}
    `;
  }

  private _renderSuggestStatus() {
    return html`
      <div style="position: absolute; top: 8px; right: 8px; z-index: 900;">
        <suggest-status
          .active=${true}
          .pendingChanges=${this._suggestPendingCount}
          .userColor=${this.collaboration?.user?.color ?? '#1f77b4'}
          .userName=${this.collaboration?.user?.name ?? ''}
          @suggest-submit=${this._handleSuggestSubmit}
          @suggest-discard=${this._handleSuggestDiscard}
          @suggest-toggle-off=${() => this._handleSuggestToggle({ detail: { active: false } } as any)}
        ></suggest-status>
      </div>
    `;
  }

  private _renderCommentPanel() {
    const pos = this._commentPanelPos ?? { x: 16, y: 48 };
    return html`
      <div style="position: absolute; left: ${pos.x}px; top: ${pos.y}px; z-index: 1000;">
        <comment-panel
          .open=${true}
          .thread=${this._activeCommentThread}
          .capabilities=${this._commentCapabilities}
          .currentUserId=${this.collaboration?.user?.name ?? ''}
          @comment-panel-close=${this._handleCommentPanelClose}
          @comment-reply=${this._handleCommentReply}
          @comment-thread-resolve=${this._handleCommentThreadResolve}
          @comment-thread-reopen=${this._handleCommentThreadReopen}
          @comment-thread-delete=${this._handleCommentThreadDelete}
          @comment-suggestion-accept=${this._handleCommentSuggestionAccept}
          @comment-suggestion-reject=${this._handleCommentSuggestionReject}
          @comment-mention-search=${this._handleCommentMentionSearch}
        ></comment-panel>
      </div>
    `;
  }

  private _renderToolbarSlot() {
    return html`
      <slot name="toolbar">
        <editor-toolbar
          part="toolbar"
          .mode=${this.mode}
          .supportedModes=${this.supportedModes}
          .formattingState=${this._formattingState}
          .availableCommands=${this._availableCommands}
          .config=${this.toolbarConfig}
          .documents=${this.documents}
          .currentDocumentId=${this.currentDocumentId}
          .readonly=${this.readonly}
          .blameActive=${this._blameActive}
          .blameAvailable=${this._blameCoordinator.available}
          .commentsAvailable=${this._commentsAvailable}
          .suggestAvailable=${this._suggestAvailable}
          .suggestActive=${this._suggestActive}
          @toolbar-command=${this._handleToolbarCommand}
          @toolbar-mode-switch=${this._handleToolbarModeSwitch}
          @toolbar-document-switch=${this._handleToolbarDocumentSwitch}
          @toolbar-blame-toggle=${this._handleBlameToggle}
          @toolbar-comment-add=${this._handleCommentAdd}
          @toolbar-suggest-toggle=${this._handleSuggestToggle}
        ></editor-toolbar>
      </slot>
    `;
  }

  private _renderStatusBarSlot() {
    return html`
      <slot name="status-bar">
        <editor-status-bar
          part="status-bar"
          .status=${this._collabStatus}
          .userName=${this.collaboration?.user?.name ?? ''}
          .userImage=${this.collaboration?.user?.image ?? ''}
          .userColor=${this.collaboration?.user?.color ?? ''}
          .documentName=${this._currentDocumentName}
          .collaborators=${this._collaborators}
          .config=${this.statusBarConfig}
          .versionCount=${this._versions.length}
          .versionPanelOpen=${this._versionPanelOpen}
          .versionsAvailable=${this._versionCoordinator.available}
          @version-toggle=${this._handleVersionToggle}
          @version-quick-save=${this._handleVersionSave}
        ></editor-status-bar>
        <version-panel
          ?open=${this._versionPanelOpen}
          .versions=${this._versions}
          .selectedVersion=${this._selectedVersion}
          .diffResult=${this._diffResult}
          @version-save=${this._handleVersionSave}
          @version-select=${this._handleVersionSelect}
          @version-view=${this._handleVersionView}
          @version-revert=${this._handleVersionRevert}
          @version-diff=${this._handleVersionDiff}
          @version-diff-clear=${this._handleVersionDiffClear}
          @version-close=${this._handleVersionClose}
        ></version-panel>
      </slot>
    `;
  }

  async firstUpdated() {
    this._setupKeyboardShortcuts();
  }

  updated(changed: Map<string, unknown>) {
    // Trigger init only when collaboration or mimeType actually changed.
    // Uses _lastCollabConfig/_lastMimeType (set at the START of _performInit)
    // to correctly deduplicate even during async init gaps.
    const collabChanged = changed.has('collaboration') && this.collaboration !== this._lastCollabConfig;
    const mimeChanged = changed.has('mimeType') && this.mimeType !== this._lastMimeType;

    if ((collabChanged || mimeChanged) && this.collaboration?.enabled) {
      this._requestInit();
    }

    if (changed.has('readonly') && this._binding) {
      this._binding.setReadonly(this.readonly);
    }
  }

  /**
   * Enqueue an initialization. Serialized via promise chain —
   * only one _performInit runs at a time, eliminating race conditions.
   */
  private _requestInit(): void {
    this._initChain = this._initChain
      .then(() => this._performInit())
      .catch(e => console.error('Editor initialization failed:', e));
  }

  /**
   * Single unified init/reinit method. Snapshots config at the start
   * to avoid reading stale Lit properties after async gaps.
   */
  private async _performInit(): Promise<void> {
    // Snapshot current config — all reads use this, not live Lit properties
    const config = {
      collaboration: this.collaboration,
      mimeType: this.mimeType,
      initialContent: this.initialContent,
    };

    // Skip if config matches what's already initialized or being initialized.
    // _lastCollabConfig/_lastMimeType are set at the START of each run,
    // so this catches duplicates even when _initialized is still false.
    if (config.collaboration === this._lastCollabConfig &&
        config.mimeType === this._lastMimeType) {
      return;
    }

    // Track this config to detect future changes
    this._lastCollabConfig = config.collaboration;
    this._lastMimeType = config.mimeType;

    // Tear down previous state
    this._blameCoordinator.detach();
    this._blameActive = false;
    this._versionCoordinator.detach();
    this._versionPanelOpen = false;
    this._viewingVersion = false;
    this._versions = [];
    this._selectedVersion = null;
    this._diffResult = null;
    this._commentCoordinator.detach();
    this._commentEngine?.destroy();
    this._commentEngine = null;
    this._suggestEngine?.disable();
    this._suggestEngine = null;
    this._activeCommentThread = null;
    this._commentPanelPos = null;
    this._commentsAvailable = false;
    this._suggestAvailable = false;
    this._suggestActive = false;
    this._suggestPendingCount = 0;
    this._binding?.destroy();
    this._binding = null;
    if (this._collabProvider) {
      this._collabProvider.destroy();
      this._collabProvider = null;
    }
    const root = this.renderRoot.querySelector('#editor-root') as HTMLElement;
    if (root) root.innerHTML = '';

    // Set up collaboration — await connect so y-websocket sync completes
    // before we decide whether to seed content. This prevents duplication
    // when the relay or other peers already have document state.
    if (config.collaboration?.enabled) {
      this._collabProvider = new CollaborationProvider();
      this._collabProvider.onStatusChange((status) => {
        this._collabStatus = status;
        this.dispatchEvent(new CollabStatusEvent({ status }));
        this._collabStatusCallbacks.forEach(cb => cb({ status }));
      });
      try {
        await this._collabProvider.connect(config.collaboration);
      } catch {
        // Connection may fail but y-websocket auto-reconnects
      }

      // Track collaborator presence via awareness
      this._wireAwareness();
    }

    // Check staleness — if properties changed during setup, another init is queued
    if (config.collaboration !== this.collaboration || config.mimeType !== this.mimeType) {
      return;
    }

    // Determine mode
    const supportedModes = this._factory.getSupportedModes(config.mimeType);
    let mode = this.mode;
    if (!supportedModes.includes(mode)) {
      mode = supportedModes[0] ?? 'source';
      this.mode = mode;
    }

    // Mount binding (async — Tiptap's whenReady)
    await this._mountBinding(mode);

    // Brief delay to allow stored Y.js state (replayed by the relay after
    // connect) to arrive and be processed by y-websocket before we check
    // whether to seed. Without this, the seed check runs before stored
    // messages populate Y.Text, causing the original content to overwrite
    // persisted edits.
    if (this._collabProvider) {
      await new Promise(r => setTimeout(r, 200));
    }

    // Seed Y.Text AFTER mounting binding so yCollab's observer catches the insert.
    // y-codemirror.next only observes CHANGES to Y.Text — it does NOT read
    // pre-existing content. Seeding after mount ensures the yCollab observer
    // dispatches the content to CodeMirror.
    // Guard: only seed if Y.Text is still empty (no state from relay sync).
    if (this._collabProvider && config.initialContent && this._collabProvider.sharedText.length === 0) {
      this._collabProvider.ydoc.transact(() => {
        this._collabProvider!.sharedText.insert(0, config.initialContent);
      });
    }

    // Check staleness after async mount
    if (config.collaboration !== this.collaboration || config.mimeType !== this.mimeType) {
      return;
    }

    // Attach domain coordinators
    if (this._collabProvider && this._binding && config.collaboration) {
      const relayUrl = config.collaboration.providerUrl
        .replace(/^ws(s?):\/\//, 'http$1://')
        .replace(/\/ws\/?$/, '');
      const docId = config.collaboration.roomName;

      // Blame coordinator
      this._blameCoordinator.onActiveChange((active) => { this._blameActive = active; });
      this._blameCoordinator.attach(
        this._binding,
        this._collabProvider.ydoc,
        this._collabProvider.awareness,
        docId,
        {
          liveBlameEnabled: config.collaboration.liveBlameEnabled,
          versionBlameEnabled: config.collaboration.versionBlameEnabled,
        },
      );

      // Version coordinator
      this._versionCoordinator.attach(
        this._binding,
        this._collabProvider.ydoc,
        this._collabProvider,
        {
          relayUrl,
          documentId: docId,
          userName: config.collaboration.user.name,
          autoSnapshot: config.collaboration.versionAutoSnapshot,
          autoSnapshotUpdates: config.collaboration.versionAutoSnapshotUpdates,
          autoSnapshotMinutes: config.collaboration.versionAutoSnapshotMinutes,
          versionBlameEnabled: config.collaboration.versionBlameEnabled,
        },
        {
          onVersionsChange: (v) => { this._versions = v; },
          onSelectedVersionChange: (v) => { this._selectedVersion = v; },
          onDiffResultChange: (d) => { this._diffResult = d; },
          onViewingVersionChange: (viewing) => { this._viewingVersion = viewing; },
        },
        this._blameCoordinator,
        this.readonly,
      );

      // Listen for application events (version-created from relay)
      this._collabProvider.onAppMessage((data: any) => {
        this._versionCoordinator.handleAppMessage(data);
      });

      // Comments coordinator — fetch capabilities first, then attach.
      await this._attachCommentCoordinator(relayUrl, docId, config.collaboration);
    }

    this._readyResolve?.();
    this._readyResolve = null;
  }

  private async _attachCommentCoordinator(
    relayUrl: string,
    docId: string,
    collab: CollaborationConfig,
  ): Promise<void> {
    if (!this._collabProvider || !this._binding) return;

    // Check relay-level comments availability (GET /api/capabilities).
    let relayComments = false;
    try {
      const resp = await fetch(`${relayUrl}/api/capabilities`, { credentials: 'include' });
      if (resp.ok) {
        const body = (await resp.json()) as { comments_supported?: boolean };
        relayComments = !!body.comments_supported;
      }
    } catch {
      relayComments = false;
    }

    if (!relayComments || collab.commentsEnabled === false) {
      this._commentsAvailable = false;
      this._suggestAvailable = false;
      return;
    }

    // Fetch comments-provider capabilities.
    let caps: CommentsCapabilities | null = null;
    try {
      const resp = await fetch(
        `${relayUrl}/api/documents/comments/capabilities`,
        { credentials: 'include' },
      );
      if (resp.ok) caps = (await resp.json()) as CommentsCapabilities;
    } catch {
      caps = null;
    }
    if (!caps) {
      this._commentsAvailable = false;
      this._suggestAvailable = false;
      return;
    }
    this._commentCapabilities = caps;

    const sharedText = this._collabProvider.sharedText;
    this._commentEngine = new CommentEngine(
      this._collabProvider.ydoc,
      sharedText,
      {
        relayUrl,
        documentId: docId,
        user: {
          userId: collab.user.name,
          userName: collab.user.name,
          userColor: collab.user.color,
        },
        capabilities: caps,
        pollIntervalMs: collab.commentsPollInterval ?? 30_000,
      },
    );
    this._suggestEngine = new SuggestEngine(
      this._collabProvider.ydoc,
      sharedText,
      { user: {
        userId: collab.user.name,
        userName: collab.user.name,
        userColor: collab.user.color,
      } },
    );

    this._commentCoordinator.onThreadsChange(() => {
      if (this._activeCommentThread) {
        const fresh = this._commentEngine
          ?.getThreads()
          .find((t) => t.id === this._activeCommentThread!.id);
        this._activeCommentThread = fresh ?? null;
      }
    });
    this._commentCoordinator.attach(
      this._commentEngine,
      this._binding,
      this._collabProvider.ydoc,
      this._collabProvider.awareness,
      {
        commentsEnabled: collab.commentsEnabled,
        suggestEnabled: collab.suggestEnabled,
      },
    );
    this._commentsAvailable = this._commentCoordinator.commentsAvailable;
    this._suggestAvailable = this._commentCoordinator.suggestAvailable;

    // Suggest buffer change -> update pending count + push pending overlay.
    this._suggestEngine.onBufferChange(() => {
      this._suggestPendingCount = this._suggestEngine?.hasPendingChanges() ? 1 : 0;
    });

    // Load persisted threads and start polling.
    try {
      await this._commentEngine.loadFromSPI();
    } catch (e) {
      console.warn('comments: initial load failed', e);
    }
    this._commentEngine.startPolling();
  }

  private async _mountBinding(mode: EditorMode): Promise<void> {
    const root = this.renderRoot.querySelector('#editor-root') as HTMLElement;
    if (!root) return;

    // Click on a comment anchor / suggestion widget surfaces a DOM event
    // from the plugins (see comment-tiptap-plugin + comment-cm-extension).
    // _mountBinding is called on every mode switch, so we MUST remove the
    // previous listener first — otherwise each mode switch adds a new one
    // and a single click fires the handler N+1 times.
    if (this._commentThreadActivatedHandler) {
      root.removeEventListener(
        'comment-thread-activated',
        this._commentThreadActivatedHandler,
      );
    }
    const handler: EventListener = ((e: Event) => {
      const ce = e as CustomEvent;
      const threadId = ce.detail?.threadId;
      if (!threadId || !this._commentEngine) return;
      const thread = this._commentEngine
        .getThreads()
        .find((t) => t.id === threadId);
      if (thread) {
        this._activeCommentThread = thread;
        this._commentCoordinator.setActiveThread(threadId);
        this._positionCommentPanelNear(threadId);
      }
    }) as EventListener;
    root.addEventListener('comment-thread-activated', handler);
    this._commentThreadActivatedHandler = handler;

    this._binding = this._factory.create(this.mimeType);

    const collabContext: CollaborationContext | null = this._collabProvider ? {
      sharedText: this._collabProvider.sharedText,
      awareness: this._collabProvider.awareness,
      ydoc: this._collabProvider.ydoc,
    } : null;

    await this._binding.mount(root, mode, {
      readonly: this.readonly,
      theme: this.theme,
      placeholder: this.placeholder,
    }, collabContext);

    // Subscribe to binding events
    this._binding.onContentChange((content) => {
      this._emitContentChange(content);
    });

    this._binding.onRemoteChange((detail) => {
      this._remoteChangeCallbacks.forEach(cb => cb({
        peerId: String(detail.origin ?? 'unknown'),
        changeType: 'update',
      }));
    });

    this.mode = mode;
    this._wireFormattingState();
  }

  // --- Public API ---

  async switchMode(newMode: EditorMode): Promise<void> {
    if (newMode === this.mode) return;
    if (!this._binding) return;

    // Before-mode-change hook
    for (const cb of this._beforeModeChangeCallbacks) {
      if (!cb({ mode: newMode, previousMode: this.mode })) return;
    }

    const cancelEvent = new CustomEvent('before-mode-change', {
      detail: { mode: newMode, previousMode: this.mode },
      cancelable: true, bubbles: true, composed: true,
    });
    if (!this.dispatchEvent(cancelEvent)) return;

    const previousMode = this.mode;

    try {
      await this._binding.switchMode(newMode);
      this.mode = newMode;
    } catch (e) {
      console.error('Mode switch failed:', e);
      return;
    }

    // Let coordinators react to mode switch
    this._blameCoordinator.onModeSwitch();
    if (this._binding) {
      this._commentCoordinator.onModeSwitch(this._binding);
    }

    // Update formatting state — available commands change with mode
    this._wireFormattingState();

    const detail: ModeChangeDetail = { mode: newMode, previousMode };
    this.dispatchEvent(new ModeChangeEvent(detail));
    this._modeChangeCallbacks.forEach(cb => cb(detail));
  }

  getContent(): string {
    return this._binding?.getContent() ?? '';
  }

  setContent(text: string): void {
    this._binding?.setContent(text);
  }

  /**
   * Configure the editor with all options at once.
   * Sets properties synchronously (Lit batches into one update),
   * then waits for initialization to complete via the serialized chain.
   */
  async configure(options: {
    mimeType: string;
    collaboration: CollaborationConfig;
    initialContent?: string;
  }): Promise<void> {
    this.initialContent = options.initialContent ?? '';
    this.mimeType = options.mimeType;
    this.collaboration = options.collaboration;
    // Wait for Lit to process property changes → updated() → _requestInit()
    await this.updateComplete;
    // Wait for the serialized init chain to finish
    await this._initChain;
  }

  // --- IEditorEventEmitter ---

  onContentChange(callback: (detail: ContentChangeDetail) => void): () => void {
    this._contentChangeCallbacks.add(callback);
    return () => this._contentChangeCallbacks.delete(callback);
  }

  onModeChange(callback: (detail: ModeChangeDetail) => void): () => void {
    this._modeChangeCallbacks.add(callback);
    return () => this._modeChangeCallbacks.delete(callback);
  }

  onSave(callback: (detail: SaveDetail) => void): () => void {
    this._saveCallbacks.add(callback);
    return () => this._saveCallbacks.delete(callback);
  }

  onCollabStatus(callback: (detail: CollabStatusDetail) => void): () => void {
    this._collabStatusCallbacks.add(callback);
    return () => this._collabStatusCallbacks.delete(callback);
  }

  onRemoteChange(callback: (detail: RemoteChangeDetail) => void): () => void {
    this._remoteChangeCallbacks.add(callback);
    return () => this._remoteChangeCallbacks.delete(callback);
  }

  onBeforeModeChange(callback: (detail: BeforeModeChangeDetail) => boolean): () => void {
    this._beforeModeChangeCallbacks.add(callback);
    return () => this._beforeModeChangeCallbacks.delete(callback);
  }

  // --- Private helpers ---

  private get _currentDocumentName(): string {
    if (this.currentDocumentId && this.documents.length > 0) {
      const doc = this.documents.find(d => d.id === this.currentDocumentId);
      return doc?.name ?? this.currentDocumentId;
    }
    return this.currentDocumentId;
  }

  private _handleToolbarDocumentSwitch(e: CustomEvent): void {
    this.dispatchEvent(new CustomEvent('document-change', {
      detail: { documentId: e.detail.documentId },
      bubbles: true,
      composed: true,
    }));
  }

  private _handleToolbarCommand(e: CustomEvent): void {
    if (!this._binding || !isFormattingCapable(this._binding)) return;
    this._binding.executeCommand(e.detail.command, e.detail.params);
  }

  private _handleToolbarModeSwitch(e: CustomEvent): void {
    this.switchMode(e.detail.mode);
  }

  private _handleBlameToggle(e: CustomEvent): void {
    this._blameCoordinator.toggle(e.detail.active);
  }

  // --- Comments + Suggest Mode event handlers ---

  private _handleCommentAdd(): void {
    if (!this._commentEngine || !this._binding || !this._collabProvider) return;
    // Selection → Y.Text offsets. Uses the shared pm-position-map so
    // WYSIWYG's PM-positioned selection is correctly inverted onto the
    // raw Markdown/HTML source offsets; CodeMirror and plain-text both
    // fall through to their identity mapping.
    const range = readSelectionRange(
      this.renderRoot,
      this._binding,
      this._collabProvider.sharedText.toString(),
    );
    if (!range) return;
    const { start, end } = range;
    const { anchor, startRel, endRel } = this._commentEngine.createAnchor(start, end);
    const threadId = this._commentEngine.createThread(anchor, startRel, endRel, '', null);
    const thread = this._commentEngine.getThreads().find((t) => t.id === threadId);
    if (thread) {
      this._activeCommentThread = thread;
      this._commentCoordinator.setActiveThread(threadId);
      // New thread's anchor decoration renders on the next frame; wait
      // before querying its position.
      requestAnimationFrame(() => this._positionCommentPanelNear(threadId));
    }
  }

  /**
   * Place the comment panel BELOW the anchor decoration so it never
   * covers the text the comment is about. Clamps horizontally to stay
   * inside the editor root, and falls back to a default top-left
   * position when the anchor can't be located (e.g., decoration not
   * rendered yet in the currently-visible editor instance).
   */
  private _positionCommentPanelNear(threadId: string): void {
    const editorRoot = this.renderRoot.querySelector('#editor-root') as HTMLElement | null;
    if (!editorRoot) return;
    const anchor = editorRoot.querySelector(
      `[data-comment-thread-id="${CSS.escape(threadId)}"]`,
    ) as HTMLElement | null;
    if (!anchor) {
      // Couldn't find the anchor — keep whatever position was set before
      // (may be stale) or fall back to default on first render.
      this._commentPanelPos = this._commentPanelPos ?? { x: 16, y: 48 };
      return;
    }
    const rootRect = editorRoot.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const panelWidth = 380;
    this._commentPanelPos = {
      x: Math.max(
        8,
        Math.min(anchorRect.left - rootRect.left, rootRect.width - panelWidth - 8),
      ),
      y: anchorRect.bottom - rootRect.top + 6,
    };
  }

  private _handleSuggestToggle(e: CustomEvent): void {
    if (!this._suggestEngine || !this._binding) return;
    const active = !!e.detail.active;
    if (active) {
      this._suggestEngine.enable();
      this._suggestActive = true;
      this._commentCoordinator.setSuggestActive(true);
    } else {
      if (this._suggestEngine.hasPendingChanges()) {
        const action = window.confirm(
          'You have pending suggestions. Submit them before exiting Suggest Mode? ' +
            '(Cancel to discard)',
        );
        if (action) this._commitPendingSuggestion();
      }
      this._suggestEngine.disable();
      this._suggestActive = false;
      this._suggestPendingCount = 0;
      this._commentCoordinator.setSuggestActive(false);
    }
  }

  private _handleSuggestSubmit(): void {
    this._commitPendingSuggestion();
  }

  private _handleSuggestDiscard(): void {
    this._suggestEngine?.clear();
    this._suggestPendingCount = 0;
  }

  private _commitPendingSuggestion(): void {
    if (!this._suggestEngine || !this._commentEngine) return;
    if (!this._suggestEngine.hasPendingChanges()) return;
    const note = window.prompt('Add a note (optional):') ?? null;
    try {
      const payload = this._suggestEngine.buildSuggestion(note);
      this._commentEngine.commitSuggestion(payload);
      this._suggestEngine.clear();
      this._suggestPendingCount = 0;
    } catch (err) {
      console.error('commit suggestion failed', err);
    }
  }

  private _handleCommentPanelClose(): void {
    this._activeCommentThread = null;
    this._commentCoordinator.setActiveThread(null);
  }

  private _handleCommentReply(e: CustomEvent): void {
    this._commentEngine?.addReply(e.detail.threadId, e.detail.content);
  }

  private _handleCommentThreadResolve(e: CustomEvent): void {
    this._commentEngine?.resolveThread(e.detail.threadId);
    // Resolving means "I'm done with this thread" — close the panel so
    // the user isn't left staring at the same thread with a Reopen
    // button. If they want to reopen, they click the anchor again.
    if (this._activeCommentThread?.id === e.detail.threadId) {
      this._activeCommentThread = null;
      this._commentCoordinator.setActiveThread(null);
    }
  }

  private _handleCommentThreadReopen(e: CustomEvent): void {
    this._commentEngine?.reopenThread(e.detail.threadId);
  }

  private _handleCommentThreadDelete(e: CustomEvent): void {
    this._commentEngine?.deleteThread(e.detail.threadId);
    if (this._activeCommentThread?.id === e.detail.threadId) {
      this._activeCommentThread = null;
      this._commentCoordinator.setActiveThread(null);
    }
  }

  private async _handleCommentSuggestionAccept(e: CustomEvent): Promise<void> {
    if (!this._commentEngine || !this._collabProvider) return;
    const threadId = e.detail.threadId;
    const thread = this._commentEngine.getThreads().find((t) => t.id === threadId);
    if (!thread?.suggestion) return;
    try {
      const payload = Uint8Array.from(atob(thread.suggestion.yjs_payload), (c) => c.charCodeAt(0));
      // Apply the suggestion payload to the base Y.Doc. Normal y-websocket
      // sync broadcasts the change to peers, identical to the reviewer
      // having typed the edit by hand.
      Y.applyUpdate(this._collabProvider.ydoc, payload);
      this._commentEngine.decideSuggestion(threadId, 'accepted');
    } catch (err) {
      console.error('accept suggestion failed', err);
      this._commentEngine.decideSuggestion(threadId, 'not_applicable');
    }
    this._activeCommentThread = null;
    this._commentCoordinator.setActiveThread(null);
  }

  private _handleCommentSuggestionReject(e: CustomEvent): void {
    this._commentEngine?.decideSuggestion(e.detail.threadId, 'rejected');
    this._activeCommentThread = null;
    this._commentCoordinator.setActiveThread(null);
  }

  private async _handleCommentMentionSearch(e: CustomEvent): Promise<void> {
    if (!this._commentEngine) {
      e.detail.resolve([]);
      return;
    }
    const candidates: MentionCandidate[] = await this._commentEngine.searchMentions(
      e.detail.query ?? '',
    );
    e.detail.resolve(candidates);
  }

  private _handleVersionClose(): void {
    this._versionCoordinator.closePanel();
    this._versionPanelOpen = false;
  }

  private _handleVersionToggle(): void {
    this._versionCoordinator.togglePanel();
    this._versionPanelOpen = this._versionCoordinator.panelOpen;
  }

  private async _handleVersionSave(): Promise<void> {
    await this._versionCoordinator.save();
  }

  private async _handleVersionSelect(e: CustomEvent): Promise<void> {
    await this._versionCoordinator.select(e.detail.versionId);
  }

  private async _handleVersionView(e: CustomEvent): Promise<void> {
    await this._versionCoordinator.view(e.detail.versionId);
  }

  private async _handleVersionRevert(e: CustomEvent): Promise<void> {
    await this._versionCoordinator.revert(e.detail.versionId);
  }

  private async _handleVersionDiff(e: CustomEvent): Promise<void> {
    await this._versionCoordinator.diff(e.detail.fromId, e.detail.toId);
  }

  private _handleVersionDiffClear(): void {
    this._versionCoordinator.clearDiff();
  }

  private _wireFormattingState(): void {
    // Unsubscribe previous
    this._formattingUnsub?.();
    this._formattingUnsub = null;

    if (this._binding && isFormattingCapable(this._binding)) {
      this._availableCommands = this._binding.getAvailableCommands();
      this._formattingUnsub = this._binding.onFormattingStateChange((state) => {
        this._formattingState = state;
      });
    } else {
      this._availableCommands = [];
      this._formattingState = emptyFormattingState();
    }
  }

  private _wireAwareness(): void {
    // Unsubscribe previous
    if (this._awarenessHandler && this._collabProvider?.awareness) {
      this._collabProvider.awareness.off('change', this._awarenessHandler);
    }
    this._awarenessHandler = null;
    this._collaborators = [];

    const awareness = this._collabProvider?.awareness;
    if (!awareness) return;

    this._awarenessHandler = () => {
      const states = awareness.getStates() as Map<number, any>;
      const localId = awareness.clientID;
      const collabs: CollaboratorInfo[] = [];
      states.forEach((state: any, clientId: number) => {
        if (clientId !== localId && state.user) {
          collabs.push({
            name: state.user.name ?? 'Anonymous',
            color: state.user.color ?? '#888',
            image: state.user.image,
          });
        }
      });
      this._collaborators = collabs;
    };

    awareness.on('change', this._awarenessHandler);
    // Initial read
    this._awarenessHandler();
  }

  private _emitContentChange(content: string): void {
    if (this._changeDebounce) clearTimeout(this._changeDebounce);
    this._changeDebounce = setTimeout(() => {
      const format = this._factory.getContentHandler(this.mimeType).parse('').type;
      const detail: ContentChangeDetail = { value: content, format, mode: this.mode };
      this.dispatchEvent(new EditorChangeEvent(detail));
      this._contentChangeCallbacks.forEach(cb => cb(detail));
    }, 300);
  }

  private _setupKeyboardShortcuts(): void {
    this.addEventListener('keydown', (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        const value = this.getContent();
        const format = this._factory.getContentHandler(this.mimeType).parse('').type;
        const detail: SaveDetail = { value, format };
        this.dispatchEvent(new EditorSaveEvent(detail));
        this._saveCallbacks.forEach(cb => cb(detail));
      }
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._changeDebounce) clearTimeout(this._changeDebounce);
    this._formattingUnsub?.();
    if (this._awarenessHandler && this._collabProvider?.awareness) {
      this._collabProvider.awareness.off('change', this._awarenessHandler);
    }
    this._blameCoordinator.detach();
    this._versionCoordinator.detach();
    this._commentCoordinator.detach();
    this._commentEngine?.destroy();
    this._suggestEngine?.disable();
    if (this._commentThreadActivatedHandler) {
      const root = this.renderRoot.querySelector('#editor-root') as HTMLElement | null;
      root?.removeEventListener(
        'comment-thread-activated',
        this._commentThreadActivatedHandler,
      );
      this._commentThreadActivatedHandler = null;
    }
    this._binding?.destroy();
    this._collabProvider?.destroy();
  }
}

/**
 * Resolve the editor's current selection to a character range in the
 * shared Y.Text. Tries binding-native APIs first (CodeMirror EditorView,
 * Tiptap editor.state.selection) to get accurate offsets; falls back to
 * substring matching against the DOM selection when those aren't
 * accessible (e.g., detached binding).
 */
function readSelectionRange(
  root: ParentNode,
  binding: any,
  yTextStr: string,
): { start: number; end: number } | null {
  // WYSIWYG path FIRST — when Tiptap has a non-collapsed selection we
  // trust it, because the user's click/drag landed in a visible PM
  // position. This avoids accidentally reusing a stale CodeMirror
  // selection when the user is actually editing in WYSIWYG.
  const tiptap = binding?._wysiwygEditor?.editor;
  if (tiptap?.state?.selection && !tiptap.state.selection.empty) {
    const sel = tiptap.state.selection;
    // pmRangeToYText inverts buildPositionMap: PM positions back to
    // Y.Text offsets, skipping syntax chars. Much better than the old
    // `indexOf(selectedText)` which searched in rendered plain text —
    // that produced anchor offsets that were only valid in rendered
    // space and pointed at wrong source characters when stored.
    const range = pmRangeToYText(tiptap.state.doc, yTextStr, sel.from, sel.to);
    if (range) return range;
  }

  // CodeMirror path — Y.Text offsets are identical to CM positions.
  const srcEditor = binding?._sourceEditor?.view ?? binding?._editor?.view;
  if (srcEditor && typeof srcEditor.state?.selection?.main === 'object') {
    const active = (root as any).activeElement ?? (document as any).activeElement;
    if (
      !active ||
      (srcEditor.dom && (srcEditor.dom === active || srcEditor.dom.contains(active)))
    ) {
      const { from, to } = srcEditor.state.selection.main;
      if (to > from) return { start: from, end: to };
    }
  }

  // Last-resort: DOM selection text + substring match. Non-unique text
  // anchors at the first occurrence, but that's better than refusing
  // to create the thread entirely.
  const domSel = (root as any).getSelection?.() ?? window.getSelection?.();
  if (!domSel || domSel.isCollapsed) return null;
  const selText = domSel.toString();
  if (!selText) return null;
  const idx = yTextStr.indexOf(selText);
  if (idx < 0) return null;
  return { start: idx, end: idx + selText.length };
}

declare global {
  interface HTMLElementTagNameMap {
    'multi-editor': MultiEditor;
  }
}
