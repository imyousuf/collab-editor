/**
 * Shared CodeMirror editor setup used by all source-mode bindings.
 * This is NOT an IEditorBinding — it's an internal building block.
 */
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { basicSetup } from 'codemirror';
import { yCollab } from 'y-codemirror.next';
import type { CollaborationContext } from '../interfaces/editor-binding.js';

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
  private _updateCallbacks: Set<(content: string) => void> = new Set();

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

  destroy(): void {
    this._view.destroy();
    this._updateCallbacks.clear();
  }
}
