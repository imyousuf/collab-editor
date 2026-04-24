/**
 * ProseMirror/Tiptap comments plugin.
 *
 * Renders anchor-range highlights for open comment threads and for
 * pending-suggestion threads. Suggestions use a distinct tint so users
 * can spot them at a glance — everything else (before/after preview,
 * accept/reject UI, submit flow) lives in the comment panel and the
 * status bar, not inline in the editor.
 *
 * Post syncDoc/editorDoc split: there are no inline strikethrough or
 * "after" widgets. Reviewers preview a suggestion by activating the
 * thread — the proposed diff is applied to their local editorDoc in
 * C9's preview flow.
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
import { buildPositionMap, snapRange } from './pm-position-map.js';
import type * as Y from 'yjs';

export const commentPluginKey = new PluginKey('comments');

export interface CommentPluginState {
  threads: CommentThread[];
  overlays: SuggestionOverlayRegion[];
  pending: PendingSuggestOverlay | null;
  activeThreadId: string | null;
  /**
   * Y.Text handle used by the shared position map to know the true
   * source content (Markdown/HTML). Optional for backward compatibility
   * — absence falls back to serializing the PM doc.
   */
  ytext?: Y.Text;
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
  ytext?: Y.Text,
): Partial<CommentPluginState> {
  return { threads, overlays, pending, activeThreadId, ytext };
}

// --- Decoration builder ---

function buildDecorations(doc: any, state: CommentPluginState): DecorationSet {
  const yTextStr = state.ytext ? state.ytext.toString() : pmToString(doc);
  const posMap = buildPositionMap(doc, yTextStr);
  if (posMap.size === 0 && state.threads.length === 0) {
    return DecorationSet.empty;
  }
  const decorations: Decoration[] = [];

  // Anchor-range highlight for open threads. Suggestions get a distinct
  // green tint; plain comments get the original yellow. Either way,
  // WYSIWYG mode stays clean — no inline widgets, no strikethrough.
  for (const thread of state.threads) {
    if (thread.status === 'resolved') continue;
    const snapped = snapRange(thread.anchor.start, thread.anchor.end, posMap);
    if (snapped.from === undefined || snapped.to === undefined) continue;
    if (snapped.from >= snapped.to) continue;
    const isActive = thread.id === state.activeThreadId;
    const hasSuggestion = !!(thread.suggestion && thread.suggestion.status === 'pending');
    const classes = [
      'me-comment-anchor',
      hasSuggestion ? 'me-comment-anchor--suggestion' : '',
      isActive ? 'me-comment-anchor--active' : '',
    ].filter(Boolean).join(' ');
    const style = hasSuggestion
      ? (isActive
        ? 'background-color: rgba(174, 213, 129, 0.55); border-bottom: 2px solid #558b2f;'
        : 'background-color: rgba(197, 225, 165, 0.45); border-bottom: 2px solid #689f38;')
      : (isActive
        ? 'background-color: rgba(255, 213, 79, 0.55); border-bottom: 2px solid #f9a825;'
        : 'background-color: rgba(255, 236, 179, 0.45); border-bottom: 2px solid #ffca28;');
    decorations.push(
      Decoration.inline(snapped.from, snapped.to, {
        class: classes,
        'data-comment-thread-id': thread.id,
        style,
      }),
    );
  }

  return DecorationSet.create(doc, decorations);
}

function pmToString(doc: any): string {
  const parts: string[] = [];
  doc.descendants((node: any) => {
    if (node.isText) {
      parts.push(node.text ?? '');
      return false;
    }
    if (node.isBlock && node !== doc && parts.length > 0) {
      parts.push('\n');
    }
    return true;
  });
  return parts.join('');
}

