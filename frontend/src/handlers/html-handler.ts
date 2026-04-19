import type { IContentHandler, EditorContent } from '../interfaces/content-handler.js';

export class HtmlContentHandler implements IContentHandler {
  readonly supportedMimeTypes = ['text/html'] as const;

  parse(text: string): EditorContent {
    return { type: 'html', content: text };
  }

  serialize(editorOutput: string): string {
    return editorOutput;
  }
}
