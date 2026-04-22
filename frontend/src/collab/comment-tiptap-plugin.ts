/**
 * ProseMirror/Tiptap comments plugin.
 *
 * Renders three overlay layers:
 *
 *   1. Committed comment anchors  — underlined background on the range,
 *      margin speech-bubble widget at line start.
 *   2. Committed pending suggestion overlays — strikethrough on the
 *      anchored range + underlined `after_text` widget rendered inline.
 *   3. Local Suggest-Mode buffer overlay — same visual vocabulary as a
 *      committed suggestion, but colored with the author's suggestion
 *      color and labeled "(pending)".
 *
 * Character offsets are the wire-layer unit; a position map is rebuilt
 * on each docChange + clamped to the text-content max offset (same
 * workaround used in blame-tiptap-plugin.ts).
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type {
  CommentThread,
  SuggestionOverlayRegion,
} from '../interfaces/comments.js';
import type { PendingSuggestOverlay } from '../interfaces/suggest.js';

export const commentPluginKey = new PluginKey('comments');

export interface CommentPluginState {
  threads: CommentThread[];
  overlays: SuggestionOverlayRegion[];
  pending: PendingSuggestOverlay | null;
  activeThreadId: string | null;
}

const EMPTY_STATE: CommentPluginState = {
  threads: [],
  overlays: [],
  pending: null,
  activeThreadId: null,
};

export function createCommentPlugin(): Plugin {
  return new Plugin<{ state: CommentPluginState; decorations: DecorationSet }>({
    key: commentPluginKey,
    state: {
      init(_config, editorState) {
        return {
          state: EMPTY_STATE,
          decorations: buildDecorations(editorState.doc, EMPTY_STATE),
        };
      },
      apply(tr, old) {
        const meta = tr.getMeta(commentPluginKey);
        if (meta !== undefined) {
          const next: CommentPluginState = { ...old.state, ...meta };
          return {
            state: next,
            decorations: buildDecorations(tr.doc, next),
          };
        }
        if (tr.docChanged) {
          // Re-render from scratch since range positions shift.
          return {
            state: old.state,
            decorations: buildDecorations(tr.doc, old.state),
          };
        }
        return old;
      },
    },
    props: {
      decorations(state) {
        return (this as any).getState(state).decorations as DecorationSet;
      },
      handleClick(view, _pos, event) {
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
    },
  });
}

/**
 * Public API: produce the meta payload that transforms the plugin state.
 * Callers use `tr.setMeta(commentPluginKey, buildCommentMeta(...))`.
 */
export function buildCommentMeta(
  threads: CommentThread[],
  overlays: SuggestionOverlayRegion[],
  activeThreadId: string | null,
  pending: PendingSuggestOverlay | null = null,
): Partial<CommentPluginState> {
  return { threads, overlays, pending, activeThreadId };
}

// --- Decoration builder ---

function buildDecorations(doc: any, state: CommentPluginState): DecorationSet {
  const posMap = buildPositionMap(doc);
  if (posMap.size === 0) return DecorationSet.empty;
  const maxOffset = Math.max(...posMap.keys());
  const decorations: Decoration[] = [];

  // 1) Comment anchor highlights. Threads with no suggestion get a soft
  // yellow highlight; threads WITH a suggestion skip the anchor (the
  // suggestion decoration handles their range).
  for (const thread of state.threads) {
    if (thread.status === 'resolved') continue;
    if (thread.suggestion && thread.suggestion.status === 'pending') continue;
    const { from, to } = mapRange(thread.anchor.start, thread.anchor.end, posMap, maxOffset);
    if (from === null || to === null || from >= to) continue;
    const isActive = thread.id === state.activeThreadId;
    decorations.push(
      Decoration.inline(from, to, {
        class: isActive ? 'me-comment-anchor me-comment-anchor--active' : 'me-comment-anchor',
        'data-comment-thread-id': thread.id,
        style: isActive
          ? 'background-color: rgba(255, 213, 79, 0.55); border-bottom: 2px solid #f9a825;'
          : 'background-color: rgba(255, 236, 179, 0.45); border-bottom: 2px solid #ffca28;',
      }),
    );
  }

  // 2) Committed pending suggestion overlays.
  for (const overlay of state.overlays) {
    decorateSuggestion(decorations, posMap, maxOffset, overlay);
  }

  // 3) Author's own pending Suggest-Mode buffer.
  if (state.pending) {
    decorateSuggestion(decorations, posMap, maxOffset, {
      threadId: '__pending__',
      ...state.pending,
      status: 'pending',
    });
  }

  return DecorationSet.create(doc, decorations);
}

function decorateSuggestion(
  out: Decoration[],
  posMap: Map<number, number>,
  maxOffset: number,
  overlay: SuggestionOverlayRegion,
): void {
  const { from, to } = mapRange(overlay.start, overlay.end, posMap, maxOffset);
  if (from === null) return;
  const color = overlay.authorColor;

  // Strikethrough on the "before" range when it exists in the live doc.
  if (to !== null && to > from) {
    out.push(
      Decoration.inline(from, to, {
        class: 'me-suggest-before',
        'data-comment-thread-id': overlay.threadId,
        style: `text-decoration: line-through; text-decoration-color: ${color}; background-color: ${color}20;`,
      }),
    );
  }

  // Inline widget with the "after" text immediately after the range.
  const insertAt = to ?? from;
  if (overlay.afterText) {
    out.push(
      Decoration.widget(insertAt, () => {
        const el = document.createElement('span');
        el.className = 'me-suggest-after';
        el.setAttribute('data-comment-thread-id', overlay.threadId);
        el.textContent = overlay.afterText;
        el.style.cssText = `
          text-decoration: underline;
          text-decoration-color: ${color};
          color: ${color};
          background-color: ${color}15;
          padding: 0 2px;
          margin: 0 1px;
          border-radius: 2px;
          cursor: pointer;
        `;
        return el;
      }, { side: 1 }),
    );
  }

  // Margin pencil icon at the left of the containing line.
  out.push(
    Decoration.widget(from, () => {
      const el = document.createElement('span');
      el.className = 'me-suggest-marker';
      el.setAttribute('data-comment-thread-id', overlay.threadId);
      el.textContent = '✎';
      el.style.cssText = `
        position: absolute;
        left: -1.5em;
        color: ${color};
        font-size: 0.85em;
        cursor: pointer;
      `;
      return el;
    }, { side: -1 }),
  );
}

/** Map a [start, end) character range to PM positions, with clamping. */
function mapRange(
  start: number,
  end: number,
  posMap: Map<number, number>,
  maxOffset: number,
): { from: number | null; to: number | null } {
  const from = posMap.get(Math.min(start, maxOffset));
  const clampedEnd = Math.min(end, maxOffset);
  const to = posMap.get(clampedEnd);
  return {
    from: from ?? null,
    to: to ?? null,
  };
}

/** Walk the PM doc once to build char-offset -> PM-position lookup. */
function buildPositionMap(doc: any): Map<number, number> {
  const map = new Map<number, number>();
  let charOffset = 0;
  doc.descendants((node: any, pos: number) => {
    if (node.isText) {
      for (let i = 0; i < node.text!.length; i++) {
        map.set(charOffset + i, pos + i);
      }
      charOffset += node.text!.length;
      return false;
    }
    if (node.isBlock && node !== doc && charOffset > 0) {
      map.set(charOffset, pos);
      charOffset++;
    }
    return true;
  });
  map.set(charOffset, doc.content.size);
  return map;
}
