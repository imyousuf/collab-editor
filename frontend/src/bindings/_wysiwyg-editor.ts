/**
 * Shared Tiptap editor setup used by WYSIWYG-mode bindings.
 * This is NOT an IEditorBinding — it's an internal building block.
 */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import type { IContentHandler } from '../interfaces/content-handler.js';
import { createBlamePlugin, blamePluginKey } from '../collab/blame-tiptap-plugin.js';
import type { BlameSegment } from '../collab/blame-engine.js';

export interface WysiwygEditorOptions {
  readonly: boolean;
  theme: 'light' | 'dark';
  placeholder?: string;
}

/**
 * Creates and manages a Tiptap editor instance.
 * Content is set/retrieved via IContentHandler for format-aware parsing.
 */
export class WysiwygEditorInstance {
  private _editor: Editor;
  private _contentHandler: IContentHandler;
  private _updateCallbacks: Set<(content: string) => void> = new Set();
  private _ready: Promise<void>;
  private _blameActive = false;

  constructor(
    container: HTMLElement,
    contentHandler: IContentHandler,
    options: WysiwygEditorOptions,
  ) {
    this._contentHandler = contentHandler;

    this._editor = new Editor({
      element: container,
      extensions: [StarterKit, Markdown],
      editable: !options.readonly,
    });

    // Wait for Tiptap to be fully initialized
    this._ready = new Promise<void>((resolve) => {
      // Tiptap v3 fires 'create' asynchronously via setTimeout(0)
      if ((this._editor as any).isInitialized) {
        resolve();
      } else {
        this._editor.on('create', () => resolve());
      }
    });

    this._editor.on('update', () => {
      const content = this.getContent();
      this._updateCallbacks.forEach(cb => cb(content));
    });
  }

  get editor(): Editor {
    return this._editor;
  }

  /** Wait for the editor to be fully mounted and interactive */
  async whenReady(): Promise<void> {
    return this._ready;
  }

  getContent(): string {
    const type = this._contentHandler.parse('').type;
    if (type === 'markdown') {
      return this._editor.getMarkdown?.() ?? this._editor.getHTML();
    }
    return this._editor.getHTML();
  }

  setContent(text: string): void {
    const parsed = this._contentHandler.parse(text);
    if (parsed.type === 'markdown') {
      this._editor.commands.setContent(text, { contentType: 'markdown' } as any);
    } else {
      this._editor.commands.setContent(text);
    }
  }

  setReadonly(readonly: boolean): void {
    this._editor.setEditable(!readonly);
  }

  onUpdate(callback: (content: string) => void): () => void {
    this._updateCallbacks.add(callback);
    return () => this._updateCallbacks.delete(callback);
  }

  enableBlame(segments: BlameSegment[]): void {
    if (!this._blameActive) {
      // Register the blame ProseMirror plugin
      this._editor.registerPlugin(createBlamePlugin());
      this._blameActive = true;
    }
    // Push segments via transaction meta
    const { tr } = this._editor.state;
    tr.setMeta(blamePluginKey, segments);
    this._editor.view.dispatch(tr);
  }

  disableBlame(): void {
    if (this._blameActive) {
      // Clear decorations then unregister
      const { tr } = this._editor.state;
      tr.setMeta(blamePluginKey, null);
      this._editor.view.dispatch(tr);
      this._editor.unregisterPlugin(blamePluginKey);
      this._blameActive = false;
    }
  }

  updateBlame(segments: BlameSegment[]): void {
    if (this._blameActive) {
      const { tr } = this._editor.state;
      tr.setMeta(blamePluginKey, segments);
      this._editor.view.dispatch(tr);
    }
  }

  destroy(): void {
    this._editor.destroy();
    this._updateCallbacks.clear();
  }
}
