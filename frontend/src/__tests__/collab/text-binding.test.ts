import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextBinding, applyStringDiff } from '../../collab/text-binding.js';
import type { IContentHandler } from '../../interfaces/content-handler.js';

// ---- Mock Editor ----
// Simulates the subset of Tiptap Editor that TextBinding uses:
// on/off('update'), commands.setContent(), getHTML()

function createMockEditor(initialContent = '') {
  let html = initialContent;
  const listeners: Record<string, Set<(...args: any[]) => void>> = {};

  const editor = {
    commands: {
      setContent(content: string, _opts?: any) {
        html = content;
        // Tiptap fires 'update' synchronously on setContent
        (listeners['update'] ?? new Set()).forEach(fn => fn());
      },
    },
    getHTML() {
      return html;
    },
    getMarkdown: undefined as (() => string) | undefined,
    on(event: string, fn: (...args: any[]) => void) {
      if (!listeners[event]) listeners[event] = new Set();
      listeners[event].add(fn);
    },
    off(event: string, fn: (...args: any[]) => void) {
      listeners[event]?.delete(fn);
    },
    /** Simulate a user edit inside Tiptap (changes content + fires 'update') */
    _simulateUserEdit(newContent: string) {
      html = newContent;
      (listeners['update'] ?? new Set()).forEach(fn => fn());
    },
  };

  return editor;
}

// ---- Mock Content Handler (HTML) ----
const htmlHandler: IContentHandler = {
  supportedMimeTypes: ['text/html'],
  parse: (text: string) => ({ type: 'html', content: text }),
  serialize: (output: string) => output,
};

// ---- Mock Content Handler (Markdown) ----
const mdHandler: IContentHandler = {
  supportedMimeTypes: ['text/markdown'],
  parse: (text: string) => ({ type: 'markdown', content: text }),
  serialize: (output: string) => output,
};

// ---- Helpers ----

function createYText(initialContent = ''): { ydoc: Y.Doc; ytext: Y.Text } {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('source');
  if (initialContent) {
    ytext.insert(0, initialContent);
  }
  return { ydoc, ytext };
}

// ---- applyStringDiff tests ----

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

    let deleteCount = 0;
    let insertCount = 0;
    ytext.observe((event) => {
      for (const delta of event.delta) {
        if ('delete' in delta) deleteCount++;
        if ('insert' in delta) insertCount++;
      }
    });

    applyStringDiff(ytext, 'hello world', 'hello there');

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

// ---- TextBinding tests ----

describe('TextBinding', () => {
  let ydoc: Y.Doc;
  let ytext: Y.Text;

  beforeEach(() => {
    vi.useFakeTimers();
    ({ ydoc, ytext } = createYText());
  });

  afterEach(() => {
    ydoc.destroy();
    vi.useRealTimers();
  });

  test('constructor applies existing Y.Text content to editor', () => {
    ytext.insert(0, '<p>existing</p>');
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    expect(editor.getHTML()).toBe('<p>existing</p>');
    binding.destroy();
  });

  test('constructor does not touch editor when Y.Text is empty', () => {
    const editor = createMockEditor('<p>initial</p>');
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    expect(editor.getHTML()).toBe('<p>initial</p>');
    binding.destroy();
  });

  test('remote Y.Text change is applied to editor', () => {
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // Simulate remote change (origin !== TextBinding's symbol)
    ydoc.transact(() => {
      ytext.insert(0, '<p>remote content</p>');
    });

    expect(editor.getHTML()).toBe('<p>remote content</p>');
    binding.destroy();
  });

  test('local editor edit propagates to Y.Text after debounce', () => {
    ytext.insert(0, '<p>original</p>');
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // Simulate user typing in Tiptap
    editor._simulateUserEdit('<p>modified</p>');

    // Before debounce: Y.Text unchanged
    expect(ytext.toString()).toBe('<p>original</p>');

    // After debounce
    vi.advanceTimersByTime(150);
    expect(ytext.toString()).toBe('<p>modified</p>');

    binding.destroy();
  });

  test('echo prevention: remote Y.Text change does not write back', () => {
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    const ytextChanges: number[] = [];
    ytext.observe(() => ytextChanges.push(ytext.length));

    // Remote change
    ydoc.transact(() => {
      ytext.insert(0, '<p>remote</p>');
    });

    // Let debounce fire
    vi.advanceTimersByTime(150);

    // Should have only the one remote insert — no echo write-back
    expect(ytextChanges).toHaveLength(1);
    expect(ytext.toString()).toBe('<p>remote</p>');

    binding.destroy();
  });

  test('echo prevention: normalized HTML does not overwrite Y.Text', () => {
    const editor = createMockEditor();
    // Override getHTML to return slightly different normalization
    const origGetHTML = editor.getHTML.bind(editor);
    editor.getHTML = () => {
      const html = origGetHTML();
      // Simulate Tiptap normalizing whitespace
      return html.replace(/></g, '> <').trim() || html;
    };

    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // Remote change sets Y.Text
    ydoc.transact(() => {
      ytext.insert(0, '<h1>Title</h1><p>Body</p>');
    });

    // Debounce fires — getHTML returns normalized version
    vi.advanceTimersByTime(150);

    // Y.Text should NOT be overwritten with normalized version
    // because _lastAppliedFromYText matches the normalized output
    expect(ytext.toString()).toBe('<h1>Title</h1><p>Body</p>');

    binding.destroy();
  });

  test('debounce is canceled when remote change arrives', () => {
    ytext.insert(0, '<p>original</p>');
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // User edits in Tiptap — starts debounce
    editor._simulateUserEdit('<p>user edit</p>');

    // Before debounce fires, remote change arrives
    vi.advanceTimersByTime(50); // 50ms into the 100ms debounce
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>remote wins</p>');
    });

    // Editor should show remote content
    expect(editor.getHTML()).toBe('<p>remote wins</p>');

    // Let old debounce window pass — it should have been canceled
    vi.advanceTimersByTime(150);

    // Y.Text should still be the remote content, not the stale user edit
    expect(ytext.toString()).toBe('<p>remote wins</p>');

    binding.destroy();
  });

  test('rapid remote changes: only final state applies', () => {
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // Rapid sequence of remote changes
    ydoc.transact(() => { ytext.insert(0, '<p>first</p>'); });
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>second</p>');
    });
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>third</p>');
    });

    // Editor should show the last applied content
    expect(editor.getHTML()).toBe('<p>third</p>');

    // Let debounce fire — no echo
    vi.advanceTimersByTime(150);
    expect(ytext.toString()).toBe('<p>third</p>');

    binding.destroy();
  });

  test('own writes to Y.Text do not re-apply to editor', () => {
    ytext.insert(0, '<p>start</p>');
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // Track setContent calls
    let setContentCount = 0;
    const origSetContent = editor.commands.setContent.bind(editor.commands);
    editor.commands.setContent = (content: string, opts?: any) => {
      setContentCount++;
      origSetContent(content, opts);
    };

    // User edits → debounce → writes to Y.Text with TextBinding's origin
    editor._simulateUserEdit('<p>edited</p>');
    vi.advanceTimersByTime(150);

    // The Y.Text write should NOT trigger _applyYTextToEditor
    // because the origin matches TextBinding's symbol
    // setContentCount should be 0 (from mock override, not from constructor)
    expect(setContentCount).toBe(0);
    expect(ytext.toString()).toBe('<p>edited</p>');

    binding.destroy();
  });

  test('loadInitialContent: seeds Y.Text if empty', () => {
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    binding.loadInitialContent('<p>seed</p>');

    expect(ytext.toString()).toBe('<p>seed</p>');
    expect(editor.getHTML()).toBe('<p>seed</p>');
    binding.destroy();
  });

  test('loadInitialContent: does not overwrite existing Y.Text', () => {
    ytext.insert(0, '<p>existing</p>');
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    binding.loadInitialContent('<p>ignored</p>');

    expect(ytext.toString()).toBe('<p>existing</p>');
    expect(editor.getHTML()).toBe('<p>existing</p>');
    binding.destroy();
  });

  test('destroy stops all sync', () => {
    ytext.insert(0, '<p>start</p>');
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    binding.destroy();

    // Remote change should NOT apply to editor
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>after destroy</p>');
    });

    expect(editor.getHTML()).toBe('<p>start</p>');

    // User edit should NOT apply to Y.Text
    editor._simulateUserEdit('<p>user after destroy</p>');
    vi.advanceTimersByTime(150);
    expect(ytext.toString()).toBe('<p>after destroy</p>');
  });

  test('concurrent edit and remote change: user edit survives', () => {
    ytext.insert(0, '<p>original</p>');
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // User starts editing
    editor._simulateUserEdit('<p>user typing</p>');

    // 50ms in, remote change arrives — debounce canceled, remote applied
    vi.advanceTimersByTime(50);
    ydoc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, '<p>remote update</p>');
    });

    expect(editor.getHTML()).toBe('<p>remote update</p>');

    // User edits again after remote was applied
    editor._simulateUserEdit('<p>remote update plus more</p>');
    vi.advanceTimersByTime(150);

    // User's follow-up edit should be in Y.Text
    expect(ytext.toString()).toBe('<p>remote update plus more</p>');

    binding.destroy();
  });

  test('HTML with em/strong tags round-trips correctly', () => {
    const html = '<p>This is <strong>bold</strong> and <em>italic</em> text.</p>';
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // Remote sets HTML with inline formatting
    ydoc.transact(() => { ytext.insert(0, html); });

    expect(editor.getHTML()).toBe(html);

    // Debounce should not corrupt
    vi.advanceTimersByTime(150);
    expect(ytext.toString()).toBe(html);

    binding.destroy();
  });
});
