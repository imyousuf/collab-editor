import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { CollabProvider } from '../collab/yjs-provider.js';
import type { EditorTheme } from '../types.js';

export class WysiwygEditor {
  readonly editor: Editor;

  constructor(
    container: HTMLElement,
    collabProvider: CollabProvider | null,
    options: { placeholder: string; readonly: boolean; theme: EditorTheme },
  ) {
    // Start with StarterKit only — collaboration extensions are added
    // after construction via enableCollaboration() to avoid bundling
    // side-effects that break ProseMirror's plugin state initialization
    this.editor = new Editor({
      element: container,
      extensions: [StarterKit],
      editable: !options.readonly,
    });
  }

  async enableCollaboration(collabProvider: CollabProvider): Promise<void> {
    if (!collabProvider?.provider || !collabProvider.ydoc) return;

    const [{ default: Collaboration }, { default: CollaborationCursor }] = await Promise.all([
      import('@tiptap/extension-collaboration'),
      import('@tiptap/extension-collaboration-cursor'),
    ]);

    // Reconfigure the editor with collaboration extensions
    const extensions: any[] = [
      StarterKit.configure({ history: false } as any),
      Collaboration.configure({ document: collabProvider.ydoc }),
    ];

    if (collabProvider.awareness) {
      extensions.push(
        CollaborationCursor.configure({ provider: collabProvider.provider }),
      );
    }

    // Destroy and recreate with collaboration
    const el = this.editor.options.element as HTMLElement;
    const editable = this.editor.isEditable;
    this.editor.destroy();

    // Clear the container
    if (el) {
      el.innerHTML = '';
    }

    // Re-create with collaboration
    (this as any).editor = new Editor({
      element: el,
      extensions,
      editable,
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
