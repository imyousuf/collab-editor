import type * as Y from 'yjs';

export type CollabStatus = 'disconnected' | 'connecting' | 'connected';

export interface CollaborationConfig {
  enabled: boolean;
  roomName: string;
  providerUrl: string;
  user: {
    name: string;
    color: string;
  };
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

  /** The shared Y.Text that all editors bind to */
  readonly sharedText: Y.Text;

  /** The shared Y.Map for metadata */
  readonly meta: Y.Map<string>;

  /** Yjs awareness for cursor sharing */
  readonly awareness: any;

  /** The underlying Y.Doc */
  readonly ydoc: Y.Doc;

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
}
