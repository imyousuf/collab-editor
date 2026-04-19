import type { EditorFormat, EditorMode } from './types.js';

export class EditorChangeEvent extends CustomEvent<{
  value: string;
  format: EditorFormat;
  mode: EditorMode;
}> {
  constructor(detail: { value: string; format: EditorFormat; mode: EditorMode }) {
    super('editor-change', { detail, bubbles: true, composed: true });
  }
}

export class ModeChangeEvent extends CustomEvent<{
  mode: EditorMode;
  previousMode: EditorMode;
}> {
  constructor(detail: { mode: EditorMode; previousMode: EditorMode }) {
    super('mode-change', { detail, bubbles: true, composed: true });
  }
}

export class EditorSaveEvent extends CustomEvent<{
  value: string;
  format: EditorFormat;
}> {
  constructor(detail: { value: string; format: EditorFormat }) {
    super('editor-save', { detail, bubbles: true, composed: true });
  }
}

export class CollabStatusEvent extends CustomEvent<{
  status: 'connecting' | 'connected' | 'disconnected';
}> {
  constructor(detail: { status: 'connecting' | 'connected' | 'disconnected' }) {
    super('collab-status', { detail, bubbles: true, composed: true });
  }
}
