import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { SocketIOProvider } from './socketio-provider.js';
import { DocReplicator } from './doc-replicator.js';
import type {
  ICollaborationProvider,
  CollaborationConfig,
  CollabStatus,
  CollabStatusCallback,
  RemoteUpdateCallback,
} from '../interfaces/collaboration.js';

// Both WebsocketProvider and SocketIOProvider share: awareness, wsconnected, synced, on('status'/'synced'), disconnect(), destroy()
// Using a structural type avoids union incompatibility with generics on .on()
interface YjsProvider {
  awareness: any;
  wsconnected: boolean;
  synced?: boolean;
  on(event: string, handler: (...args: any[]) => void): void;
  disconnect(): void;
  destroy(): void;
}

export class CollaborationProvider implements ICollaborationProvider {
  readonly syncDoc: Y.Doc;
  readonly syncText: Y.Text;
  readonly meta: Y.Map<string>;

  private _editorDoc: Y.Doc;
  private _editorText: Y.Text;
  private _replicator: DocReplicator;

  private _provider: YjsProvider | null = null;
  private _status: CollabStatus = 'disconnected';
  private _statusCallbacks = new Set<CollabStatusCallback>();
  private _remoteCallbacks = new Set<RemoteUpdateCallback>();
  private _appMessageCallbacks = new Set<(data: any) => void>();
  private _editorResetCallbacks = new Set<() => void>();
  private _connectedResolvers: Array<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor() {
    this.syncDoc = new Y.Doc();
    this.syncText = this.syncDoc.getText('source');
    this.meta = this.syncDoc.getMap('meta');
    this._editorDoc = new Y.Doc();
    this._editorText = this._editorDoc.getText('source');
    this._replicator = new DocReplicator(this.syncDoc, this._editorDoc);
  }

  get editorDoc(): Y.Doc { return this._editorDoc; }
  get editorText(): Y.Text { return this._editorText; }
  get replicator(): DocReplicator { return this._replicator; }

  get status(): CollabStatus { return this._status; }

  get awareness() {
    return this._provider?.awareness ?? null;
  }

  async connect(config: CollaborationConfig): Promise<void> {
    this.disconnect();
    this._setStatus('connecting');

    if (config.transport === 'socketio') {
      this._provider = new SocketIOProvider(
        config.providerUrl,
        config.roomName,
        this.syncDoc,
        { auth: config.socketAuth },
      );
    } else {
      this._provider = new WebsocketProvider(
        config.providerUrl,
        config.roomName,
        this.syncDoc,
      );
    }
    this._provider.awareness.setLocalStateField('user', config.user);

    this._provider.on('status', (event: { status: string }) => {
      const newStatus = event.status as CollabStatus;
      this._setStatus(newStatus);

      if (newStatus === 'connected') {
        // Intercept WebSocket messages for application events (type 0x03)
        this._hookWebSocket();

        for (const { resolve, timer } of this._connectedResolvers) {
          clearTimeout(timer);
          resolve();
        }
        this._connectedResolvers = [];
      }
    });

    // Check if already connected (status event may have fired before listener was attached)
    if (this._provider.wsconnected) {
      this._setStatus('connected');
      for (const { resolve, timer } of this._connectedResolvers) {
        clearTimeout(timer);
        resolve();
      }
      this._connectedResolvers = [];
    }

    // Listen for remote updates on syncDoc (the transport-bound doc).
    // The replicator mirrors these to editorDoc automatically.
    this.syncDoc.on('update', (_update: Uint8Array, origin: any) => {
      // Only fire for remote updates (not local transactions)
      if (origin !== this._provider) return;
      this._remoteCallbacks.forEach(cb => cb({ origin }));
    });

    await this.whenConnected();
  }

  disconnect(): void {
    if (this._provider) {
      this._provider.disconnect();
      this._provider.destroy();
      this._provider = null;
    }
    this._setStatus('disconnected');
  }

  async whenConnected(timeoutMs = 10000): Promise<void> {
    if (this._status === 'connected') return;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._connectedResolvers = this._connectedResolvers.filter(r => r.resolve !== resolve);
        reject(new Error(`Collaboration connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._connectedResolvers.push({ resolve, reject, timer });
    });
  }

  /**
   * Resolve when the underlying y-websocket provider emits `synced`,
   * i.e., when the relay has responded with `SYNC_STEP_2` and the client
   * has applied it. After this point the Y.Doc holds the authoritative
   * server state and it is safe to start editing.
   *
   * The relay was rewritten in Phase 1 (see internal/relay/room.go) to
   * be a proper Yjs peer — it maintains a server-side Y.Doc and replies
   * to `SYNC_STEP_1` with a real `SYNC_STEP_2`. `synced` reliably flips
   * once; no idle-detection, no fixed-settle heuristics, no seeding
   * race to defend against.
   *
   * `timeoutMs` is a safety bound so a broken relay can't stall init
   * forever — if it fires the caller starts editing against whatever
   * state the Y.Doc has received so far (typically still empty).
   */
  async whenSynced(timeoutMs = 5000): Promise<void> {
    await this.whenConnected(10000);
    if (!this._provider || this._provider.synced === true) return;

    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this._provider!.on('synced', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  onStatusChange(callback: CollabStatusCallback): () => void {
    this._statusCallbacks.add(callback);
    return () => this._statusCallbacks.delete(callback);
  }

  onRemoteUpdate(callback: RemoteUpdateCallback): () => void {
    this._remoteCallbacks.add(callback);
    return () => this._remoteCallbacks.delete(callback);
  }

  destroy(): void {
    this.disconnect();
    for (const { reject, timer } of this._connectedResolvers) {
      clearTimeout(timer);
      reject(new Error('CollaborationProvider destroyed'));
    }
    this._connectedResolvers = [];
    this._statusCallbacks.clear();
    this._remoteCallbacks.clear();
    this._appMessageCallbacks.clear();
    this._editorResetCallbacks.clear();
    this._replicator.destroy();
    this._editorDoc.destroy();
    this.syncDoc.destroy();
  }

  resetEditorDoc(): void {
    const oldReplicator = this._replicator;
    const oldEditorDoc = this._editorDoc;

    // Fresh editorDoc → fresh clientID → no clock-continuity gap with syncDoc.
    const newEditorDoc = new Y.Doc();
    const newEditorText = newEditorDoc.getText('source');
    const newReplicator = new DocReplicator(this.syncDoc, newEditorDoc);

    // Seed the new editor doc from syncDoc BEFORE swapping in the replicator,
    // otherwise the seed update fires a listener on the not-yet-attached
    // editor doc. (The seed uses the replicator's REPL origin so no loop
    // forms either way.)
    newReplicator.seedEditorFromSync();

    this._editorDoc = newEditorDoc;
    this._editorText = newEditorText;
    this._replicator = newReplicator;

    // Tear down the old pair now that all references have moved.
    oldReplicator.destroy();
    oldEditorDoc.destroy();

    // Notify subscribers (bindings) so they can rebind to the new editorText.
    this._editorResetCallbacks.forEach(cb => { try { cb(); } catch { /* swallow */ } });
  }

  onEditorDocReset(callback: () => void): () => void {
    this._editorResetCallbacks.add(callback);
    return () => this._editorResetCallbacks.delete(callback);
  }

  /** Register a callback for application event messages (type 0x03). */
  onAppMessage(callback: (data: any) => void): () => void {
    this._appMessageCallbacks.add(callback);
    return () => this._appMessageCallbacks.delete(callback);
  }

  /**
   * Hook into the WebSocket's onmessage to intercept application event
   * messages (type 0x03) before y-websocket processes them.
   * Called on each (re)connection.
   */
  private _hookWebSocket(): void {
    const ws = (this._provider as any)?.ws as WebSocket | null;
    if (!ws) return;

    const originalOnMessage = ws.onmessage;
    ws.onmessage = (event: MessageEvent) => {
      // Check for application event (0x03) before passing to y-websocket
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        if (bytes.length > 1 && bytes[0] === 0x03) {
          try {
            const jsonStr = new TextDecoder().decode(bytes.slice(1));
            const parsed = JSON.parse(jsonStr);
            this._appMessageCallbacks.forEach(cb => cb(parsed));
          } catch {
            // Malformed — ignore
          }
          return; // Don't pass 0x03 to y-websocket
        }
      }
      // Pass through to y-websocket's handler
      if (originalOnMessage) {
        originalOnMessage.call(ws, event);
      }
    };
  }

  private _setStatus(status: CollabStatus): void {
    if (status === this._status) return;
    this._status = status;
    this._statusCallbacks.forEach(cb => cb(status));
  }
}
