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
import { findFormattingOverrides } from '../collab/pm-position-map.js';
import type { BlameContext } from '../interfaces/blame.js';
import {
  buildCommentMeta,
  commentPluginKey,
  createCommentPlugin,
} from '../collab/comment-tiptap-plugin.js';
import type {
  CommentThread,
  SuggestionOverlayRegion,
} from '../interfaces/comments.js';
import type { PendingSuggestOverlay } from '../interfaces/suggest.js';

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
  private _commentsActive = false;
  private _lastCommentState: {
    threads: CommentThread[];
    overlays: SuggestionOverlayRegion[];
    pending: PendingSuggestOverlay | null;
    activeThreadId: string | null;
    ytext?: import('yjs').Text;
  } = { threads: [], overlays: [], pending: null, activeThreadId: null };

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

  enableBlame(segments: BlameSegment[], ctx?: BlameContext): void {
    if (!this._blameActive) {
      // Register the blame ProseMirror plugin
      this._editor.registerPlugin(createBlamePlugin());
      this._blameActive = true;
    }
    this._pushBlame(segments, ctx);
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

  updateBlame(segments: BlameSegment[], ctx?: BlameContext): void {
    if (this._blameActive) {
      this._pushBlame(segments, ctx);
    }
  }

  /**
   * Compute formatting-authorship overrides (when a different user
   * wrapped someone else's text in a mark) and dispatch a meta
   * transaction that carries segments + overrides + ytext so the
   * plugin can build an accurate posMap for Markdown/HTML.
   */
  private _pushBlame(segments: BlameSegment[], ctx?: BlameContext): void {
    const overrides =
      ctx?.ytext && ctx?.clientToUser
        ? findFormattingOverrides(this._editor.state.doc, ctx.ytext, ctx.clientToUser)
        : [];
    const { tr } = this._editor.state;
    tr.setMeta(blamePluginKey, {
      segments,
      overrides,
      ytext: ctx?.ytext,
    });
    this._editor.view.dispatch(tr);
  }

  enableComments(): void {
    if (this._commentsActive) return;
    this._editor.registerPlugin(createCommentPlugin());
    this._commentsActive = true;
    this._pushCommentState();
  }

  disableComments(): void {
    if (!this._commentsActive) return;
    this._editor.unregisterPlugin(commentPluginKey);
    this._commentsActive = false;
  }

  updateComments(
    threads: CommentThread[],
    overlays: SuggestionOverlayRegion[],
    activeThreadId: string | null,
    pending: PendingSuggestOverlay | null = null,
    ytext?: import('yjs').Text,
  ): void {
    this._lastCommentState = { threads, overlays, pending, activeThreadId, ytext };
    if (this._commentsActive) this._pushCommentState();
  }

  private _pushCommentState(): void {
    const { tr } = this._editor.state;
    tr.setMeta(
      commentPluginKey,
      buildCommentMeta(
        this._lastCommentState.threads,
        this._lastCommentState.overlays,
        this._lastCommentState.activeThreadId,
        this._lastCommentState.pending,
        this._lastCommentState.ytext,
      ),
    );
    this._editor.view.dispatch(tr);
  }

  destroy(): void {
    this._editor.destroy();
    this._updateCallbacks.clear();
  }
}
