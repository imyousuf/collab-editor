/**
 * @vitest-environment jsdom
 *
 * Unit tests for the shared PM <-> Y.Text position helper.
 *
 * The helper is what fixes the "blame on `t` instead of `s`" bug and
 * the "rest of doc turns pink" spillover. It replaces a pair of
 * duplicated, buggy `buildPositionMap` functions in
 * blame-tiptap-plugin.ts and comment-tiptap-plugin.ts.
 */
import { describe, test, expect } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import {
  buildPositionMap,
  snapRange,
  findFormattingOverrides,
  collectClientsInRange,
  DEFAULT_DELIMITERS,
} from '../../collab/pm-position-map.js';

function makeTiptapFromMarkdown(md: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [StarterKit, Markdown],
    content: md,
  });
  // setContent via the markdown option forces the Markdown parser path.
  editor.commands.setContent(md, { contentType: 'markdown' } as any);
  return editor;
}

function makeTiptapFromHtml(html: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [StarterKit],
    content: html,
  });
}

describe('buildPositionMap', () => {
  test('plain text maps 1:1 to PM positions', () => {
    const editor = makeTiptapFromMarkdown('hello world');
    const map = buildPositionMap(editor.state.doc, 'hello world');
    // PM pos 1 = 'h', pos 2 = 'e', ...
    expect(map.get(0)).toBe(1);
    expect(map.get(4)).toBe(5); // 'o'
    expect(map.get(10)).toBe(11); // 'd'
    editor.destroy();
  });

  test('markdown heading: # and leading space are absent from map', () => {
    const editor = makeTiptapFromMarkdown('# Hello');
    const map = buildPositionMap(editor.state.doc, '# Hello');

    expect(map.get(0)).toBeUndefined(); // '#' is syntax
    expect(map.get(1)).toBeUndefined(); // ' ' is syntax
    expect(map.get(2)).toBe(1); // 'H'
    expect(map.get(3)).toBe(2); // 'e'
    expect(map.get(6)).toBe(5); // 'o'
    editor.destroy();
  });

  test('markdown list item: "- " prefix is absent from map', () => {
    const editor = makeTiptapFromMarkdown('- item');
    const map = buildPositionMap(editor.state.doc, '- item');

    expect(map.get(0)).toBeUndefined();
    expect(map.get(1)).toBeUndefined();
    expect(map.get(2)).toBeDefined(); // 'i'
    expect(map.get(5)).toBeDefined(); // 'm'
    editor.destroy();
  });

  test('multi-block: block separator \\n\\n is absent, no accumulated drift', () => {
    const md = '# H\n\nbody';
    const editor = makeTiptapFromMarkdown(md);
    const map = buildPositionMap(editor.state.doc, md);

    // 'H' in heading.
    expect(map.get(2)).toBe(1);
    // '\n\n' unmapped.
    expect(map.get(3)).toBeUndefined();
    expect(map.get(4)).toBeUndefined();
    // 'b' in paragraph. PM pos depends on doc structure but MUST map.
    expect(map.get(5)).toBeDefined();
    expect(map.get(6)).toBeDefined(); // 'o'
    expect(map.get(7)).toBeDefined(); // 'd'
    expect(map.get(8)).toBeDefined(); // 'y'

    // Regression guard: the OLD bug was an accumulated undercount. For
    // `# H\n\nbody` the correct PM position of 'b' is 4 (after h1 open
    // at 1, 'H' at 2, </h1> at 3, <p> open at 4). The old helper
    // returned 3 (undercounting the block separator by 1).
    const bPos = map.get(5)!;
    expect(bPos).toBeGreaterThanOrEqual(4);
    editor.destroy();
  });

  test('inline bold: 12**3**456 keeps the ** offsets unmapped', () => {
    const editor = makeTiptapFromMarkdown('12**3**456');
    const map = buildPositionMap(editor.state.doc, '12**3**456');

    // '1', '2' visible
    expect(map.get(0)).toBeDefined();
    expect(map.get(1)).toBeDefined();
    // '**' syntax
    expect(map.get(2)).toBeUndefined();
    expect(map.get(3)).toBeUndefined();
    // '3' is visible bold content — MUST map
    expect(map.get(4)).toBeDefined();
    // closing '**' syntax
    expect(map.get(5)).toBeUndefined();
    expect(map.get(6)).toBeUndefined();
    // '4', '5', '6' visible
    expect(map.get(7)).toBeDefined();
    expect(map.get(8)).toBeDefined();
    expect(map.get(9)).toBeDefined();
    editor.destroy();
  });

  test('HTML tags are absent from map; visible chars map', () => {
    const editor = makeTiptapFromHtml('<p>Hello <strong>world</strong></p>');
    const html = '<p>Hello <strong>world</strong></p>';
    const map = buildPositionMap(editor.state.doc, html);

    // 'H' of "Hello " maps
    const hIdx = html.indexOf('H');
    expect(map.get(hIdx)).toBeDefined();

    // Space is visible too
    const spaceIdx = html.indexOf(' ');
    expect(map.get(spaceIdx)).toBeDefined();

    // 'w' of "world" maps
    const wIdx = html.indexOf('w');
    expect(map.get(wIdx)).toBeDefined();

    // '<', '>' inside tags are syntax and must be unmapped
    const tagOpen = html.indexOf('<');
    expect(map.get(tagOpen)).toBeUndefined();
    editor.destroy();
  });

  test('empty doc returns empty map', () => {
    const editor = makeTiptapFromMarkdown('');
    const map = buildPositionMap(editor.state.doc, '');
    expect(map.size).toBe(0);
    editor.destroy();
  });

  test('does not throw on unmatchable PM text (content handler normalized)', () => {
    // Build a PM doc whose text cannot be found in the given Y.Text.
    // The helper should skip the node without throwing.
    const editor = makeTiptapFromMarkdown('hello');
    expect(() => buildPositionMap(editor.state.doc, 'goodbye')).not.toThrow();
    editor.destroy();
  });
});

describe('snapRange', () => {
  function makeMap(pairs: [number, number][]): Map<number, number> {
    const m = new Map<number, number>();
    for (const [k, v] of pairs) m.set(k, v);
    return m;
  }

  test('identity map: exact matches', () => {
    const m = makeMap([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(snapRange(0, 3, m)).toEqual({ from: 1, to: 4 });
  });

  test('start in a gap snaps forward to the next mapped offset', () => {
    // Y.Text `# Hi`: offsets 0,1 are `#` and ` `, offsets 2,3 are `H`,
    // `i`. Map reflects that.
    const m = makeMap([
      [2, 1],
      [3, 2],
    ]);
    // Caller asked for a range starting at 0 (in the `#`) through 4.
    expect(snapRange(0, 4, m)).toEqual({ from: 1, to: 3 });
  });

  test('end in a gap snaps backward to the previous mapped offset', () => {
    // As above — but range is exactly the delimiter.
    const m = makeMap([
      [2, 1],
      [3, 2],
    ]);
    // Range entirely inside syntax → nothing to render.
    expect(snapRange(0, 2, m)).toEqual({});
  });

  test('range entirely inside a gap returns empty', () => {
    // Map of `**3**`: only offset 2 (the `3`) is mapped.
    const m = makeMap([[2, 3]]);
    // Range [5, 7) is inside the closing `**` — no mapped offset.
    expect(snapRange(5, 7, m)).toEqual({});
  });

  test('empty or inverted range returns empty', () => {
    const m = makeMap([
      [0, 1],
      [1, 2],
    ]);
    expect(snapRange(1, 1, m)).toEqual({});
    expect(snapRange(2, 1, m)).toEqual({});
  });

  test('empty map returns empty', () => {
    expect(snapRange(0, 5, new Map())).toEqual({});
  });
});

describe('findFormattingOverrides', () => {
  test('no overrides when a single client owns both delimiter and text', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('t');
    // One client inserts the whole thing including the ** delimiters.
    ytext.insert(0, '**bold**');
    const editor = makeTiptapFromMarkdown(ytext.toString());

    const clients = new Map<number, string>();
    clients.set(ydoc.clientID, 'Alice');
    const overrides = findFormattingOverrides(editor.state.doc, ytext, clients);
    expect(overrides).toHaveLength(0);
    editor.destroy();
  });

  test('override fires when a different client wrapped existing text', () => {
    // Simulate User-B originally typed plain `bold`, User-A later
    // inserted the ** delimiters around it. We emulate this by
    // splitting inserts across two Y.Docs with separate clientIDs and
    // merging state.
    const docB = new Y.Doc();
    const ytextB = docB.getText('t');
    ytextB.insert(0, 'bold');

    const docA = new Y.Doc();
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    const ytextA = docA.getText('t');
    ytextA.insert(0, '**');
    ytextA.insert(6, '**');

    const rendered = ytextA.toString();
    expect(rendered).toBe('**bold**');
    const editor = makeTiptapFromMarkdown(rendered);

    const clients = new Map<number, string>();
    clients.set(docB.clientID, 'UserB');
    clients.set(docA.clientID, 'UserA');

    const overrides = findFormattingOverrides(editor.state.doc, ytextA, clients);
    expect(overrides).toHaveLength(1);
    expect(overrides[0].delimiterUser).toBe('UserA');
    expect(overrides[0].textUser).toBe('UserB');
    // PM range must cover the four visible chars of "bold".
    expect(overrides[0].to - overrides[0].from).toBe(4);

    editor.destroy();
  });

  test('override does NOT fire when the inner text has multiple authors', () => {
    const docB = new Y.Doc();
    const ytextB = docB.getText('t');
    ytextB.insert(0, 'bo');

    const docC = new Y.Doc();
    Y.applyUpdate(docC, Y.encodeStateAsUpdate(docB));
    const ytextC = docC.getText('t');
    ytextC.insert(2, 'ld');

    const docA = new Y.Doc();
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docC));
    const ytextA = docA.getText('t');
    ytextA.insert(0, '**');
    ytextA.insert(6, '**');

    const editor = makeTiptapFromMarkdown(ytextA.toString());
    const clients = new Map<number, string>([
      [docA.clientID, 'A'],
      [docB.clientID, 'B'],
      [docC.clientID, 'C'],
    ]);
    const overrides = findFormattingOverrides(editor.state.doc, ytextA, clients);
    expect(overrides).toHaveLength(0);
    editor.destroy();
  });

  test('delimiter registry default list covers Tiptap StarterKit mark names', () => {
    const marks = DEFAULT_DELIMITERS.map((d) => d.mark);
    // Tiptap StarterKit names.
    expect(marks).toContain('bold');
    expect(marks).toContain('italic');
    expect(marks).toContain('code');
    expect(marks).toContain('strike');
    // ProseMirror canonical aliases (so non-Tiptap consumers still match).
    expect(marks).toContain('strong');
    expect(marks).toContain('em');
    // HTML variants too.
    const opens = DEFAULT_DELIMITERS.map((d) => d.open);
    expect(opens).toContain('<strong>');
    expect(opens).toContain('<em>');
    expect(opens).toContain('<code>');
  });
});

describe('collectClientsInRange', () => {
  test('collects single client for single-item Y.Text', () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('t');
    ytext.insert(0, 'hello');
    const clients = collectClientsInRange(ytext, 0, 5);
    expect(clients.size).toBe(1);
    expect(clients.has(ydoc.clientID)).toBe(true);
  });

  test('collects multiple clients from merged docs', () => {
    const docA = new Y.Doc();
    const ytextA = docA.getText('t');
    ytextA.insert(0, 'AA');

    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const ytextB = docB.getText('t');
    ytextB.insert(2, 'BB');

    const clients = collectClientsInRange(ytextB, 0, 4);
    expect(clients.size).toBe(2);
    expect(clients.has(docA.clientID)).toBe(true);
    expect(clients.has(docB.clientID)).toBe(true);
  });

  test('ignores items outside the requested range', () => {
    const docA = new Y.Doc();
    const ytextA = docA.getText('t');
    ytextA.insert(0, 'AA');

    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const ytextB = docB.getText('t');
    ytextB.insert(2, 'BB');

    // Only query the AA range — should not include docB's client.
    const clients = collectClientsInRange(ytextB, 0, 2);
    expect(clients.size).toBe(1);
    expect(clients.has(docA.clientID)).toBe(true);
  });
});
