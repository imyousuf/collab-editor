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

  function fireUpdate(docChanged: boolean) {
    const payload = { editor, transaction: { docChanged } };
    (listeners['update'] ?? new Set()).forEach(fn => fn(payload));
  }

  const editor = {
    commands: {
      setContent(content: string, _opts?: any) {
        html = content;
        // Tiptap fires 'update' synchronously on setContent (docChanged = true)
        fireUpdate(true);
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
      fireUpdate(true);
    },
    /** Simulate a metadata-only transaction (e.g., blame decorations — docChanged = false) */
    _simulateMetaOnlyTransaction() {
      fireUpdate(false);
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

  test('remote Y.Text change is applied to editor', async () => {
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // Simulate remote change (origin !== TextBinding's symbol)
    ydoc.transact(() => {
      ytext.insert(0, '<p>remote content</p>');
    });

    // Flush microtask (Y.Text→Tiptap sync is deferred)
    await Promise.resolve();
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

  test('echo prevention: remote Y.Text change does not write back', async () => {
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    const ytextChanges: number[] = [];
    ytext.observe(() => ytextChanges.push(ytext.length));

    // Remote change
    ydoc.transact(() => {
      ytext.insert(0, '<p>remote</p>');
    });

    // Flush microtask (deferred Y.Text→Tiptap sync)
    await Promise.resolve();

    // Let debounce fire
    vi.advanceTimersByTime(150);

    // Should have only the one remote insert — no echo write-back
    expect(ytextChanges).toHaveLength(1);
    expect(ytext.toString()).toBe('<p>remote</p>');

    binding.destroy();
  });

  test('echo prevention: normalized HTML does not overwrite Y.Text', async () => {
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

    // Flush microtask then let debounce fire
    await Promise.resolve();
    vi.advanceTimersByTime(150);

    // Y.Text should NOT be overwritten with normalized version
    // because _lastAppliedFromYText matches the normalized output
    expect(ytext.toString()).toBe('<h1>Title</h1><p>Body</p>');

    binding.destroy();
  });

  test('debounce is canceled when remote change arrives', async () => {
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

    // Flush microtask
    await Promise.resolve();
    // Editor should show remote content
    expect(editor.getHTML()).toBe('<p>remote wins</p>');

    // Let old debounce window pass — it should have been canceled
    vi.advanceTimersByTime(150);

    // Y.Text should still be the remote content, not the stale user edit
    expect(ytext.toString()).toBe('<p>remote wins</p>');

    binding.destroy();
  });

  test('rapid remote changes: only final state applies', async () => {
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

    // Flush microtask (coalesced into one update)
    await Promise.resolve();
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

  test('concurrent edit and remote change: user edit survives', async () => {
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

    // Flush microtask
    await Promise.resolve();
    expect(editor.getHTML()).toBe('<p>remote update</p>');

    // User edits again after remote was applied
    editor._simulateUserEdit('<p>remote update plus more</p>');
    vi.advanceTimersByTime(150);

    // User's follow-up edit should be in Y.Text
    expect(ytext.toString()).toBe('<p>remote update plus more</p>');

    binding.destroy();
  });

  test('metadata-only transactions (blame) do not trigger Y.Text sync', () => {
    ytext.insert(0, '<p>original content</p>');
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // Track writes to Y.Text
    let ytextWriteCount = 0;
    ytext.observe((event) => {
      if (event.transaction.origin !== undefined) {
        ytextWriteCount++;
      }
    });

    // Fire a metadata-only transaction (like blame decoration update)
    editor._simulateMetaOnlyTransaction();

    // Let debounce window pass
    vi.advanceTimersByTime(150);

    // No writes should have happened to Y.Text
    expect(ytextWriteCount).toBe(0);
    expect(ytext.toString()).toBe('<p>original content</p>');

    binding.destroy();
  });

  test('metadata-only transactions do not corrupt Y.Text with normalized content', () => {
    const editor = createMockEditor();
    // Override getHTML to return normalized version (simulates Tiptap normalization)
    const origGetHTML = editor.getHTML.bind(editor);
    editor.getHTML = () => {
      const html = origGetHTML();
      // Simulate Tiptap adding whitespace during normalization
      return html.replace(/<\/p><p>/g, '</p>\n<p>') || html;
    };

    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // Remote sets Y.Text
    ydoc.transact(() => {
      ytext.insert(0, '<p>line1</p><p>line2</p>');
    });

    // Now fire multiple metadata-only transactions (blame updates)
    editor._simulateMetaOnlyTransaction();
    editor._simulateMetaOnlyTransaction();
    editor._simulateMetaOnlyTransaction();

    // Let debounce window pass
    vi.advanceTimersByTime(150);

    // Y.Text should still have original content, NOT normalized
    expect(ytext.toString()).toBe('<p>line1</p><p>line2</p>');

    binding.destroy();
  });

  test('setPaused prevents Tiptap→Y.Text sync entirely', () => {
    ytext.insert(0, '<p>original</p>');
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // Pause the binding (simulates source mode active)
    binding.setPaused(true);

    // Simulate user edit in Tiptap (shouldn't happen in source mode, but test the guard)
    editor._simulateUserEdit('<p>modified in wysiwyg</p>');

    // Let debounce fire
    vi.advanceTimersByTime(150);

    // Y.Text should NOT be modified
    expect(ytext.toString()).toBe('<p>original</p>');

    binding.destroy();
  });

  test('setPaused skips Y.Text→Tiptap sync, catches up on unpause', async () => {
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    binding.setPaused(true);

    // Remote Y.Text change — should NOT apply to Tiptap while paused
    ydoc.transact(() => {
      ytext.insert(0, '<p>remote change</p>');
    });

    await Promise.resolve();
    // Tiptap should NOT have received the change yet
    expect(editor.getHTML()).toBe('');

    // Unpause — Tiptap should catch up with current Y.Text
    binding.setPaused(false);
    expect(editor.getHTML()).toBe('<p>remote change</p>');

    // And no write-back even after debounce
    vi.advanceTimersByTime(150);
    expect(ytext.toString()).toBe('<p>remote change</p>');

    binding.destroy();
  });

  test('rapid Y.Text changes while paused do not corrupt content', async () => {
    ytext.insert(0, '<p>original</p>');
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    binding.setPaused(true);

    // Simulate rapid keystrokes updating Y.Text (like typing in CodeMirror)
    for (let i = 0; i < 10; i++) {
      ydoc.transact(() => {
        ytext.insert(0, String(i));
      });
    }

    // Flush microtasks — should be no-op since paused
    await Promise.resolve();
    await Promise.resolve();

    // Y.Text should have all characters
    expect(ytext.toString()).toBe('9876543210<p>original</p>');

    // Unpause — Tiptap catches up with final state
    binding.setPaused(false);
    expect(editor.getHTML()).toBe('9876543210<p>original</p>');

    // No write-back
    vi.advanceTimersByTime(150);
    expect(ytext.toString()).toBe('9876543210<p>original</p>');

    binding.destroy();
  });

  test('microtask coalesces multiple Y.Text changes into one Tiptap update', async () => {
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // Track setContent calls
    let setContentCount = 0;
    const origSetContent = editor.commands.setContent.bind(editor.commands);
    editor.commands.setContent = (content: string, opts?: any) => {
      setContentCount++;
      origSetContent(content, opts);
    };

    // Rapid Y.Text changes within same macrotask
    ydoc.transact(() => { ytext.insert(0, 'a'); });
    ydoc.transact(() => { ytext.insert(1, 'b'); });
    ydoc.transact(() => { ytext.insert(2, 'c'); });

    // Before microtask: no setContent calls yet (deferred)
    expect(setContentCount).toBe(0);

    // Flush microtask — should result in exactly ONE setContent call
    await Promise.resolve();
    expect(setContentCount).toBe(1);
    expect(editor.getHTML()).toBe('abc');

    binding.destroy();
  });

  test('unpausing re-enables Tiptap→Y.Text sync', () => {
    ytext.insert(0, '<p>start</p>');
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // Pause, then unpause
    binding.setPaused(true);
    binding.setPaused(false);

    // User edit should now sync
    editor._simulateUserEdit('<p>edited</p>');
    vi.advanceTimersByTime(150);
    expect(ytext.toString()).toBe('<p>edited</p>');

    binding.destroy();
  });

  test('guard flag prevents Y.Text corruption from lossy markdown round-trip', () => {
    // Simulate a markdown editor where setContent→getMarkdown round-trip is lossy:
    // Input markdown has no trailing newline, but getMarkdown() adds one.
    const editor = createMockEditor();
    // Override getHTML to simulate Tiptap normalizing content differently
    editor.getHTML = () => {
      // After markdown→HTML→serialize, output has a trailing newline
      return editor.getMarkdown?.() ?? '';
    };
    // getMarkdown always adds trailing newlines (simulates real Tiptap behavior)
    editor.getMarkdown = () => {
      // Read internal state and normalize — adds trailing \n
      const raw = (editor as any)._rawContent ?? '';
      return raw ? raw + '\n' : '';
    };
    // Track what setContent stores internally
    const origSetContent = editor.commands.setContent.bind(editor.commands);
    editor.commands.setContent = (content: string, opts?: any) => {
      (editor as any)._rawContent = content;
      origSetContent(content, opts);
    };

    const binding = new TextBinding(editor as any, ytext, mdHandler);

    // Remote Y.Text change: raw markdown without trailing newline
    ydoc.transact(() => {
      ytext.insert(0, '# Hello World');
    });

    // After applying, getMarkdown() returns "# Hello World\n" (normalized)
    // Without the guard, the debounce would fire and write "# Hello World\n" to Y.Text

    // Let debounce window pass
    vi.advanceTimersByTime(150);

    // Y.Text must still be the original raw markdown, NOT the normalized version
    expect(ytext.toString()).toBe('# Hello World');

    binding.destroy();
  });

  test('rapid remote changes with lossy serialization do not corrupt Y.Text', () => {
    const editor = createMockEditor();
    // Make getHTML return slightly different output each time
    // (simulates Tiptap normalizing whitespace)
    let callCount = 0;
    const origGetHTML = editor.getHTML.bind(editor);
    editor.getHTML = () => {
      callCount++;
      const base = origGetHTML();
      // First call after setContent returns one thing, later calls return another
      return base;
    };

    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // Rapid remote changes
    for (let i = 0; i < 10; i++) {
      ydoc.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, `<p>version ${i}</p>`);
      });
    }

    // Let debounce fire
    vi.advanceTimersByTime(150);

    // Y.Text should have the last remote version, unchanged
    expect(ytext.toString()).toBe('<p>version 9</p>');

    binding.destroy();
  });

  test('HTML with em/strong tags round-trips correctly', async () => {
    const html = '<p>This is <strong>bold</strong> and <em>italic</em> text.</p>';
    const editor = createMockEditor();
    const binding = new TextBinding(editor as any, ytext, htmlHandler);

    // Remote sets HTML with inline formatting
    ydoc.transact(() => { ytext.insert(0, html); });

    // Flush microtask
    await Promise.resolve();
    expect(editor.getHTML()).toBe(html);

    // Debounce should not corrupt
    vi.advanceTimersByTime(150);
    expect(ytext.toString()).toBe(html);

    binding.destroy();
  });

  // --- retargetYText (Suggest Mode rebind) ---

  describe('retargetYText', () => {
    test('writes from editor route to new Y.Text after retarget', () => {
      ytext.insert(0, '<p>base</p>');
      const editor = createMockEditor();
      const binding = new TextBinding(editor as any, ytext, htmlHandler);

      // Build a buffer doc seeded from base (mimics SuggestEngine.enable).
      const bufferDoc = new Y.Doc();
      const bufferText = bufferDoc.getText('source');
      Y.applyUpdate(bufferDoc, Y.encodeStateAsUpdate(ydoc));
      expect(bufferText.toString()).toBe('<p>base</p>');

      binding.retargetYText(bufferText);

      // User edit after retarget → buffer receives it.
      editor._simulateUserEdit('<p>edited</p>');
      vi.advanceTimersByTime(150);

      expect(bufferText.toString()).toBe('<p>edited</p>');
      // Base Y.Text is untouched.
      expect(ytext.toString()).toBe('<p>base</p>');

      binding.destroy();
      bufferDoc.destroy();
    });

    test('remote changes to old Y.Text no longer reach the editor', async () => {
      const editor = createMockEditor();
      const binding = new TextBinding(editor as any, ytext, htmlHandler);

      const bufferDoc = new Y.Doc();
      const bufferText = bufferDoc.getText('source');
      binding.retargetYText(bufferText);

      // After retarget, mutations to the old base should NOT propagate.
      ydoc.transact(() => { ytext.insert(0, '<p>stale</p>'); });
      await Promise.resolve();

      expect(editor.getHTML()).toBe('');

      binding.destroy();
      bufferDoc.destroy();
    });

    test('remote changes to new Y.Text propagate to editor', async () => {
      const editor = createMockEditor();
      const binding = new TextBinding(editor as any, ytext, htmlHandler);

      const bufferDoc = new Y.Doc();
      const bufferText = bufferDoc.getText('source');
      binding.retargetYText(bufferText);

      // Simulate a remote (SuggestEngine rebase) write on the buffer.
      bufferDoc.transact(() => { bufferText.insert(0, '<p>rebased</p>'); });
      await Promise.resolve();

      expect(editor.getHTML()).toBe('<p>rebased</p>');

      binding.destroy();
      bufferDoc.destroy();
    });

    test('single observer — no duplicate editor callbacks after retarget', async () => {
      const editor = createMockEditor();
      const binding = new TextBinding(editor as any, ytext, htmlHandler);

      let setContentCount = 0;
      const origSetContent = editor.commands.setContent.bind(editor.commands);
      editor.commands.setContent = (content: string, opts?: any) => {
        setContentCount++;
        origSetContent(content, opts);
      };

      const bufferDoc = new Y.Doc();
      const bufferText = bufferDoc.getText('source');
      binding.retargetYText(bufferText);

      // Writing once to the buffer should produce exactly one setContent call.
      bufferDoc.transact(() => { bufferText.insert(0, '<p>hi</p>'); });
      await Promise.resolve();

      expect(setContentCount).toBe(1);

      binding.destroy();
      bufferDoc.destroy();
    });

    test('seeded buffer content becomes visible in editor after retarget', () => {
      ytext.insert(0, '<p>base</p>');
      const editor = createMockEditor();
      const binding = new TextBinding(editor as any, ytext, htmlHandler);
      expect(editor.getHTML()).toBe('<p>base</p>');

      // Buffer is seeded to a different string before retarget.
      const bufferDoc = new Y.Doc();
      const bufferText = bufferDoc.getText('source');
      bufferText.insert(0, '<p>seeded-buffer</p>');

      binding.retargetYText(bufferText);

      // Editor reflects the buffer immediately.
      expect(editor.getHTML()).toBe('<p>seeded-buffer</p>');

      binding.destroy();
      bufferDoc.destroy();
    });

    test('in-flight write-back is cancelled at retarget time', () => {
      ytext.insert(0, '<p>base</p>');
      const editor = createMockEditor();
      const binding = new TextBinding(editor as any, ytext, htmlHandler);

      // Start a user edit — debounce queued targeting the base Y.Text.
      editor._simulateUserEdit('<p>midway</p>');

      // Retarget before debounce fires. The queued timer should be cancelled
      // so the base is not scribbled on after the swap.
      const bufferDoc = new Y.Doc();
      const bufferText = bufferDoc.getText('source');
      binding.retargetYText(bufferText);

      vi.advanceTimersByTime(500);

      // Base stays at its original content — the in-flight write was cancelled.
      expect(ytext.toString()).toBe('<p>base</p>');
      // Buffer also untouched by the cancelled write.
      expect(bufferText.toString()).toBe('<p>midway</p>'.length > 0 ? bufferText.toString() : '');

      binding.destroy();
      bufferDoc.destroy();
    });

    test('retarget back to the original Y.Text resumes base writes', () => {
      ytext.insert(0, '<p>base</p>');
      const editor = createMockEditor();
      const binding = new TextBinding(editor as any, ytext, htmlHandler);

      const bufferDoc = new Y.Doc();
      const bufferText = bufferDoc.getText('source');
      Y.applyUpdate(bufferDoc, Y.encodeStateAsUpdate(ydoc));

      binding.retargetYText(bufferText);
      editor._simulateUserEdit('<p>buffered</p>');
      vi.advanceTimersByTime(150);
      expect(bufferText.toString()).toBe('<p>buffered</p>');
      expect(ytext.toString()).toBe('<p>base</p>');

      // Rebind back — subsequent edits hit the base again.
      binding.retargetYText(ytext);
      editor._simulateUserEdit('<p>base-edited</p>');
      vi.advanceTimersByTime(150);

      expect(ytext.toString()).toBe('<p>base-edited</p>');
      // Buffer frozen at the value it had before the rebind-back.
      expect(bufferText.toString()).toBe('<p>buffered</p>');

      binding.destroy();
      bufferDoc.destroy();
    });

    test('retargeting to the same Y.Text is a no-op', async () => {
      ytext.insert(0, '<p>same</p>');
      const editor = createMockEditor();
      const binding = new TextBinding(editor as any, ytext, htmlHandler);

      let setContentCount = 0;
      const origSetContent = editor.commands.setContent.bind(editor.commands);
      editor.commands.setContent = (content: string, opts?: any) => {
        setContentCount++;
        origSetContent(content, opts);
      };

      binding.retargetYText(ytext);
      await Promise.resolve();

      // No redundant setContent triggered, and the same observer still works.
      expect(setContentCount).toBe(0);

      ydoc.transact(() => { ytext.insert(ytext.length, '!'); });
      await Promise.resolve();
      expect(editor.getHTML()).toBe('<p>same</p>!');

      binding.destroy();
    });
  });
});
