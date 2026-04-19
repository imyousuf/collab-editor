import { describe, test, expect } from 'vitest';
import * as Y from 'yjs';
import { applyStringDiff } from '../../collab/text-binding.js';

describe('applyStringDiff', () => {
  function diffAndGet(oldStr: string, newStr: string): string {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('test');
    ytext.insert(0, oldStr);
    applyStringDiff(ytext, oldStr, newStr);
    const result = ytext.toString();
    ydoc.destroy();
    return result;
  }

  test('identical strings → no change', () => {
    expect(diffAndGet('hello', 'hello')).toBe('hello');
  });

  test('empty → insert', () => {
    expect(diffAndGet('', 'hello')).toBe('hello');
  });

  test('delete all → empty', () => {
    expect(diffAndGet('hello', '')).toBe('');
  });

  test('append at end', () => {
    expect(diffAndGet('hello', 'hello world')).toBe('hello world');
  });

  test('prepend at start', () => {
    expect(diffAndGet('world', 'hello world')).toBe('hello world');
  });

  test('change in middle', () => {
    expect(diffAndGet('hello world', 'hello there')).toBe('hello there');
  });

  test('replace single character', () => {
    expect(diffAndGet('cat', 'bat')).toBe('bat');
  });

  test('multiline: change one line', () => {
    const old = '# Title\n\nLine 1\nLine 2\nLine 3';
    const newStr = '# Title\n\nLine 1\nModified\nLine 3';
    expect(diffAndGet(old, newStr)).toBe(newStr);
  });

  test('multiline: add a line', () => {
    const old = 'Line 1\nLine 2';
    const newStr = 'Line 1\nNew Line\nLine 2';
    expect(diffAndGet(old, newStr)).toBe(newStr);
  });

  test('multiline: remove a line', () => {
    const old = 'Line 1\nLine 2\nLine 3';
    const newStr = 'Line 1\nLine 3';
    expect(diffAndGet(old, newStr)).toBe(newStr);
  });

  test('preserves Y.Text operations (not replace-all)', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('test');
    ytext.insert(0, 'hello world');

    // Track operations
    let deleteCount = 0;
    let insertCount = 0;
    ytext.observe((event) => {
      for (const delta of event.delta) {
        if ('delete' in delta) deleteCount++;
        if ('insert' in delta) insertCount++;
      }
    });

    applyStringDiff(ytext, 'hello world', 'hello there');

    // Should have exactly 1 delete + 1 insert (not 2 of each for replace-all)
    expect(deleteCount).toBe(1);
    expect(insertCount).toBe(1);
    expect(ytext.toString()).toBe('hello there');

    ydoc.destroy();
  });

  test('handles text changes around unicode', () => {
    expect(diffAndGet('hello world 🌍', 'hello earth 🌍')).toBe('hello earth 🌍');
    expect(diffAndGet('abc', 'abcdef')).toBe('abcdef');
  });

  test('long markdown document — change heading', () => {
    const old = '# Welcome to Editor\n\nThis is a **bold** document.\n\n## Features\n\n- Item 1\n- Item 2';
    const newStr = '# Welcome to Editor 2\n\nThis is a **bold** document.\n\n## Features\n\n- Item 1\n- Item 2';
    expect(diffAndGet(old, newStr)).toBe(newStr);
  });
});
