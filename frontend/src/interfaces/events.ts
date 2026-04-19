import type { EditorMode } from './editor-binding.js';
import type { CollabStatus } from './collaboration.js';

// --- Event detail types ---

export interface ContentChangeDetail {
  value: string;
  format: string;
  mode: EditorMode;
}

export interface ModeChangeDetail {
  mode: EditorMode;
  previousMode: EditorMode;
}

export interface SaveDetail {
  value: string;
  format: string;
}

export interface CollabStatusDetail {
  status: CollabStatus;
}

export interface RemoteChangeDetail {
  peerId: string;
  changeType: 'insert' | 'delete' | 'update';
}

export interface BeforeModeChangeDetail {
  mode: EditorMode;
  previousMode: EditorMode;
}

// --- Typed callback interface ---

/**
 * Typed event subscription interface.
 * Each method returns an unsubscribe function.
 */
export interface IEditorEventEmitter {
  onContentChange(callback: (detail: ContentChangeDetail) => void): () => void;
  onModeChange(callback: (detail: ModeChangeDetail) => void): () => void;
  onSave(callback: (detail: SaveDetail) => void): () => void;
  onCollabStatus(callback: (detail: CollabStatusDetail) => void): () => void;
  onRemoteChange(callback: (detail: RemoteChangeDetail) => void): () => void;
  onBeforeModeChange(callback: (detail: BeforeModeChangeDetail) => boolean): () => void;
}

// --- DOM CustomEvent subclasses (for Lit element compatibility) ---

export class EditorChangeEvent extends CustomEvent<ContentChangeDetail> {
  constructor(detail: ContentChangeDetail) {
    super('editor-change', { detail, bubbles: true, composed: true });
  }
}

export class ModeChangeEvent extends CustomEvent<ModeChangeDetail> {
  constructor(detail: ModeChangeDetail) {
    super('mode-change', { detail, bubbles: true, composed: true });
  }
}

export class EditorSaveEvent extends CustomEvent<SaveDetail> {
  constructor(detail: SaveDetail) {
    super('editor-save', { detail, bubbles: true, composed: true });
  }
}

export class CollabStatusEvent extends CustomEvent<CollabStatusDetail> {
  constructor(detail: CollabStatusDetail) {
    super('collab-status', { detail, bubbles: true, composed: true });
  }
}

export class RemoteChangeEvent extends CustomEvent<RemoteChangeDetail> {
  constructor(detail: RemoteChangeDetail) {
    super('remote-change', { detail, bubbles: true, composed: true });
  }
}
