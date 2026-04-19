import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import type { CollabProvider } from '../collab/yjs-provider.js';
import type { EditorFormat, EditorTheme } from '../types.js';

export class WysiwygEditor {
  readonly editor: Editor;

  constructor(
    container: HTMLElement,
    collabProvider: CollabProvider | null,
    options: { placeholder: string; readonly: boolean; theme: EditorTheme },
  ) {
    this.editor = new Editor({
      element: container,
      extensions: [
        StarterKit,
        Markdown,
      ],
      editable: !options.readonly,
    });
  }

  async enableCollaboration(collabProvider: CollabProvider): Promise<void> {
    if (!collabProvider?.provider || !collabProvider.ydoc) return;

    const [{ default: Collaboration }, { default: CollaborationCursor }] = await Promise.all([
      import('@tiptap/extension-collaboration'),
      import('@tiptap/extension-collaboration-cursor'),
    ]);

    const extensions: any[] = [
      StarterKit.configure({ history: false } as any),
      Markdown,
      Collaboration.configure({ document: collabProvider.ydoc }),
    ];

    if (collabProvider.awareness) {
      extensions.push(
        CollaborationCursor.configure({ provider: collabProvider.provider }),
      );
    }

    const el = this.editor.options.element as HTMLElement;
    const editable = this.editor.isEditable;
    this.editor.destroy();

    if (el) {
      el.innerHTML = '';
    }

    (this as any).editor = new Editor({
      element: el,
      extensions,
      editable,
    });
  }

  getContent(format: EditorFormat = 'html'): string {
    if (format === 'markdown') {
      return this.editor.getMarkdown?.() ?? this.editor.getHTML();
    }
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
