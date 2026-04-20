/**
 * Yjs engine — applies diffs, extracts text, manages Y.Doc cache.
 *
 * The relay sends y-websocket protocol messages (byte 0 = type, byte 1 = subtype).
 * Only sync update messages (0x00, 0x02) contain actual Yjs updates.
 * The engine strips the protocol header and applies the raw Yjs update.
 */
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';

const TEXT_KEY = 'source';

/** Strip y-websocket protocol header and return the raw Yjs update, or null if not a sync update */
export function extractYjsUpdate(data: Uint8Array): Uint8Array | null {
  if (data.length < 2) return null;

  const decoder = decoding.createDecoder(data);
  const messageType = decoding.readVarUint(decoder);

  if (messageType !== 0) return null; // Not a sync message

  const syncType = decoding.readVarUint(decoder);
  if (syncType !== 2) return null; // Not an update (skip step1=0, step2=1)

  return decoding.readVarUint8Array(decoder);
}

/** Apply a base64-encoded y-websocket message to a Y.Doc. Returns true if applied. */
export function applyBase64Update(doc: Y.Doc, base64Data: string): boolean {
  const raw = Buffer.from(base64Data, 'base64');
  const yjsUpdate = extractYjsUpdate(new Uint8Array(raw));
  if (!yjsUpdate) return false;

  Y.applyUpdate(doc, yjsUpdate);
  return true;
}

/** Extract the full text from a Y.Doc */
export function extractText(doc: Y.Doc): string {
  return doc.getText(TEXT_KEY).toString();
}

/** Create a Y.Doc seeded with initial text content */
export function createDocWithContent(content: string): Y.Doc {
  const doc = new Y.Doc();
  if (content) {
    doc.getText(TEXT_KEY).insert(0, content);
  }
  return doc;
}

/** Encode a Y.Doc's full state as a base64 string */
export function encodeDocState(doc: Y.Doc): string {
  const state = Y.encodeStateAsUpdate(doc);
  return Buffer.from(state).toString('base64');
}

/**
 * LRU cache for Y.Doc instances, keyed by document ID.
 * Keeps hot documents in memory to avoid re-creating on every store call.
 */
export class DocCache {
  private _cache = new Map<string, Y.Doc>();
  private _maxSize: number;

  constructor(maxSize = 1000) {
    this._maxSize = maxSize;
  }

  get(documentId: string): Y.Doc | undefined {
    const doc = this._cache.get(documentId);
    if (doc) {
      // Move to end (most recently used)
      this._cache.delete(documentId);
      this._cache.set(documentId, doc);
    }
    return doc;
  }

  set(documentId: string, doc: Y.Doc): void {
    if (this._cache.has(documentId)) {
      this._cache.delete(documentId);
    } else if (this._cache.size >= this._maxSize) {
      // Evict least recently used (first entry)
      const firstKey = this._cache.keys().next().value!;
      const evicted = this._cache.get(firstKey);
      evicted?.destroy();
      this._cache.delete(firstKey);
    }
    this._cache.set(documentId, doc);
  }

  delete(documentId: string): void {
    const doc = this._cache.get(documentId);
    doc?.destroy();
    this._cache.delete(documentId);
  }

  clear(): void {
    for (const doc of this._cache.values()) {
      doc.destroy();
    }
    this._cache.clear();
  }

  get size(): number {
    return this._cache.size;
  }
}
