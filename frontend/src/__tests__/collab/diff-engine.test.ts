import { describe, test, expect } from 'vitest';
import { computeLineDiff } from '../../collab/diff-engine.js';

describe('computeLineDiff', () => {
  test('identical strings produce all unchanged', () => {
    const diff = computeLineDiff('hello\nworld', 'hello\nworld');
    expect(diff).toEqual([
      { type: 'unchanged', content: 'hello', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'unchanged', content: 'world', oldLineNumber: 2, newLineNumber: 2 },
    ]);
  });

  test('empty to content — all added', () => {
    const diff = computeLineDiff('', 'hello\nworld');
    expect(diff).toEqual([
      { type: 'added', content: 'hello', newLineNumber: 1 },
      { type: 'added', content: 'world', newLineNumber: 2 },
    ]);
  });

  test('content to empty — all removed', () => {
    const diff = computeLineDiff('hello\nworld', '');
    expect(diff).toEqual([
      { type: 'removed', content: 'hello', oldLineNumber: 1 },
      { type: 'removed', content: 'world', oldLineNumber: 2 },
    ]);
  });

  test('both empty', () => {
    expect(computeLineDiff('', '')).toEqual([]);
  });

  test('added line at end', () => {
    const diff = computeLineDiff('a\nb', 'a\nb\nc');
    expect(diff).toEqual([
      { type: 'unchanged', content: 'a', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'unchanged', content: 'b', oldLineNumber: 2, newLineNumber: 2 },
      { type: 'added', content: 'c', newLineNumber: 3 },
    ]);
  });

  test('removed line from middle', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nc');
    expect(diff).toEqual([
      { type: 'unchanged', content: 'a', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'removed', content: 'b', oldLineNumber: 2 },
      { type: 'unchanged', content: 'c', oldLineNumber: 3, newLineNumber: 2 },
    ]);
  });

  test('modified line', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nB\nc');
    expect(diff).toEqual([
      { type: 'unchanged', content: 'a', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'removed', content: 'b', oldLineNumber: 2 },
      { type: 'added', content: 'B', newLineNumber: 2 },
      { type: 'unchanged', content: 'c', oldLineNumber: 3, newLineNumber: 3 },
    ]);
  });

  test('complete replacement', () => {
    const diff = computeLineDiff('old\ncontent', 'new\nstuff');
    expect(diff.filter(d => d.type === 'removed').length).toBe(2);
    expect(diff.filter(d => d.type === 'added').length).toBe(2);
  });

  test('added line at beginning', () => {
    const diff = computeLineDiff('b\nc', 'a\nb\nc');
    expect(diff).toEqual([
      { type: 'added', content: 'a', newLineNumber: 1 },
      { type: 'unchanged', content: 'b', oldLineNumber: 1, newLineNumber: 2 },
      { type: 'unchanged', content: 'c', oldLineNumber: 2, newLineNumber: 3 },
    ]);
  });

  test('single line change', () => {
    const diff = computeLineDiff('hello', 'world');
    expect(diff).toEqual([
      { type: 'removed', content: 'hello', oldLineNumber: 1 },
      { type: 'added', content: 'world', newLineNumber: 1 },
    ]);
  });

  test('line numbers are 1-based', () => {
    const diff = computeLineDiff('a\nb', 'a\nc');
    for (const line of diff) {
      if (line.oldLineNumber !== undefined) expect(line.oldLineNumber).toBeGreaterThan(0);
      if (line.newLineNumber !== undefined) expect(line.newLineNumber).toBeGreaterThan(0);
    }
  });
});
