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
import type { CollabProvider } from '../collab/yjs-provider.js';
import type { EditorTheme } from '../types.js';

function getLanguageExtension(lang: string) {
  switch (lang) {
    case 'html': return html();
    case 'javascript':
    case 'jsx': return javascript({ jsx: true });
    case 'python': return python();
    case 'markdown':
    default: return markdown();
  }
}

export class SourceEditor {
  readonly view: EditorView;
  private collabCompartment = new Compartment();
  private languageCompartment = new Compartment();
  private readonlyCompartment = new Compartment();
  private collabProvider: CollabProvider | null;

  constructor(
    container: HTMLElement,
    collabProvider: CollabProvider | null,
    options: { language: string; readonly: boolean; theme: EditorTheme },
  ) {
    this.collabProvider = collabProvider;

    const collabExtensions = collabProvider?.provider && collabProvider.awareness
      ? [yCollab(collabProvider.sourceText, collabProvider.awareness)]
      : [];

    const themeExtensions = options.theme === 'dark' ? [oneDark] : [];

    const state = EditorState.create({
      extensions: [
        basicSetup,
        keymap.of([...defaultKeymap, indentWithTab]),
        EditorView.lineWrapping,
        this.languageCompartment.of(getLanguageExtension(options.language)),
        this.collabCompartment.of(collabExtensions),
        this.readonlyCompartment.of(EditorState.readOnly.of(options.readonly)),
        ...themeExtensions,
      ],
    });

    this.view = new EditorView({
      state,
      parent: container,
    });
  }

  activate(): void {
    if (this.collabProvider?.provider && this.collabProvider.awareness) {
      this.view.dispatch({
        effects: this.collabCompartment.reconfigure([
          yCollab(this.collabProvider.sourceText, this.collabProvider.awareness),
        ]),
      });
    }
  }

  deactivate(): void {
    this.view.dispatch({
      effects: this.collabCompartment.reconfigure([]),
    });
  }

  setLanguage(language: string): void {
    this.view.dispatch({
      effects: this.languageCompartment.reconfigure(getLanguageExtension(language)),
    });
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  setContent(content: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: content },
    });
  }

  setReadonly(readonly: boolean): void {
    this.view.dispatch({
      effects: this.readonlyCompartment.reconfigure(EditorState.readOnly.of(readonly)),
    });
  }

  destroy(): void {
    this.view.destroy();
  }
}
