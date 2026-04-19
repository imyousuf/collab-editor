import type { IContentHandler, EditorContent } from '../interfaces/content-handler.js';

export class PlainTextContentHandler implements IContentHandler {
  readonly supportedMimeTypes = [
    'text/plain',
    'text/javascript',
    'text/typescript',
    'text/jsx',
    'text/tsx',
    'text/x-python',
    'text/css',
    'text/yaml',
    'text/x-go',
    'text/x-rust',
    'text/x-java',
    'application/json',
    'application/xml',
  ] as const;

  parse(text: string): EditorContent {
    return { type: 'text', content: text };
  }

  serialize(editorOutput: string): string {
    return editorOutput;
  }
}
