import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import type { CollabProvider } from '../collab/yjs-provider.js';
import type { EditorFormat, EditorTheme } from '../types.js';

export interface WysiwygEditorOptions {
  placeholder: string;
  readonly: boolean;
  theme: EditorTheme;
}

/**
 * Create a WysiwygEditor. If a CollabProvider is given, the Collaboration
 * and CollaborationCursor extensions are dynamically imported and included
 * from the start — avoiding the destroy/recreate cycle.
 */
export async function createWysiwygEditor(
  container: HTMLElement,
  options: WysiwygEditorOptions,
  collabProvider?: CollabProvider | null,
): Promise<WysiwygEditor> {
  const extensions: any[] = [Markdown];

  if (collabProvider?.provider && collabProvider.ydoc) {
    // Dynamic import avoids module-level side effects that break prod bundling
    const [{ default: Collaboration }, { default: CollaborationCursor }] = await Promise.all([
      import('@tiptap/extension-collaboration'),
      import('@tiptap/extension-collaboration-cursor'),
    ]);

    extensions.push(
      StarterKit.configure({ history: false } as any),
      Collaboration.configure({ fragment: collabProvider.content }),
    );
    // CollaborationCursor disabled for now — causes reconfigure crash
    // if (collabProvider.awareness) {
    //   extensions.push(
    //     CollaborationCursor.configure({ provider: collabProvider.provider }),
    //   );
    // }
  } else {
    extensions.push(StarterKit);
  }

  const editor = new Editor({
    element: container,
    extensions,
    editable: !options.readonly,
  });

  return new WysiwygEditor(editor);
}

export class WysiwygEditor {
  constructor(readonly editor: Editor) {}

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
