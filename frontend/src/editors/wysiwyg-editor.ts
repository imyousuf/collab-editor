import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import type { CollabProvider } from '../collab/yjs-provider.js';
import type { EditorTheme } from '../types.js';

export class WysiwygEditor {
  readonly editor: Editor;

  constructor(
    container: HTMLElement,
    collabProvider: CollabProvider | null,
    options: { placeholder: string; readonly: boolean; theme: EditorTheme },
  ) {
    const extensions: any[] = [StarterKit];

    if (collabProvider?.provider && collabProvider.ydoc) {
      extensions.push(
        Collaboration.configure({ document: collabProvider.ydoc }),
      );
      if (collabProvider.awareness) {
        extensions.push(
          CollaborationCursor.configure({ provider: collabProvider.provider }),
        );
      }
    }

    this.editor = new Editor({
      element: container,
      extensions,
      editable: !options.readonly,
    });
  }

  getContent(): string {
    return this.editor.getHTML();
  }

  setContent(content: string): void {
    this.editor.commands.setContent(content);
  }

  setReadonly(readonly: boolean): void {
    this.editor.setEditable(!readonly);
  }

  destroy(): void {
    this.editor.destroy();
  }
}
