/**
 * @vitest-environment jsdom
 */
import { describe, test, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  buildCommentMeta,
  commentPluginKey,
  createCommentPlugin,
  type CommentPluginState,
} from '../../collab/comment-tiptap-plugin.js';
import type {
  CommentThread,
  SuggestionOverlayRegion,
} from '../../interfaces/comments.js';

function createEditor(html: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({ element: el, extensions: [StarterKit], content: html });
}

function pluginDecorations(editor: Editor): { count: number; state: CommentPluginState } {
  const raw = commentPluginKey.getState(editor.state) as any;
  const set = raw.decorations;
  let count = 0;
  set.find().forEach(() => count++);
  return { count, state: raw.state };
}

function makeThread(partial: Partial<CommentThread>): CommentThread {
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

describe('comment-tiptap-plugin', () => {
  test('plugin initializes with empty decoration set', () => {
    const editor = createEditor('<p>hello world</p>');
    editor.registerPlugin(createCommentPlugin());
    const { count, state } = pluginDecorations(editor);
    expect(count).toBe(0);
    expect(state.threads).toHaveLength(0);
    editor.destroy();
  });

  test('open thread produces a comment-anchor decoration', () => {
    const editor = createEditor('<p>hello world</p>');
    editor.registerPlugin(createCommentPlugin());

    const tr = editor.state.tr;
    tr.setMeta(
      commentPluginKey,
      buildCommentMeta(
        [makeThread({ anchor: { start: 0, end: 5, quoted_text: 'hello' } })],
        [],
        null,
      ),
    );
    editor.view.dispatch(tr);

    const { count } = pluginDecorations(editor);
    expect(count).toBeGreaterThan(0);
    editor.destroy();
  });

  test('resolved thread produces no decoration', () => {
    const editor = createEditor('<p>hello world</p>');
    editor.registerPlugin(createCommentPlugin());

    const tr = editor.state.tr;
    tr.setMeta(
      commentPluginKey,
      buildCommentMeta(
        [makeThread({ status: 'resolved' })],
        [],
        null,
      ),
    );
    editor.view.dispatch(tr);

    const { count } = pluginDecorations(editor);
    expect(count).toBe(0);
    editor.destroy();
  });

  test('active thread highlight class differs from inactive', () => {
    const editor = createEditor('<p>hello world</p>');
    editor.registerPlugin(createCommentPlugin());

    const tr = editor.state.tr;
    tr.setMeta(
      commentPluginKey,
      buildCommentMeta(
        [makeThread({ id: 'tA', anchor: { start: 0, end: 5, quoted_text: 'hello' } })],
        [],
        'tA',
      ),
    );
    editor.view.dispatch(tr);

    const decoSet = (commentPluginKey.getState(editor.state) as any).decorations;
    const all: any[] = [];
    decoSet.find().forEach((d: any) => all.push(d));
    const active = all.find((d) => d.type?.attrs?.class?.includes('--active'));
    expect(active).toBeDefined();
    editor.destroy();
  });

  test('committed suggestion emits strikethrough + after widget + margin icon', () => {
    const editor = createEditor('<p>hello world</p>');
    editor.registerPlugin(createCommentPlugin());

    const overlay: SuggestionOverlayRegion = {
      threadId: 't-sug',
      start: 0,
      end: 5,
      afterText: 'HELLO',
      operations: [],
      authorColor: '#1f77b4',
      status: 'pending',
    };

    const tr = editor.state.tr;
    tr.setMeta(commentPluginKey, buildCommentMeta([], [overlay], null));
    editor.view.dispatch(tr);

    const { count } = pluginDecorations(editor);
    // Inline strikethrough + widget for after-text + widget for marker.
    expect(count).toBeGreaterThanOrEqual(3);
    editor.destroy();
  });

  test('pending Suggest-Mode overlay from author also renders', () => {
    const editor = createEditor('<p>hello world</p>');
    editor.registerPlugin(createCommentPlugin());

    const tr = editor.state.tr;
    tr.setMeta(
      commentPluginKey,
      buildCommentMeta(
        [],
        [],
        null,
        {
          start: 6,
          end: 11,
          afterText: 'earth',
          operations: [],
          authorColor: '#ff7f0e',
        },
      ),
    );
    editor.view.dispatch(tr);

    const { count } = pluginDecorations(editor);
    expect(count).toBeGreaterThanOrEqual(2);
    editor.destroy();
  });

  test('thread with pending suggestion skips the comment-anchor decoration (suggestion handles the range)', () => {
    const editor = createEditor('<p>hello world</p>');
    editor.registerPlugin(createCommentPlugin());

    const thread = makeThread({
      id: 't1',
      suggestion: {
        yjs_payload: 'AAA=',
        human_readable: {
          summary: 's', before_text: 'hello', after_text: 'HI',
          operations: [],
        },
        author_id: 'u1',
        author_name: 'Alice',
        status: 'pending',
      },
    });
    const overlay: SuggestionOverlayRegion = {
      threadId: 't1',
      start: 0,
      end: 5,
      afterText: 'HI',
      operations: [],
      authorColor: '#1f77b4',
      status: 'pending',
    };
    const tr = editor.state.tr;
    tr.setMeta(commentPluginKey, buildCommentMeta([thread], [overlay], null));
    editor.view.dispatch(tr);

    const decoSet = (commentPluginKey.getState(editor.state) as any).decorations;
    const all: any[] = [];
    decoSet.find().forEach((d: any) => all.push(d));
    const commentAnchor = all.find(
      (d) => d.type?.attrs?.class === 'me-comment-anchor',
    );
    expect(commentAnchor).toBeUndefined();
    editor.destroy();
  });

  test('range beyond doc length is clamped, not thrown', () => {
    const editor = createEditor('<p>hi</p>');
    editor.registerPlugin(createCommentPlugin());
    // Y.Text offset for "hi\n" = 3 chars; request a range past that.
    const tr = editor.state.tr;
    tr.setMeta(
      commentPluginKey,
      buildCommentMeta(
        [makeThread({ anchor: { start: 0, end: 99, quoted_text: 'hi' } })],
        [],
        null,
      ),
    );
    expect(() => editor.view.dispatch(tr)).not.toThrow();
    editor.destroy();
  });
});
