/**
 * Bidirectional sync between Tiptap editor and Y.Text.
 *
 * The Y.Text is the canonical CRDT type. Both CodeMirror (via yCollab)
 * and Tiptap (via this sync layer) read/write to the same Y.Text.
 *
 * When the Tiptap editor changes → serialize to text → write to Y.Text
 * When the Y.Text changes (remote) → parse text → update Tiptap
 */
import type { Editor } from '@tiptap/core';
import * as Y from 'yjs';

export class TextSync {
  private editor: Editor;
  private ytext: Y.Text;
  private mimeType: string;
  private updating = false; // prevents re-entrant updates
  private editorHandler: (() => void) | null = null;
  private ytextObserver: ((event: Y.YTextEvent) => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(editor: Editor, ytext: Y.Text, mimeType: string) {
    this.editor = editor;
    this.ytext = ytext;
    this.mimeType = mimeType;

    // Listen for Tiptap changes → serialize to Y.Text
    this.editorHandler = () => {
      if (this.updating) return;
      this.updating = true;

      // Debounce to avoid flooding Y.Text with updates on every keystroke
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.syncEditorToYText();
        this.updating = false;
      }, 50);
    };
    this.editor.on('update', this.editorHandler);

    // Listen for Y.Text changes (remote) → parse into Tiptap
    this.ytextObserver = (event) => {
      if (this.updating) return;
      // Only react to remote changes (not our own writes)
      if (event.transaction.local) return;
      this.updating = true;
      this.syncYTextToEditor();
      this.updating = false;
    };
    this.ytext.observe(this.ytextObserver);
  }

  private syncEditorToYText(): void {
    let content: string;
    if (this.mimeType === 'text/markdown') {
      content = this.editor.getMarkdown?.() ?? this.editor.getHTML();
    } else {
      content = this.editor.getHTML();
    }

    const current = this.ytext.toString();
    if (content === current) return;

    this.ytext.doc?.transact(() => {
      this.ytext.delete(0, this.ytext.length);
      this.ytext.insert(0, content);
    }, this); // pass `this` as origin to identify our own transactions
  }

  private syncYTextToEditor(): void {
    const text = this.ytext.toString();
    if (!text) return;

    if (this.mimeType === 'text/markdown') {
      this.editor.commands.setContent(text, { contentType: 'markdown' } as any);
    } else {
      this.editor.commands.setContent(text);
    }
  }

  /**
   * Load initial content into both Y.Text and the editor.
   * Only sets content if Y.Text is empty (avoids overwriting collaborative state).
   */
  loadInitialContent(content: string): void {
    if (this.ytext.length > 0) {
      // Y.Text already has content from a peer — render it in Tiptap
      this.updating = true;
      this.syncYTextToEditor();
      this.updating = false;
      return;
    }

    // Y.Text is empty — set the seed content
    this.updating = true;
    this.ytext.doc?.transact(() => {
      this.ytext.insert(0, content);
    }, this);

    if (this.mimeType === 'text/markdown') {
      this.editor.commands.setContent(content, { contentType: 'markdown' } as any);
    } else {
      this.editor.commands.setContent(content);
    }
    this.updating = false;
  }

  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.editorHandler) {
      this.editor.off('update', this.editorHandler);
    }
    if (this.ytextObserver) {
      this.ytext.unobserve(this.ytextObserver);
    }
  }
}
