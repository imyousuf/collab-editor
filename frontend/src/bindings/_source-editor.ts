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
import * as Y from 'yjs';
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
  // Wraps yCollab(ytext, awareness) so Suggest Mode can swap the bound
  // Y.Text at runtime without recreating the EditorView.
  private _collabCompartment = new Compartment();
  private _awareness: any = null;
  private _ytext: Y.Text | null = null;
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
    if (collab?.sharedText && collab?.awareness) {
      this._ytext = collab.sharedText;
      this._awareness = collab.awareness;
    }
    const collabExtension = this._ytext && this._awareness
      ? yCollab(this._ytext, this._awareness)
      : [];

    const themeExtensions = options.theme === 'dark' ? [oneDark] : [];

    const state = EditorState.create({
      extensions: [
        basicSetup,
        keymap.of([...defaultKeymap, indentWithTab]),
        EditorView.lineWrapping,
        this._languageCompartment.of(getLanguageExtension(options.language)),
        this._readonlyCompartment.of(EditorState.readOnly.of(options.readonly)),
        this._collabCompartment.of(collabExtension),
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

  /**
   * Swap the Y.Text this editor's yCollab is bound to. Used by Suggest
   * Mode to redirect writes into a per-user buffer Y.Doc. Requires a
   * collab context to have been supplied at mount — rebinding on a
   * non-collab editor is a no-op.
   *
   * Important: y-codemirror.next's `ySync` is a module-level ViewPlugin
   * constant that captures the Y.Text in its constructor. A single
   * Compartment.reconfigure doesn't force the plugin to re-construct
   * because the plugin reference is identical across yCollab() calls.
   * We dispatch TWO reconfigures — first to `[]` (tears down the old
   * ySync instance so its Y.Text observer is detached), then to the new
   * `yCollab(newText, awareness)` (constructs a fresh ySync bound to
   * the new Y.Text).
   */
  rebindSharedText(newText: Y.Text): void {
    if (!this._awareness) return;
    if (newText === this._ytext) return;
    this._ytext = newText;

    // Step 1: detach yCollab. Any dispatches between here and step 3
    // produce no CRDT side-effects (nothing is bound to send updates).
    this._view.dispatch({
      effects: this._collabCompartment.reconfigure([]),
    });

    // Step 2: replace the CodeMirror doc to match the new Y.Text.
    //
    // Without this, yCollab's ySync — which only observes *future*
    // changes — leaves the editor showing whatever was in CodeMirror
    // before the rebind. In the syncDoc/editorDoc split, that manifests
    // as a Suggest-Mode submit reverting WYSIWYG correctly (TextBinding
    // is diff-based) but leaving the source editor stuck on the
    // discarded drafts. Doing this while yCollab is detached keeps the
    // replace local — no ops flow to the new Y.Text.
    const currentDoc = this._view.state.doc.toString();
    const newContent = newText.toString();
    if (currentDoc !== newContent) {
      this._view.dispatch({
        changes: { from: 0, to: this._view.state.doc.length, insert: newContent },
      });
    }

    // Step 3: rebind. yCollab reconstructs around newText; since the
    // editor doc now matches newText, the initial observation is a
    // no-op.
    this._view.dispatch({
      effects: this._collabCompartment.reconfigure(yCollab(newText, this._awareness)),
    });
  }

  /** Current Y.Text target — exposed for tests. */
  get ytext(): Y.Text | null {
    return this._ytext;
  }

  onUpdate(callback: (content: string) => void): () => void {
    this._updateCallbacks.add(callback);
    return () => this._updateCallbacks.delete(callback);
  }

  // ctx is unused in source mode — Y.Text offsets map 1:1 to the
  // source editor's doc positions. Accepting it keeps the signature
  // aligned with the WYSIWYG editor for shared binding code paths.
  enableBlame(segments: BlameSegment[], _ctx?: unknown): void {
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

  updateBlame(segments: BlameSegment[], _ctx?: unknown): void {
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

  // ytext is unused in source mode — Y.Text offsets map 1:1 to
  // CodeMirror positions. The parameter is accepted to keep the
  // signature aligned with the WYSIWYG instance for shared binding code.
  updateComments(
    threads: CommentThread[],
    overlays: SuggestionOverlayRegion[],
    activeThreadId: string | null,
    pending: PendingSuggestOverlay | null = null,
    _ytext?: unknown,
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
