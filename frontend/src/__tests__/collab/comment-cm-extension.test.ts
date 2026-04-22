/**
 * @vitest-environment jsdom
 */
import { describe, test, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  commentCmStateField,
  commentCmDecorationField,
  createCommentCmExtensions,
  setCommentCmData,
  type CommentCmState,
} from '../../collab/comment-cm-extension.js';
import type {
  CommentThread,
  SuggestionOverlayRegion,
} from '../../interfaces/comments.js';

function makeView(doc: string) {
  const state = EditorState.create({
    doc,
    extensions: createCommentCmExtensions(),
  });
  const view = new EditorView({ state, parent: document.createElement('div') });
  document.body.appendChild(view.dom);
  return view;
}

function thread(partial: Partial<CommentThread>): CommentThread {
  return {
    id: partial.id ?? 't1',
    document_id: 'doc.md',
    anchor: partial.anchor ?? { start: 0, end: 5, quoted_text: 'hello' },
    status: partial.status ?? 'open',
    created_at: '2026-01-01T00:00:00Z',
    comments: [],
    ...partial,
  } as CommentThread;
}

function dispatchState(view: EditorView, overrides: Partial<CommentCmState>): void {
  view.dispatch({
    effects: setCommentCmData.of({
      threads: overrides.threads ?? [],
      overlays: overrides.overlays ?? [],
      pending: overrides.pending ?? null,
      activeThreadId: overrides.activeThreadId ?? null,
    }),
  });
}

describe('comment-cm-extension', () => {
  test('initial state is empty', () => {
    const view = makeView('hello world');
    expect(view.state.field(commentCmStateField).threads).toHaveLength(0);
    expect(view.state.field(commentCmDecorationField).size).toBe(0);
    view.destroy();
  });

  test('open thread produces an inline mark', () => {
    const view = makeView('hello world');
    dispatchState(view, {
      threads: [thread({ anchor: { start: 0, end: 5, quoted_text: 'hello' } })],
    });
    expect(view.state.field(commentCmDecorationField).size).toBe(1);
    view.destroy();
  });

  test('resolved thread produces no mark', () => {
    const view = makeView('hello world');
    dispatchState(view, {
      threads: [thread({ status: 'resolved' })],
    });
    expect(view.state.field(commentCmDecorationField).size).toBe(0);
    view.destroy();
  });

  test('suggestion overlay produces strikethrough + widget', () => {
    const view = makeView('hello world');
    const overlay: SuggestionOverlayRegion = {
      threadId: 't-sug',
      start: 0,
      end: 5,
      afterText: 'HELLO',
      operations: [],
      authorColor: '#2ca02c',
      status: 'pending',
    };
    dispatchState(view, { overlays: [overlay] });
    // One mark (strikethrough) + one widget.
    expect(view.state.field(commentCmDecorationField).size).toBe(2);
    view.destroy();
  });

  test('pending Suggest-Mode overlay renders same as committed', () => {
    const view = makeView('hello world');
    dispatchState(view, {
      pending: {
        start: 6,
        end: 11,
        afterText: 'earth',
        operations: [],
        authorColor: '#d62728',
      },
    });
    expect(view.state.field(commentCmDecorationField).size).toBe(2);
    view.destroy();
  });

  test('ranges beyond doc length are clamped', () => {
    const view = makeView('hi');
    expect(() =>
      dispatchState(view, {
        threads: [thread({ anchor: { start: 0, end: 99, quoted_text: 'hi' } })],
      }),
    ).not.toThrow();
    view.destroy();
  });

  test('decorations survive document edits', () => {
    const view = makeView('hello world');
    dispatchState(view, {
      threads: [thread({ anchor: { start: 0, end: 5, quoted_text: 'hello' } })],
    });
    const before = view.state.field(commentCmDecorationField).size;
    view.dispatch({ changes: { from: 11, insert: '!' } });
    const after = view.state.field(commentCmDecorationField).size;
    expect(after).toBe(before);
    view.destroy();
  });

  test('click on an anchor dispatches comment-thread-activated', () => {
    const view = makeView('hello world');
    dispatchState(view, {
      threads: [thread({ id: 't-x', anchor: { start: 0, end: 5, quoted_text: 'hello' } })],
    });
    let receivedId: string | null = null;
    view.dom.addEventListener('comment-thread-activated', (e: any) => {
      receivedId = e.detail?.threadId ?? null;
    });

    // Synthesize a click on the comment-anchor decoration.
    const anchorEl = view.dom.querySelector('[data-comment-thread-id]');
    expect(anchorEl).not.toBeNull();
    anchorEl!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(receivedId).toBe('t-x');

    view.destroy();
  });
});
