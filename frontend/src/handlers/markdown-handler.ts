import type { IContentHandler, EditorContent } from '../interfaces/content-handler.js';

export class MarkdownContentHandler implements IContentHandler {
  readonly supportedMimeTypes = ['text/markdown'] as const;

  parse(text: string): EditorContent {
    return { type: 'markdown', content: text };
  }

  serialize(editorOutput: string): string {
    return editorOutput;
  }
}
