import type { Editor } from '@tiptap/core';
import type { CollabProvider } from './yjs-provider.js';
import type { EditorFormat } from '../types.js';

export function syncWysiwygToSource(
  editor: Editor,
  collabProvider: CollabProvider,
  format: EditorFormat,
): void {
  const text = format === 'markdown' ? editor.getHTML() : editor.getHTML();
  collabProvider.ydoc.transact(() => {
    collabProvider.sourceText.delete(0, collabProvider.sourceText.length);
    collabProvider.sourceText.insert(0, text);
  });
  collabProvider.meta.set('activeView', 'source');
}

export function syncSourceToWysiwyg(
  editor: Editor,
  collabProvider: CollabProvider,
  _format: EditorFormat,
): void {
  const text = collabProvider.sourceText.toString();
  editor.commands.setContent(text);
  collabProvider.meta.set('activeView', 'wysiwyg');
}
