/**
 * Blame engine — dual-mode authorship attribution.
 *
 * Two independently configurable modes:
 * 1. **Live blame** — captures Yjs update events from activation. Stores in localStorage.
 *    Resets on page refresh or toggle-off. Editor remains editable.
 * 2. **Version blame** — passthrough of BlameSegment[] from SPI response.
 *    Read-only view.
 *
 * Color is NOT stored in segments — the frontend assigns colors deterministically
 * from a palette based on user_name.
 */

import * as Y from 'yjs';

export interface BlameSegment {
  start: number;
  end: number;
  userName: string;
}

/** Stored in localStorage for live blame event logging. */
interface LiveBlameEntry {
  userName: string;
  timestamp: number;
}

const PALETTE = [
  '#e06c75', '#61afef', '#98c379', '#d19a66', '#c678dd',
  '#56b6c2', '#e5c07b', '#be5046', '#528bff', '#7c8fa6',
  '#f5a623', '#50e3c2', '#b8e986', '#bd10e0', '#4a90d9',
];

const STORAGE_KEY_PREFIX = 'collab-blame:';

export class BlameEngine {
  private _ydoc: Y.Doc;
  private _documentId: string;
  private _observer: ((update: Uint8Array, origin: any, doc: Y.Doc) => void) | null = null;
  private _awareness: any = null;

  constructor(ydoc: Y.Doc, documentId: string) {
    this._ydoc = ydoc;
    this._documentId = documentId;
  }

  /** Set the awareness instance for reading user names from updates. */
  setAwareness(awareness: any): void {
    this._awareness = awareness;
  }

  // --- Live blame ---

  /** Start capturing Y.Doc update events and writing to localStorage. */
  startLiveBlame(): void {
    if (this._observer) return; // already started

    this._observer = (_update: Uint8Array, origin: any) => {
      const userName = this._resolveUserName(origin);
      const entry: LiveBlameEntry = {
        userName,
        timestamp: Date.now(),
      };

      const key = STORAGE_KEY_PREFIX + this._documentId;
      const existing = this._loadEntries();
      existing.push(entry);
      try {
        localStorage.setItem(key, JSON.stringify(existing));
      } catch {
        // Storage full — drop oldest entries and retry
        existing.splice(0, Math.floor(existing.length / 2));
        try {
          localStorage.setItem(key, JSON.stringify(existing));
        } catch {
          // Still full — give up silently
        }
      }
    };

    this._ydoc.on('update', this._observer);
  }

  /** Stop capturing and clear localStorage. */
  stopLiveBlame(): void {
    if (this._observer) {
      this._ydoc.off('update', this._observer);
      this._observer = null;
    }
    localStorage.removeItem(STORAGE_KEY_PREFIX + this._documentId);
  }

  /** Build blame segments from the live Y.Doc's current state. */
  getLiveBlame(): BlameSegment[] {
    // Build client-ID-to-user map from awareness (live connected users)
    const clientToUser = new Map<number, string>();
    if (this._awareness) {
      const states = this._awareness.getStates?.() as Map<number, any> | undefined;
      if (states) {
        states.forEach((state: any, clientId: number) => {
          if (state?.user?.name) {
            clientToUser.set(clientId, state.user.name);
          }
        });
      }
    }

    // Use the LIVE doc's Y.Text — its items have the correct client IDs
    const text = this._ydoc.getText('source');
    return this._extractBlameFromText(text, clientToUser);
  }

  // --- Version blame (passthrough) ---

  /** Convert SPI blame segments to our format (no-op, same interface). */
  static fromVersionBlame(segments: BlameSegment[]): BlameSegment[] {
    return segments;
  }

  // --- Color assignment ---

  /** Deterministic color assignment by userName. Same user always gets same color. */
  static assignColor(userName: string): string {
    let hash = 0;
    for (let i = 0; i < userName.length; i++) {
      hash = ((hash << 5) - hash + userName.charCodeAt(i)) | 0;
    }
    return PALETTE[Math.abs(hash) % PALETTE.length];
  }

  // --- Internal helpers ---

  private _resolveUserName(origin: any): string {
    // If origin is a string (e.g., user name passed directly)
    if (typeof origin === 'string') return origin;

    // Try to get from awareness
    if (this._awareness) {
      const localState = this._awareness.getLocalState?.();
      if (localState?.user?.name) return localState.user.name;
    }

    return 'unknown';
  }

  private _loadEntries(): LiveBlameEntry[] {
    const key = STORAGE_KEY_PREFIX + this._documentId;
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  private _extractBlameFromText(
    text: Y.Text,
    clientToUser: Map<number, string>,
  ): BlameSegment[] {
    const segments: BlameSegment[] = [];
    // Access internal Yjs items — this uses undocumented API
    let item = (text as any)._start;
    let offset = 0;

    while (item !== null) {
      if (!item.deleted && item.content) {
        const len = item.content.getLength();
        const clientId = item.id.client;
        const userName = clientToUser.get(clientId) ?? `user-${clientId}`;

        const last = segments[segments.length - 1];
        if (last && last.userName === userName && last.end === offset) {
          last.end += len;
        } else {
          segments.push({ start: offset, end: offset + len, userName });
        }
        offset += len;
      }
      item = item.right;
    }

    return segments;
  }
}

