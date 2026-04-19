import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import type { EditorFormat, EditorTheme } from '../types.js';

export class WysiwygEditor {
  readonly editor: Editor;

  constructor(
    container: HTMLElement,
    options: { placeholder: string; readonly: boolean; theme: EditorTheme },
  ) {
    this.editor = new Editor({
      element: container,
      extensions: [StarterKit, Markdown],
      editable: !options.readonly,
    });
  }

  getContent(format: EditorFormat = 'html'): string {
    if (format === 'markdown') {
      return this.editor.getMarkdown?.() ?? this.editor.getHTML();
    }
    return this.editor.getHTML();
  }

  setContent(content: string, mimeType?: string): void {
    if (mimeType === 'text/markdown') {
      this.editor.commands.setContent(content, { contentType: 'markdown' } as any);
    } else {
      this.editor.commands.setContent(content);
    }
  }

  setReadonly(readonly: boolean): void {
    this.editor.setEditable(!readonly);
  }

  destroy(): void {
    this.editor.destroy();
  }
}
