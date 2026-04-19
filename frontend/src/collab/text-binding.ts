/**
 * Y.Text ↔ Tiptap bidirectional sync with diff-based updates.
 *
 * Fixes from the old TextSync:
 * 1. Separate suppression flags — debounce doesn't block remote changes
 * 2. Symbol origin — distinguishes our transactions from remote ones
 * 3. applyStringDiff — minimal CRDT operations, preserves cursor positions
 */
import type { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import type { IContentHandler } from '../interfaces/content-handler.js';

export class TextBinding {
  private _editor: Editor;
  private _ytext: Y.Text;
  private _handler: IContentHandler;
  private _editorHandler: (() => void) | null = null;
  private _ytextObserver: ((event: Y.YTextEvent) => void) | null = null;
  private _syncTimer: ReturnType<typeof setTimeout> | null = null;
  private _suppressEditorToYText = false;
  private _suppressYTextToEditor = false;
  private readonly _origin = Symbol('TextBinding');

  constructor(editor: Editor, ytext: Y.Text, handler: IContentHandler) {
    this._editor = editor;
    this._ytext = ytext;
    this._handler = handler;

    // If Y.Text already has content, render it in Tiptap immediately
    if (ytext.length > 0) {
      this._applyYTextToEditor();
    }

    // Tiptap → Y.Text: debounced, does NOT block Y.Text → Tiptap
    this._editorHandler = () => {
      if (this._suppressEditorToYText) return;

      if (this._syncTimer) clearTimeout(this._syncTimer);
      this._syncTimer = setTimeout(() => {
        this._applyEditorToYText();
      }, 100);
    };
    this._editor.on('update', this._editorHandler);

    // Y.Text → Tiptap: immediate for remote changes
    this._ytextObserver = (event) => {
      if (this._suppressYTextToEditor) return;
      if (event.transaction.origin === this._origin) return;
      this._applyYTextToEditor();
    };
    this._ytext.observe(this._ytextObserver);
  }

  /**
   * Load initial content. Only writes to Y.Text if it's empty.
   */
  loadInitialContent(text: string): void {
    if (this._ytext.length > 0) {
      this._applyYTextToEditor();
      return;
    }

    this._suppressYTextToEditor = true;
    this._ytext.doc?.transact(() => {
      this._ytext.insert(0, text);
    }, this._origin);
    this._suppressYTextToEditor = false;

    this._applyContentToEditor(text);
  }

  private _applyEditorToYText(): void {
    const serialized = this._getSerializedContent();
    const current = this._ytext.toString();

    if (serialized === current) return;

    this._suppressYTextToEditor = true;
    this._ytext.doc?.transact(() => {
      applyStringDiff(this._ytext, current, serialized);
    }, this._origin);
    this._suppressYTextToEditor = false;
  }

  private _applyYTextToEditor(): void {
    const text = this._ytext.toString();
    if (!text && this._ytext.length === 0) return;

    this._suppressEditorToYText = true;
    this._applyContentToEditor(text);
    this._suppressEditorToYText = false;
  }

  private _applyContentToEditor(text: string): void {
    const parsed = this._handler.parse(text);
    if (parsed.type === 'markdown') {
      this._editor.commands.setContent(text, { contentType: 'markdown' } as any);
    } else {
      this._editor.commands.setContent(text);
    }
  }

  private _getSerializedContent(): string {
    const type = this._handler.parse('').type;
    if (type === 'markdown') {
      return this._editor.getMarkdown?.() ?? this._editor.getHTML();
    }
    return this._editor.getHTML();
  }

  destroy(): void {
    if (this._syncTimer) clearTimeout(this._syncTimer);
    if (this._editorHandler) {
      this._editor.off('update', this._editorHandler);
    }
    if (this._ytextObserver) {
      this._ytext.unobserve(this._ytextObserver);
    }
  }
}

/**
 * Apply a string diff to a Y.Text instance using common prefix/suffix.
 * Only deletes and inserts the changed region — preserves CRDT cursors.
 */
export function applyStringDiff(ytext: Y.Text, oldStr: string, newStr: string): void {
  let prefixLen = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (prefixLen < minLen && oldStr[prefixLen] === newStr[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < (minLen - prefixLen) &&
    oldStr[oldStr.length - 1 - suffixLen] === newStr[newStr.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const deleteFrom = prefixLen;
  const deleteCount = oldStr.length - prefixLen - suffixLen;
  const insertEnd = suffixLen > 0 ? newStr.length - suffixLen : newStr.length;
  const insertText = newStr.slice(prefixLen, insertEnd);

  if (deleteCount > 0) {
    ytext.delete(deleteFrom, deleteCount);
  }
  if (insertText.length > 0) {
    ytext.insert(deleteFrom, insertText);
  }
}
