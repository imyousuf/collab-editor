import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TextSync } from '../collab/text-sync.js';
import type { CollabProvider } from '../collab/yjs-provider.js';
import type { EditorFormat, EditorTheme } from '../types.js';

export interface WysiwygEditorOptions {
  placeholder: string;
  readonly: boolean;
  theme: EditorTheme;
}

/**
 * Create a WysiwygEditor. The editor uses StarterKit + Markdown only.
 * Collaboration is handled via TextSync (bidirectional Y.Text ↔ Tiptap sync)
 * instead of the Tiptap Collaboration extension.
 */
export function createWysiwygEditor(
  container: HTMLElement,
  options: WysiwygEditorOptions,
  collabProvider?: CollabProvider | null,
  mimeType?: string,
): WysiwygEditor {
  const editor = new Editor({
    element: container,
    extensions: [StarterKit, Markdown],
    editable: !options.readonly,
  });

  let textSync: TextSync | null = null;
  if (collabProvider) {
    textSync = new TextSync(editor, collabProvider.sourceText, mimeType ?? 'text/html');
  }

  return new WysiwygEditor(editor, textSync, mimeType);
}

export class WysiwygEditor {
  readonly editor: Editor;
  private _textSync: TextSync | null;
  private _mimeType: string;

  constructor(editor: Editor, textSync: TextSync | null, mimeType?: string) {
    this.editor = editor;
    this._textSync = textSync;
    this._mimeType = mimeType ?? 'text/html';
  }

  getContent(format: EditorFormat = 'html'): string {
    if (format === 'markdown') {
      return this.editor.getMarkdown?.() ?? this.editor.getHTML();
    }
    return this.editor.getHTML();
  }

  /**
   * Set content. If TextSync is active, uses loadInitialContent
   * which respects existing collaborative state.
   */
  setContent(content: string, mimeType?: string, force = false): void {
    const mime = mimeType ?? this._mimeType;

    if (this._textSync && !force) {
      this._textSync.loadInitialContent(content);
      return;
    }

    // Direct set (no collaboration or force mode)
    if (mime === 'text/markdown') {
      this.editor.commands.setContent(content, { contentType: 'markdown' } as any);
    } else {
      this.editor.commands.setContent(content);
    }
  }

  setReadonly(readonly: boolean): void {
    this.editor.setEditable(!readonly);
  }

  destroy(): void {
    this._textSync?.destroy();
    this.editor.destroy();
  }
}
