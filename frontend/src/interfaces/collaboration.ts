import type * as Y from 'yjs';
import type { DocReplicator } from '../collab/doc-replicator.js';

export type CollabStatus = 'disconnected' | 'connecting' | 'connected';

export interface CollaborationConfig {
  enabled: boolean;
  roomName: string;
  providerUrl: string;
  /** Transport protocol. Default: 'websocket' */
  transport?: 'websocket' | 'socketio';
  user: {
    name: string;
    color: string;
    image?: string;
  };
  /** Auth payload for Socket.io handshake (only used when transport is 'socketio') */
  socketAuth?: Record<string, any>;

  // --- Version history ---

  /** Enable auto-snapshots. Default: true when collaboration is active */
  versionAutoSnapshot?: boolean;
  /** Create auto-snapshot every N updates. Default: 50 */
  versionAutoSnapshotUpdates?: number;
  /** Create auto-snapshot every N minutes. Default: 5 */
  versionAutoSnapshotMinutes?: number;

  // --- Blame modes (developer controls availability) ---

  /** Enable live blame toggle for end users. Default: true */
  liveBlameEnabled?: boolean;
  /** Enable version blame view for end users. Default: true */
  versionBlameEnabled?: boolean;

  // --- Comments & Suggest Mode ---

  /** Enable the comments UI. Default: true. Auto-false if the relay has no
   * comments provider configured. When this is false, `suggestEnabled` is
   * forced false as well — suggestions cannot exist without comments. */
  commentsEnabled?: boolean;

  /** Enable Google-Docs-style Suggest Mode. Default: true. Forced false
   * when commentsEnabled is false or the Comments Provider does not declare
   * `capabilities.suggestions`. */
  suggestEnabled?: boolean;

  /** Poll interval for external comment changes, in ms. Default 30000. 0 disables. */
  commentsPollInterval?: number;

  /** Whether the comment sidebar starts open. Default: false. */
  commentsSidebarOpen?: boolean;

  /** Optional fetch interceptor for embedders using bearer / custom header auth.
   * The default SDK call wraps `fetch` with `credentials: 'include'`, which
   * covers the typical same-origin cookie-auth deployment. */
  fetchInterceptor?: (init: RequestInit) => RequestInit;
}

export type CollabStatusCallback = (status: CollabStatus) => void;
export type RemoteUpdateCallback = (event: { origin: any }) => void;

/**
 * Wraps the Yjs document, WebSocket provider, and shared types.
 * Exposes a Promise-based connection lifecycle — no setTimeout needed.
 */
export interface ICollaborationProvider {
  /** Current connection status */
  readonly status: CollabStatus;

  /** The shared Y.Map for metadata (lives on syncDoc — canonical shared state). */
  readonly meta: Y.Map<string>;

  /** Yjs awareness for cursor sharing (bound to syncDoc's transport). */
  readonly awareness: any;

  /** Canonical shared-truth doc. Bound to the websocket transport. All peers converge on this. */
  readonly syncDoc: Y.Doc;

  /** `syncDoc.getText('source')` — the canonical shared text. */
  readonly syncText: Y.Text;

  /** Local editor doc. Bound to the editor surfaces (Tiptap / CodeMirror). Mirrors syncDoc via the replicator. */
  readonly editorDoc: Y.Doc;

  /** `editorDoc.getText('source')` — the editor's view of the text. */
  readonly editorText: Y.Text;

  /** The bidirectional replicator between syncDoc and editorDoc. */
  readonly replicator: DocReplicator;

  /**
   * Connect to the collaboration server.
   * Returns a Promise that resolves when the WebSocket is connected
   * and the initial sync is complete.
   */
  connect(config: CollaborationConfig): Promise<void>;

  /** Disconnect from the collaboration server (non-destructive, can reconnect) */
  disconnect(): void;

  /**
   * Returns a Promise that resolves when the provider is connected.
   * If already connected, resolves immediately.
   * Rejects after a timeout.
   */
  whenConnected(timeoutMs?: number): Promise<void>;

  /** Register a callback for status changes. Returns unsubscribe function. */
  onStatusChange(callback: CollabStatusCallback): () => void;

  /** Register a callback for remote updates. Returns unsubscribe function. */
  onRemoteUpdate(callback: RemoteUpdateCallback): () => void;

  /** Permanently destroy the provider and Y.Doc */
  destroy(): void;

  /**
   * Destroy and recreate `editorDoc` (and its replicator) from the current
   * `syncDoc` state. Used on Suggest Mode exit to discard local drafts and
   * their tombstoned CRDT ops. Fresh editorDoc → fresh clientID → no clock-
   * continuity issues when the outbound gate next opens.
   *
   * Subscribers registered via `onEditorDocReset` fire AFTER the swap, so
   * bindings can rebind to the new `editorText`.
   */
  resetEditorDoc(): void;

  /**
   * Register a callback invoked every time `editorDoc` is swapped via
   * `resetEditorDoc()`. Returns an unsubscribe function.
   */
  onEditorDocReset(callback: () => void): () => void;
}
