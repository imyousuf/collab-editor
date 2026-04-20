/**
 * <multi-editor> web component — v2 (interface-driven architecture)
 *
 * Thin orchestrator that delegates to IEditorBinding instances
 * created by the EditorBindingFactory.
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
import { isFormattingCapable, emptyFormattingState, isBlameCapable } from './interfaces/index.js';
import {
  EditorChangeEvent,
  ModeChangeEvent,
  EditorSaveEvent,
  CollabStatusEvent,
} from './interfaces/events.js';
import { EditorBindingFactory, registerDefaults } from './registry.js';
import { CollaborationProvider } from './collab/collab-provider.js';
import { VersionManager, type VersionListEntry, type VersionEntry } from './collab/version-manager.js';
import { BlameEngine, type BlameSegment } from './collab/blame-engine.js';

// Register internal toolbar components
import './toolbar/editor-toolbar.js';
import './toolbar/editor-status-bar.js';
import './toolbar/version-panel.js';

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
  @state() private _diffResult: import('./collab/diff-engine.js').DiffLine[] | null = null;

  private _factory: EditorBindingFactory;
  private _binding: IEditorBinding | null = null;
  private _collabProvider: CollaborationProvider | null = null;
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
  private _versionManager: VersionManager | null = null;
  private _blameEngine: BlameEngine | null = null;
  private _blameUpdateUnsub: (() => void) | null = null;

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
      <div class="editor-wrapper">
        <div id="editor-root" class="editor-root" part="editor-area"></div>
        ${statusBarVisible ? this._renderStatusBarSlot() : nothing}
      </div>
      ${!toolbarOnTop && toolbarVisible ? this._renderToolbarSlot() : nothing}
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
          .blameAvailable=${this.collaboration?.liveBlameEnabled !== false && !!this._collabProvider}
          @toolbar-command=${this._handleToolbarCommand}
          @toolbar-mode-switch=${this._handleToolbarModeSwitch}
          @toolbar-document-switch=${this._handleToolbarDocumentSwitch}
          @toolbar-blame-toggle=${this._handleBlameToggle}
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
          @version-toggle=${this._handleVersionToggle}
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
    this._blameUpdateUnsub?.();
    this._blameUpdateUnsub = null;
    this._versionManager?.destroy();
    this._versionManager = null;
    this._blameEngine?.stopLiveBlame();
    this._blameEngine = null;
    this._blameActive = false;
    this._versionPanelOpen = false;
    this._versions = [];
    this._selectedVersion = null;
    this._diffResult = null;
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

    // Set up version manager and blame engine if collaboration is active
    if (this._collabProvider && config.collaboration) {
      const relayUrl = config.collaboration.providerUrl.replace(/\/ws\/?$/, '');
      const docId = config.collaboration.roomName;

      // Version manager
      this._versionManager = new VersionManager(this._collabProvider.ydoc, {
        relayUrl,
        documentId: docId,
        userName: config.collaboration.user.name,
        autoSnapshotUpdates: config.collaboration.versionAutoSnapshot === false
          ? 0 : (config.collaboration.versionAutoSnapshotUpdates ?? 50),
        autoSnapshotMinutes: config.collaboration.versionAutoSnapshot === false
          ? 0 : (config.collaboration.versionAutoSnapshotMinutes ?? 5),
      });
      // Load initial version list
      this._versionManager.listVersions().then(v => { this._versions = v; }).catch(() => {});

      // Blame engine
      this._blameEngine = new BlameEngine(this._collabProvider.ydoc, docId);
      this._blameEngine.setAwareness(this._collabProvider.awareness);
    }

    this._readyResolve?.();
    this._readyResolve = null;
  }

  private async _mountBinding(mode: EditorMode): Promise<void> {
    const root = this.renderRoot.querySelector('#editor-root') as HTMLElement;
    if (!root) return;

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
    if (this.collaboration?.liveBlameEnabled === false) return;

    this._blameActive = e.detail.active;

    if (this._blameActive && this._blameEngine && this._binding && isBlameCapable(this._binding)) {
      this._blameEngine.startLiveBlame();
      const segments = this._blameEngine.getLiveBlame();
      this._binding.enableBlame(segments);

      // Re-compute blame on doc updates
      this._blameUpdateUnsub?.();
      const observer = () => {
        if (this._blameActive && this._blameEngine && this._binding && isBlameCapable(this._binding)) {
          const updated = this._blameEngine.getLiveBlame();
          this._binding.updateBlame(updated);
        }
      };
      const ydoc = this._collabProvider?.ydoc;
      ydoc?.on('update', observer);
      this._blameUpdateUnsub = () => {
        ydoc?.off('update', observer);
      };
    } else {
      this._blameUpdateUnsub?.();
      this._blameUpdateUnsub = null;
      this._blameEngine?.stopLiveBlame();
      if (this._binding && isBlameCapable(this._binding)) {
        this._binding.disableBlame();
      }
    }
  }

  private _handleVersionToggle(): void {
    this._versionPanelOpen = !this._versionPanelOpen;
    if (this._versionPanelOpen) {
      this._versionManager?.listVersions().then(v => { this._versions = v; }).catch(() => {});
    }
  }

  private async _handleVersionSave(): Promise<void> {
    const entry = await this._versionManager?.createVersion();
    if (entry) {
      this._versions = [entry, ...this._versions];
    }
  }

  private async _handleVersionSelect(e: CustomEvent): Promise<void> {
    const version = await this._versionManager?.getVersion(e.detail.versionId);
    if (version) {
      this._selectedVersion = version;
    }
  }

  private async _handleVersionView(e: CustomEvent): Promise<void> {
    const version = await this._versionManager?.getVersion(e.detail.versionId);
    if (!version) return;
    this._selectedVersion = version;

    // Switch to read-only version view mode
    if (this._binding) {
      this._binding.setReadonly(true);
      this._binding.setContent(version.content ?? '');

      // Apply version blame if enabled and available
      if (this.collaboration?.versionBlameEnabled !== false &&
          version.blame && version.blame.length > 0 && isBlameCapable(this._binding)) {
        const segments: BlameSegment[] = version.blame.map(b => ({
          start: b.start,
          end: b.end,
          userName: b.user_name,
        }));
        this._binding.enableBlame(segments);
      }
    }
  }

  private async _handleVersionRevert(e: CustomEvent): Promise<void> {
    const version = await this._versionManager?.getVersion(e.detail.versionId);
    if (!version) return;

    // Exit version view mode if active
    this._exitVersionView();

    await this._versionManager?.revertToVersion(version);
    this._versions = await this._versionManager?.listVersions() ?? [];
  }

  private async _handleVersionDiff(e: CustomEvent): Promise<void> {
    if (!this._versionManager) return;
    const fromVersion = await this._versionManager.getVersion(e.detail.fromId);
    const toVersion = await this._versionManager.getVersion(e.detail.toId);
    if (!fromVersion || !toVersion) return;

    this._diffResult = this._versionManager.diffVersions(fromVersion, toVersion);
  }

  private _exitVersionView(): void {
    if (this._binding) {
      this._binding.setReadonly(this.readonly);
      if (isBlameCapable(this._binding)) {
        this._binding.disableBlame();
      }
    }
    this._selectedVersion = null;
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
    this._blameUpdateUnsub?.();
    if (this._awarenessHandler && this._collabProvider?.awareness) {
      this._collabProvider.awareness.off('change', this._awarenessHandler);
    }
    this._versionManager?.destroy();
    this._versionManager = null;
    this._blameEngine?.stopLiveBlame();
    this._blameEngine = null;
    this._binding?.destroy();
    this._collabProvider?.destroy();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'multi-editor': MultiEditor;
  }
}
