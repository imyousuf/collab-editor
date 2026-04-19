export type EditorMode = 'wysiwyg' | 'source' | 'preview';
export type EditorFormat = 'markdown' | 'html';
export type EditorTheme = 'light' | 'dark';

// Capability that the alternate (non-source) mode provides
export type AlternateCapability = 'wysiwyg' | 'preview' | 'none';

// MIME types that support WYSIWYG editing (rich text rendering)
export const WYSIWYG_MIME_TYPES = new Set([
  'text/markdown',
  'text/html',
]);

// MIME types that support live preview (compiled/rendered output)
export const PREVIEW_MIME_TYPES = new Set([
  'text/jsx',
  'text/tsx',
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

export function getAlternateCapability(mimeType: string): AlternateCapability {
  if (WYSIWYG_MIME_TYPES.has(mimeType)) return 'wysiwyg';
  if (PREVIEW_MIME_TYPES.has(mimeType)) return 'preview';
  return 'none';
}

export function supportsWysiwyg(mimeType: string): boolean {
  return WYSIWYG_MIME_TYPES.has(mimeType);
}

export function supportsPreview(mimeType: string): boolean {
  return PREVIEW_MIME_TYPES.has(mimeType);
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
