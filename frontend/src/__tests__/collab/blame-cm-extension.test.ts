import { describe, test, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  blameDecorationField,
  blameSegmentsField,
  setBlameData,
  createBlameExtensions,
} from '../../collab/blame-cm-extension.js';
import type { BlameSegment } from '../../collab/blame-engine.js';

function createView(doc: string) {
  const state = EditorState.create({
    doc,
    extensions: createBlameExtensions(),
  });
  return new EditorView({ state, parent: document.createElement('div') });
}

describe('blame-cm-extension', () => {
  test('setBlameData effect updates blame segments field', () => {
    const view = createView('hello\nworld');
    const segments: BlameSegment[] = [
      { start: 0, end: 6, userName: 'alice' },
      { start: 6, end: 11, userName: 'bob' },
    ];

    view.dispatch({ effects: setBlameData.of(segments) });

    const stored = view.state.field(blameSegmentsField);
    expect(stored).toEqual(segments);
    view.destroy();
  });

  test('setBlameData builds decoration set', () => {
    const view = createView('hello\nworld');
    const segments: BlameSegment[] = [
      { start: 0, end: 6, userName: 'alice' },
    ];

    view.dispatch({ effects: setBlameData.of(segments) });

    const decos = view.state.field(blameDecorationField);
    // DecorationSet should not be empty
    expect(decos.size).toBeGreaterThan(0);
    view.destroy();
  });

  test('decorations survive doc changes (map through changes)', () => {
    const view = createView('hello\nworld');
    const segments: BlameSegment[] = [
      { start: 0, end: 11, userName: 'alice' },
    ];

    view.dispatch({ effects: setBlameData.of(segments) });
    const sizeBefore = view.state.field(blameDecorationField).size;
    expect(sizeBefore).toBeGreaterThan(0);

    // Make a doc change — decorations should survive (mapped), not be cleared
    view.dispatch({
      changes: { from: 11, insert: '\nextra line' },
    });

    const sizeAfter = view.state.field(blameDecorationField).size;
    // Decorations should still exist (mapped through the change)
    expect(sizeAfter).toBeGreaterThan(0);
    view.destroy();
  });

  test('empty segments produce empty decoration set', () => {
    const view = createView('hello');
    view.dispatch({ effects: setBlameData.of([]) });

    const decos = view.state.field(blameDecorationField);
    expect(decos.size).toBe(0);
    view.destroy();
  });

  test('segments field starts empty', () => {
    const view = createView('hello');
    expect(view.state.field(blameSegmentsField)).toEqual([]);
    view.destroy();
  });

  test('handles unsorted segments without crashing', () => {
    const view = createView('aaa\nbbb\nccc');
    // Segments intentionally out of order (could come from a provider)
    const segments: BlameSegment[] = [
      { start: 8, end: 11, userName: 'charlie' },
      { start: 0, end: 4, userName: 'alice' },
      { start: 4, end: 8, userName: 'bob' },
    ];

    // Should not throw RangeError about unsorted ranges
    expect(() => {
      view.dispatch({ effects: setBlameData.of(segments) });
    }).not.toThrow();

    const decos = view.state.field(blameDecorationField);
    expect(decos.size).toBeGreaterThan(0);
    view.destroy();
  });
});
