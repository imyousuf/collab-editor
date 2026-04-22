/**
 * Shared CodeMirror editor setup used by all source-mode bindings.
 * This is NOT an IEditorBinding — it's an internal building block.
 */
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { createBlameExtensions, setBlameData } from '../collab/blame-cm-extension.js';
import type { BlameSegment } from '../collab/blame-engine.js';
import {
  createCommentCmExtensions,
  setCommentCmData,
} from '../collab/comment-cm-extension.js';
import type {
  CommentThread,
  SuggestionOverlayRegion,
} from '../interfaces/comments.js';
import type { PendingSuggestOverlay } from '../interfaces/suggest.js';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { basicSetup } from 'codemirror';
import { yCollab } from 'y-codemirror.next';
import type { CollaborationContext } from '../interfaces/editor-binding.js';
import { cssVarTheme } from './_cm-theme.js';

export interface SourceEditorOptions {
  language: string;
  readonly: boolean;
  theme: 'light' | 'dark';
}

function getLanguageExtension(lang: string) {
  switch (lang) {
    case 'html': return html();
    case 'javascript':
    case 'jsx': return javascript({ jsx: true });
    case 'typescript':
    case 'tsx': return javascript({ jsx: true, typescript: true });
    case 'python': return python();
    case 'markdown':
    default: return markdown();
  }
}

/**
 * Creates and manages a CodeMirror 6 editor instance.
 * Handles yCollab binding, language switching, and content access.
 */
export class SourceEditorInstance {
  private _view: EditorView;
  private _languageCompartment = new Compartment();
  private _readonlyCompartment = new Compartment();
  private _blameCompartment = new Compartment();
  private _commentsCompartment = new Compartment();
  private _blameActive = false;
  private _commentsActive = false;
  private _updateCallbacks: Set<(content: string) => void> = new Set();
  private _lastCommentState: {
    threads: CommentThread[];
    overlays: SuggestionOverlayRegion[];
    pending: PendingSuggestOverlay | null;
    activeThreadId: string | null;
  } = { threads: [], overlays: [], pending: null, activeThreadId: null };

  constructor(
    container: HTMLElement,
    options: SourceEditorOptions,
    collab?: CollaborationContext | null,
  ) {
    const collabExtensions = collab?.sharedText && collab?.awareness
      ? [yCollab(collab.sharedText, collab.awareness)]
      : [];

    const themeExtensions = options.theme === 'dark' ? [oneDark] : [];

    const state = EditorState.create({
      extensions: [
        basicSetup,
        keymap.of([...defaultKeymap, indentWithTab]),
        EditorView.lineWrapping,
        this._languageCompartment.of(getLanguageExtension(options.language)),
        this._readonlyCompartment.of(EditorState.readOnly.of(options.readonly)),
        ...collabExtensions,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const content = update.state.doc.toString();
            this._updateCallbacks.forEach(cb => cb(content));
          }
        }),
        ...themeExtensions,
        cssVarTheme,
        this._blameCompartment.of([]),
        this._commentsCompartment.of([]),
      ],
    });

    this._view = new EditorView({ state, parent: container });
  }

  get view(): EditorView {
    return this._view;
  }

  getContent(): string {
    return this._view.state.doc.toString();
  }

  setContent(text: string): void {
    this._view.dispatch({
      changes: { from: 0, to: this._view.state.doc.length, insert: text },
    });
  }

  setLanguage(language: string): void {
    this._view.dispatch({
      effects: this._languageCompartment.reconfigure(getLanguageExtension(language)),
    });
  }

  setReadonly(readonly: boolean): void {
    this._view.dispatch({
      effects: this._readonlyCompartment.reconfigure(EditorState.readOnly.of(readonly)),
    });
  }

  onUpdate(callback: (content: string) => void): () => void {
    this._updateCallbacks.add(callback);
    return () => this._updateCallbacks.delete(callback);
  }

  enableBlame(segments: BlameSegment[]): void {
    if (!this._blameActive) {
      this._view.dispatch({
        effects: this._blameCompartment.reconfigure(createBlameExtensions()),
      });
      this._blameActive = true;
    }
    this._view.dispatch({ effects: setBlameData.of(segments) });
  }

  disableBlame(): void {
    if (this._blameActive) {
      this._view.dispatch({
        effects: this._blameCompartment.reconfigure([]),
      });
      this._blameActive = false;
    }
  }

  updateBlame(segments: BlameSegment[]): void {
    if (this._blameActive) {
      this._view.dispatch({ effects: setBlameData.of(segments) });
    }
  }

  enableComments(): void {
    if (this._commentsActive) return;
    this._view.dispatch({
      effects: this._commentsCompartment.reconfigure(createCommentCmExtensions()),
    });
    this._commentsActive = true;
    // Re-push whatever state we had so decorations appear immediately.
    this._pushCommentState();
  }

  disableComments(): void {
    if (!this._commentsActive) return;
    this._view.dispatch({
      effects: this._commentsCompartment.reconfigure([]),
    });
    this._commentsActive = false;
  }

  updateComments(
    threads: CommentThread[],
    overlays: SuggestionOverlayRegion[],
    activeThreadId: string | null,
    pending: PendingSuggestOverlay | null = null,
  ): void {
    this._lastCommentState = { threads, overlays, pending, activeThreadId };
    if (this._commentsActive) this._pushCommentState();
  }

  private _pushCommentState(): void {
    this._view.dispatch({
      effects: setCommentCmData.of(this._lastCommentState),
    });
  }

  destroy(): void {
    this._view.destroy();
    this._updateCallbacks.clear();
  }
}
