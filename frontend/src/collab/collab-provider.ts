import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { SocketIOProvider } from './socketio-provider.js';
import type {
  ICollaborationProvider,
  CollaborationConfig,
  CollabStatus,
  CollabStatusCallback,
  RemoteUpdateCallback,
} from '../interfaces/collaboration.js';

// Both WebsocketProvider and SocketIOProvider share: awareness, wsconnected, on('status'), disconnect(), destroy()
// Using a structural type avoids union incompatibility with generics on .on()
interface YjsProvider {
  awareness: any;
  wsconnected: boolean;
  on(event: string, handler: (...args: any[]) => void): void;
  disconnect(): void;
  destroy(): void;
}

export class CollaborationProvider implements ICollaborationProvider {
  readonly ydoc: Y.Doc;
  readonly sharedText: Y.Text;
  readonly meta: Y.Map<string>;

  private _provider: YjsProvider | null = null;
  private _status: CollabStatus = 'disconnected';
  private _statusCallbacks = new Set<CollabStatusCallback>();
  private _remoteCallbacks = new Set<RemoteUpdateCallback>();
  private _connectedResolvers: Array<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor() {
    this.ydoc = new Y.Doc();
    this.sharedText = this.ydoc.getText('source');
    this.meta = this.ydoc.getMap('meta');
  }

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
        this.ydoc,
        { auth: config.socketAuth },
      );
    } else {
      this._provider = new WebsocketProvider(
        config.providerUrl,
        config.roomName,
        this.ydoc,
      );
    }
    this._provider.awareness.setLocalStateField('user', config.user);

    this._provider.on('status', (event: { status: string }) => {
      const newStatus = event.status as CollabStatus;
      this._setStatus(newStatus);

      if (newStatus === 'connected') {
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

    // Listen for remote updates on the Y.Doc
    this.ydoc.on('update', (_update: Uint8Array, origin: any) => {
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
    this.ydoc.destroy();
  }

  private _setStatus(status: CollabStatus): void {
    if (status === this._status) return;
    this._status = status;
    this._statusCallbacks.forEach(cb => cb(status));
  }
}
