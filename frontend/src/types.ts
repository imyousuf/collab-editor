export type EditorMode = 'wysiwyg' | 'source';
export type EditorFormat = 'markdown' | 'html';
export type EditorTheme = 'light' | 'dark';

// MIME types that support WYSIWYG editing (rich text rendering)
export const WYSIWYG_MIME_TYPES = new Set([
  'text/markdown',
  'text/html',
]);

// Map MIME types to CodeMirror language identifiers
export const MIME_TO_LANGUAGE: Record<string, string> = {
  'text/markdown': 'markdown',
  'text/html': 'html',
  'text/x-python': 'python',
  'text/javascript': 'javascript',
  'text/jsx': 'javascript',
  'text/typescript': 'javascript',
  'text/tsx': 'javascript',
  'text/css': 'html',
  'text/yaml': 'markdown',
  'text/plain': 'markdown',
  'application/json': 'javascript',
};

// Map MIME types to EditorFormat for serialization
export const MIME_TO_FORMAT: Record<string, EditorFormat> = {
  'text/markdown': 'markdown',
  'text/html': 'html',
};

export function supportsWysiwyg(mimeType: string): boolean {
  return WYSIWYG_MIME_TYPES.has(mimeType);
}

export function getLanguageForMime(mimeType: string): string {
  return MIME_TO_LANGUAGE[mimeType] ?? 'markdown';
}

export function getFormatForMime(mimeType: string): EditorFormat {
  return MIME_TO_FORMAT[mimeType] ?? 'html';
}

export interface CollaborationConfig {
  enabled: boolean;
  roomName: string;
  providerUrl: string;
  user: {
    name: string;
    color: string;
  };
}
