/**
 * <multi-editor> web component — v2 (interface-driven architecture)
 *
 * Thin orchestrator that delegates to IEditorBinding instances
 * created by the EditorBindingFactory.
 */
import { LitElement, html, css } from 'lit';
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
} from './interfaces/index.js';
import {
  EditorChangeEvent,
  ModeChangeEvent,
  EditorSaveEvent,
  CollabStatusEvent,
} from './interfaces/events.js';
import { EditorBindingFactory, registerDefaults } from './registry.js';
import { CollaborationProvider } from './collab/collab-provider.js';

@customElement('multi-editor')
export class MultiEditor extends LitElement implements IEditorEventEmitter {
  @property({ type: String, reflect: true }) mode: EditorMode = 'source';
  @property({ type: String }) mimeType: string = 'text/plain';
  @property({ type: String }) placeholder: string = 'Start writing...';
  @property({ type: String, reflect: true }) theme: 'light' | 'dark' = 'light';
  @property({ type: Boolean }) readonly: boolean = false;
  @property({ attribute: false }) collaboration: CollaborationConfig | null = null;
  @property({ attribute: false }) initialContent: string = '';

  @state() private _collabStatus: CollabStatus = 'disconnected';

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
    :host { display: block; position: relative; }
    .editor-root { width: 100%; min-height: 200px; }
    .ProseMirror { outline: none; padding: 12px; min-height: 200px; }
    .ProseMirror p.is-editor-empty:first-child::before {
      content: attr(data-placeholder); float: left; color: #adb5bd;
      pointer-events: none; height: 0;
    }
    .ProseMirror pre { background: #1e1e1e; color: #d4d4d4; padding: 12px; border-radius: 4px; overflow-x: auto; }
    .ProseMirror code { background: #f0f0f0; padding: 2px 4px; border-radius: 2px; font-size: 0.9em; }
    .ProseMirror pre code { background: none; padding: 0; }
    .cm-editor { min-height: 200px; }
  `;

  render() {
    return html`<div id="editor-root" class="editor-root"></div>`;
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
    this._binding?.destroy();
    this._collabProvider?.destroy();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'multi-editor': MultiEditor;
  }
}
