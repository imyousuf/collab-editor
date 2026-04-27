/**
 * Bidirectional replicator between two Y.Doc instances.
 *
 * Used to separate the "wire/sync" doc (attached to the websocket transport)
 * from the "editor" doc (attached to Tiptap + CodeMirror). By default every
 * update on one side is mirrored to the other; the two direction flags
 * (`inboundOpen`, `outboundOpen`) let callers pause either direction — for
 * example, Suggest Mode closes `outboundOpen` so local edits stay off the wire
 * until Submit.
 *
 * Loop prevention: each replicated update is tagged with a private origin
 * symbol; the listener on the other side ignores updates whose origin is this
 * symbol. This is the standard Yjs pattern.
 */
import * as Y from 'yjs';
import { dlog, snapText } from './debug-log.js';

export class DocReplicator {
  readonly syncDoc: Y.Doc;
  readonly editorDoc: Y.Doc;

  /** Sync → Editor direction. Closed = peer updates do not reach the editor. */
  inboundOpen = true;
  /** Editor → Sync direction. Closed = local edits are not broadcast. */
  outboundOpen = true;

  private readonly _origin: symbol;
  private readonly _onSyncUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly _onEditorUpdate: (update: Uint8Array, origin: unknown) => void;
  private _destroyed = false;

  constructor(syncDoc: Y.Doc, editorDoc: Y.Doc) {
    this.syncDoc = syncDoc;
    this.editorDoc = editorDoc;
    this._origin = Symbol('doc-replicator');

    this._onSyncUpdate = (update, origin) => {
      if (this._destroyed) return;
      if (origin === this._origin) return;
      if (!this.inboundOpen) {
        dlog('replicator', 'INBOUND BLOCKED (gate closed)', {
          origin: String(origin?.constructor?.name ?? origin),
          updateBytes: update.byteLength,
        });
        return;
      }
      dlog('replicator', 'sync→editor propagating', {
        origin: String(origin?.constructor?.name ?? origin),
        updateBytes: update.byteLength,
        syncBefore: snapText(this.syncDoc.getText('source').toString()),
        editorBefore: snapText(this.editorDoc.getText('source').toString()),
      });
      Y.applyUpdate(this.editorDoc, update, this._origin);
      dlog('replicator', 'sync→editor done', {
        editorAfter: snapText(this.editorDoc.getText('source').toString()),
      });
    };

    this._onEditorUpdate = (update, origin) => {
      if (this._destroyed) return;
      if (origin === this._origin) return;
      if (!this.outboundOpen) {
        dlog('replicator', 'OUTBOUND BLOCKED (gate closed)', {
          origin: String(origin?.constructor?.name ?? origin),
          updateBytes: update.byteLength,
        });
        return;
      }
      dlog('replicator', 'editor→sync propagating', {
        origin: String(origin?.constructor?.name ?? origin),
        updateBytes: update.byteLength,
        editorBefore: snapText(this.editorDoc.getText('source').toString()),
        syncBefore: snapText(this.syncDoc.getText('source').toString()),
      });
      Y.applyUpdate(this.syncDoc, update, this._origin);
      dlog('replicator', 'editor→sync done', {
        syncAfter: snapText(this.syncDoc.getText('source').toString()),
      });
    };

    this.syncDoc.on('update', this._onSyncUpdate);
    this.editorDoc.on('update', this._onEditorUpdate);
  }

  /**
   * Seed the editor doc from the sync doc's current state. Call once after the
   * transport reports `synced` so the editor starts from the authoritative
   * baseline.
   */
  seedEditorFromSync(): void {
    if (this._destroyed) return;
    const state = Y.encodeStateAsUpdate(this.syncDoc);
    Y.applyUpdate(this.editorDoc, state, this._origin);
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.syncDoc.off('update', this._onSyncUpdate);
    this.editorDoc.off('update', this._onEditorUpdate);
  }
}
