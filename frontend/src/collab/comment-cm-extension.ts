/**
 * CodeMirror 6 comments extension.
 *
 * Mirrors comment-tiptap-plugin.ts but for source mode. Renders:
 *
 *   - Inline range marks for committed comment anchors.
 *   - Strikethrough + inline "after" widget for committed suggestion
 *     overlays.
 *   - Strikethrough + inline "after" widget for the author's local
 *     Suggest-Mode buffer overlay.
 *   - A gutter with per-line comment/suggestion indicators.
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

class SuggestAfterWidget extends WidgetType {
  constructor(private text: string, private color: string, private threadId: string) {
    super();
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-suggest-after';
    el.setAttribute('data-comment-thread-id', this.threadId);
    el.textContent = this.text;
    el.style.cssText = `
      text-decoration: underline;
      text-decoration-color: ${this.color};
      color: ${this.color};
      background-color: ${this.color}15;
      padding: 0 2px;
      margin: 0 1px;
      border-radius: 2px;
      cursor: pointer;
    `;
    return el;
  }
  eq(other: SuggestAfterWidget): boolean {
    return (
      this.text === other.text &&
      this.color === other.color &&
      this.threadId === other.threadId
    );
  }
}

function buildDecorations(doc: any, state: CommentCmState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // RangeSetBuilder requires ranges in ascending order. Collect all
  // decorations first, then sort.
  const collected: Array<{ from: number; to: number; dec: Decoration }> = [];

  for (const thread of state.threads) {
    if (thread.status === 'resolved') continue;
    if (thread.suggestion && thread.suggestion.status === 'pending') continue;
    const from = Math.min(thread.anchor.start, doc.length);
    const to = Math.min(thread.anchor.end, doc.length);
    if (from >= to) continue;
    const isActive = thread.id === state.activeThreadId;
    collected.push({
      from,
      to,
      dec: Decoration.mark({
        class: isActive ? 'cm-comment-anchor cm-comment-anchor--active' : 'cm-comment-anchor',
        attributes: { 'data-comment-thread-id': thread.id },
      }),
    });
  }

  const addSuggest = (overlay: SuggestionOverlayRegion | PendingSuggestOverlay & { threadId?: string }) => {
    const threadId = (overlay as SuggestionOverlayRegion).threadId ?? '__pending__';
    const color = overlay.authorColor;
    const from = Math.min(overlay.start, doc.length);
    const to = Math.min(overlay.end, doc.length);
    if (to > from) {
      collected.push({
        from,
        to,
        dec: Decoration.mark({
          class: 'cm-suggest-before',
          attributes: {
            'data-comment-thread-id': threadId,
            style: `text-decoration: line-through; text-decoration-color: ${color}; background-color: ${color}20;`,
          },
        }),
      });
    }
    if (overlay.afterText) {
      const widgetPos = Math.min(to, doc.length);
      collected.push({
        from: widgetPos,
        to: widgetPos,
        dec: Decoration.widget({
          widget: new SuggestAfterWidget(overlay.afterText, color, threadId),
          side: 1,
        }),
      });
    }
  };

  for (const overlay of state.overlays) addSuggest(overlay);
  if (state.pending) addSuggest(state.pending);

  collected.sort((a, b) => a.from - b.from || a.to - b.to);
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
        if (t.suggestion) suggestionCount += 1;
        else commentCount += 1;
      }
    }
    for (const o of state.overlays) {
      if (o.start >= line.from && o.start <= line.to) suggestionCount += 1;
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
  '.cm-comment-anchor--active': {
    backgroundColor: 'rgba(255, 213, 79, 0.55)',
    borderBottom: '2px solid #f9a825',
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
