/**
 * CodeMirror 6 comments extension.
 *
 * Mirrors comment-tiptap-plugin.ts but for source mode. Renders:
 *
 *   - Inline range marks for committed comment *and* suggestion anchors.
 *   - A gutter with per-line comment/suggestion indicators.
 *
 * Post syncDoc/editorDoc split: inline strikethrough + "after" widgets
 * are gone. Suggestions are surfaced via the comment panel, the
 * Suggestions list in the status bar (C10), and the non-intrusive
 * anchor highlight. Reviewers preview a suggestion by activating it,
 * which applies the diff to their local editorDoc (C9).
 *
 * Click handlers dispatch a DOM `comment-thread-activated` CustomEvent
 * on the editor root so the multi-editor orchestrator can open the
 * comment panel.
 */

import {
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
} from '@codemirror/view';
import type {
  CommentThread,
  SuggestionOverlayRegion,
} from '../interfaces/comments.js';
import type { PendingSuggestOverlay } from '../interfaces/suggest.js';

export interface CommentCmState {
  threads: CommentThread[];
  overlays: SuggestionOverlayRegion[];
  pending: PendingSuggestOverlay | null;
  activeThreadId: string | null;
}

const EMPTY_STATE: CommentCmState = {
  threads: [],
  overlays: [],
  pending: null,
  activeThreadId: null,
};

export const setCommentCmData = StateEffect.define<CommentCmState>();

export const commentCmStateField = StateField.define<CommentCmState>({
  create() {
    return EMPTY_STATE;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setCommentCmData)) return e.value;
    }
    return value;
  },
});

export const commentCmDecorationField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setCommentCmData)) {
        return buildDecorations(tr.state.doc, e.value);
      }
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class CaretMarkerWidget extends WidgetType {
  constructor(private readonly threadId: string, private readonly active: boolean) {
    super();
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = this.active
      ? 'cm-comment-caret cm-comment-caret--active'
      : 'cm-comment-caret';
    el.setAttribute('data-comment-thread-id', this.threadId);
    // Tiny visual — a colored pilcrow-ish tick showing where the
    // insert-style suggestion is anchored.
    el.textContent = '‸';
    return el;
  }
  eq(other: CaretMarkerWidget): boolean {
    return this.threadId === other.threadId && this.active === other.active;
  }
}

function buildDecorations(doc: any, state: CommentCmState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const collected: Array<{ from: number; to: number; dec: Decoration; sort: number }> = [];

  for (const thread of state.threads) {
    if (thread.status === 'resolved') continue;
    const from = Math.min(thread.anchor.start, doc.length);
    const to = Math.min(thread.anchor.end, doc.length);
    const isActive = thread.id === state.activeThreadId;
    const hasSuggestion = !!(thread.suggestion && thread.suggestion.status === 'pending');

    if (from < to) {
      // Range anchor: highlight the covered span.
      const classes = [
        'cm-comment-anchor',
        hasSuggestion ? 'cm-comment-anchor--suggestion' : '',
        isActive ? 'cm-comment-anchor--active' : '',
      ].filter(Boolean).join(' ');
      collected.push({
        from,
        to,
        sort: 0,
        dec: Decoration.mark({
          class: classes,
          attributes: { 'data-comment-thread-id': thread.id },
        }),
      });
    } else {
      // Zero-width anchor (insert-only suggestion): a caret widget at
      // the insert point so the panel has something to position near
      // and the user has a visible cue.
      collected.push({
        from,
        to: from,
        sort: 1,
        dec: Decoration.widget({
          widget: new CaretMarkerWidget(thread.id, isActive),
          side: 1,
        }),
      });
    }
  }

  collected.sort((a, b) => a.from - b.from || a.to - b.to || a.sort - b.sort);
  for (const { from, to, dec } of collected) {
    builder.add(from, to, dec);
  }
  return builder.finish();
}

// --- Gutter ---

class CommentGutterMarker extends GutterMarker {
  constructor(private count: number, private hasSuggestion: boolean) {
    super();
  }
  toDOM(): Node {
    const el = document.createElement('span');
    el.className = 'cm-comment-gutter-entry';
    el.style.cssText = 'cursor: pointer; font-size: 0.75em; color: #888;';
    el.textContent = this.hasSuggestion ? `✎${this.count > 1 ? this.count : ''}` : `💬${this.count > 1 ? this.count : ''}`;
    el.title = this.hasSuggestion
      ? `${this.count} suggestion${this.count === 1 ? '' : 's'}`
      : `${this.count} comment${this.count === 1 ? '' : 's'}`;
    return el;
  }
}

export const commentCmGutter = gutter({
  class: 'cm-comment-gutter',
  lineMarker(view, line) {
    const state = view.state.field(commentCmStateField, false);
    if (!state) return null;
    let commentCount = 0;
    let suggestionCount = 0;
    for (const t of state.threads) {
      if (t.status !== 'open') continue;
      if (t.anchor.start >= line.from && t.anchor.start <= line.to) {
        if (t.suggestion && t.suggestion.status === 'pending') suggestionCount += 1;
        else commentCount += 1;
      }
    }
    if (suggestionCount > 0) return new CommentGutterMarker(suggestionCount, true);
    if (commentCount > 0) return new CommentGutterMarker(commentCount, false);
    return null;
  },
  lineMarkerChange(update) {
    return update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(setCommentCmData)),
    );
  },
});

export const commentCmTheme = EditorView.baseTheme({
  '.cm-comment-anchor': {
    backgroundColor: 'rgba(255, 236, 179, 0.45)',
    borderBottom: '2px solid #ffca28',
  },
  '.cm-comment-anchor--suggestion': {
    backgroundColor: 'rgba(197, 225, 165, 0.45)',
    borderBottom: '2px solid #689f38',
  },
  '.cm-comment-anchor--active': {
    backgroundColor: 'rgba(255, 213, 79, 0.55)',
    borderBottom: '2px solid #f9a825',
  },
  '.cm-comment-anchor--suggestion.cm-comment-anchor--active': {
    backgroundColor: 'rgba(174, 213, 129, 0.55)',
    borderBottom: '2px solid #558b2f',
  },
  '.cm-comment-caret': {
    color: '#689f38',
    fontWeight: 'bold',
    cursor: 'pointer',
    display: 'inline-block',
    margin: '0 1px',
  },
  '.cm-comment-caret--active': {
    color: '#558b2f',
    textShadow: '0 0 2px rgba(85, 139, 47, 0.5)',
  },
  '.cm-comment-gutter': {
    width: '22px',
    textAlign: 'center',
  },
});

/**
 * Click listener that dispatches a DOM `comment-thread-activated` event
 * when the user clicks on a comment anchor decoration or gutter marker.
 */
export const commentCmClickHandler = EditorView.domEventHandlers({
  click(event, view) {
    const target = event.target as HTMLElement | null;
    const threadId = target?.closest('[data-comment-thread-id]')?.getAttribute(
      'data-comment-thread-id',
    );
    if (threadId) {
      view.dom.dispatchEvent(
        new CustomEvent('comment-thread-activated', {
          bubbles: true,
          detail: { threadId },
        }),
      );
      return true;
    }
    return false;
  },
});

export function createCommentCmExtensions(): Extension[] {
  return [
    commentCmStateField,
    commentCmDecorationField,
    commentCmGutter,
    commentCmTheme,
    commentCmClickHandler,
  ];
}
