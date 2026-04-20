/**
 * Yjs provider over Socket.io transport.
 * Drop-in replacement for y-websocket's WebsocketProvider —
 * same interface surface (awareness, wsconnected, status events).
 *
 * Sends/receives Yjs binary messages via 'yjs-sync' Socket.io events.
 * Designed to work with a server-side bridge (e.g., Opal's ws-gateway)
 * that forwards binary frames to the relay.
 */
import { io, Socket } from 'socket.io-client';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { ObservableV2 } from 'lib0/observable';

export interface SocketIOProviderOptions {
  awareness?: awarenessProtocol.Awareness;
  auth?: Record<string, any>;
  connect?: boolean;
}

// y-websocket message types
const messageSync = 0;
const messageAwareness = 1;

export class SocketIOProvider extends ObservableV2<string> {
  doc: Y.Doc;
  roomname: string;
  awareness: awarenessProtocol.Awareness;
  wsconnected: boolean = false;
  synced: boolean = false;

  private _socket: Socket | null = null;
  private _serverUrl: string;
  private _auth: Record<string, any>;
  private _destroyed = false;

  private _updateHandler: (update: Uint8Array, origin: any) => void;
  private _awarenessUpdateHandler: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: any,
  ) => void;

  constructor(
    serverUrl: string,
    roomname: string,
    doc: Y.Doc,
    opts: SocketIOProviderOptions = {},
  ) {
    super();
    this._serverUrl = serverUrl;
    this.roomname = roomname;
    this.doc = doc;
    this._auth = opts.auth ?? {};
    this.awareness =
      opts.awareness ?? new awarenessProtocol.Awareness(doc);

    // Y.Doc update handler — send local changes to server
    this._updateHandler = (update: Uint8Array, origin: any) => {
      if (origin === this) return; // Don't echo remote updates
      if (!this.wsconnected) return;

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      this._send(encoding.toUint8Array(encoder));
    };

    // Awareness update handler — broadcast local awareness changes
    this._awarenessUpdateHandler = (
      { added, updated, removed },
      origin,
    ) => {
      if (origin === this) return;
      if (!this.wsconnected) return;

      const changedClients = added.concat(updated).concat(removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          changedClients,
        ),
      );
      this._send(encoding.toUint8Array(encoder));
    };

    this.doc.on('update', this._updateHandler);
    this.awareness.on('update', this._awarenessUpdateHandler);

    if (opts.connect !== false) {
      this.connect();
    }
  }

  connect(): void {
    if (this._socket?.connected) return;
    if (this._destroyed) return;

    this._socket = io(this._serverUrl, {
      query: { doc: this.roomname },
      auth: this._auth,
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      forceNew: true,
    });

    this._socket.on('connect', () => {
      this.wsconnected = true;
      this.emit('status', [{ status: 'connected' }]);

      // Send sync step 1
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this._send(encoding.toUint8Array(encoder));

      // Broadcast local awareness state
      if (this.awareness.getLocalState() !== null) {
        const awarenessEncoder = encoding.createEncoder();
        encoding.writeVarUint(awarenessEncoder, messageAwareness);
        encoding.writeVarUint8Array(
          awarenessEncoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
            this.doc.clientID,
          ]),
        );
        this._send(encoding.toUint8Array(awarenessEncoder));
      }
    });

    this._socket.on('disconnect', () => {
      this.wsconnected = false;
      this.synced = false;
      this.emit('status', [{ status: 'disconnected' }]);

      // Mark all remote clients as disconnected
      const states = Array.from(this.awareness.getStates().keys()).filter(
        (client) => client !== this.doc.clientID,
      );
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        states,
        this,
      );
    });

    this._socket.on('connect_error', () => {
      this.wsconnected = false;
      this.emit('status', [{ status: 'disconnected' }]);
    });

    // Receive Yjs binary messages
    this._socket.on('yjs-sync', (data: ArrayBuffer) => {
      this._handleMessage(new Uint8Array(data));
    });
  }

  disconnect(): void {
    if (this._socket) {
      this._socket.disconnect();
      this._socket = null;
    }
    this.wsconnected = false;
    this.synced = false;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    // Remove local awareness state
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      'provider destroy',
    );

    this.disconnect();
    this.doc.off('update', this._updateHandler);
    this.awareness.off('update', this._awarenessUpdateHandler);
    super.destroy();
  }

  private _send(data: Uint8Array): void {
    this._socket?.emit('yjs-sync', data);
  }

  private _handleMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case messageSync: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageSync);
        const syncMessageType = syncProtocol.readSyncMessage(
          decoder,
          encoder,
          this.doc,
          this, // origin — matches `origin !== this._provider` check
        );

        // If there's a response (sync step 2 reply), send it back
        if (encoding.length(encoder) > 1) {
          this._send(encoding.toUint8Array(encoder));
        }

        // Mark synced after receiving sync step 2
        if (syncMessageType === 2 && !this.synced) {
          this.synced = true;
          this.emit('synced', [true]);
        }
        break;
      }
      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          this, // origin
        );
        break;
      }
    }
  }
}
