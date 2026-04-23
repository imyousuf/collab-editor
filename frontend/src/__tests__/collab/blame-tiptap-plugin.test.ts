/**
 * @vitest-environment jsdom
 */
import { describe, test, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { createBlamePlugin, blamePluginKey } from '../../collab/blame-tiptap-plugin.js';
import type { BlameSegment } from '../../collab/blame-engine.js';

function createEditor(html: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [StarterKit],
    content: html,
  });
  return editor;
}

function getPlainText(editor: Editor): string {
  // Get plain text as Y.Text would see it — paragraphs separated by \n
  const doc = editor.state.doc;
  const texts: string[] = [];
  doc.descendants((node) => {
    if (node.isText) {
      texts.push(node.text!);
    } else if (node.isBlock && texts.length > 0) {
      texts.push('\n');
    }
    return true;
  });
  return texts.join('');
}

describe('blame-tiptap-plugin', () => {
  test('createBlamePlugin returns a plugin', () => {
    const plugin = createBlamePlugin();
    expect(plugin).toBeDefined();
    expect(plugin.spec.key).toBe(blamePluginKey);
  });

  describe('blame decorations with simple paragraphs', () => {
    test('single paragraph blame decoration renders', () => {
      const editor = createEditor('<p>hello world</p>');
      editor.registerPlugin(createBlamePlugin());

      const segments: BlameSegment[] = [
        { start: 0, end: 11, userName: 'alice' },
      ];

      const { tr } = editor.state;
      tr.setMeta(blamePluginKey, segments);
      editor.view.dispatch(tr);

      const decoSet = blamePluginKey.getState(editor.state);
      expect(decoSet).toBeDefined();
      // Should have at least one decoration
      let count = 0;
      decoSet?.find().forEach(() => count++);
      expect(count).toBeGreaterThan(0);

      editor.destroy();
    });

    test('two paragraphs with different authors', () => {
      const editor = createEditor('<p>hello</p><p>world</p>');
      editor.registerPlugin(createBlamePlugin());

      // Y.Text would be "hello\nworld" — char offsets 0-5 and 6-11
      const segments: BlameSegment[] = [
        { start: 0, end: 5, userName: 'alice' },
        { start: 6, end: 11, userName: 'bob' },
      ];

      const { tr } = editor.state;
      tr.setMeta(blamePluginKey, segments);
      editor.view.dispatch(tr);

      const decoSet = blamePluginKey.getState(editor.state);
      let count = 0;
      decoSet?.find().forEach(() => count++);
      // Should have 2 decorations (one per segment)
      expect(count).toBe(2);

      editor.destroy();
    });
  });

  describe('blame decorations with complex documents', () => {
    test('heading + paragraph', () => {
      const editor = createEditor('<h1>Title</h1><p>Body text</p>');
      editor.registerPlugin(createBlamePlugin());

      // Y.Text: "Title\nBody text" — 0-5 and 6-15
      const segments: BlameSegment[] = [
        { start: 0, end: 5, userName: 'alice' },
        { start: 6, end: 15, userName: 'bob' },
      ];

      const { tr } = editor.state;
      tr.setMeta(blamePluginKey, segments);
      editor.view.dispatch(tr);

      const decoSet = blamePluginKey.getState(editor.state);
      let count = 0;
      decoSet?.find().forEach(() => count++);
      expect(count).toBe(2);

      editor.destroy();
    });

    test('three paragraphs', () => {
      const editor = createEditor('<p>aaa</p><p>bbb</p><p>ccc</p>');
      editor.registerPlugin(createBlamePlugin());

      // Y.Text: "aaa\nbbb\nccc" — 0-3, 4-7, 8-11
      const segments: BlameSegment[] = [
        { start: 0, end: 3, userName: 'alice' },
        { start: 4, end: 7, userName: 'bob' },
        { start: 8, end: 11, userName: 'charlie' },
      ];

      const { tr } = editor.state;
      tr.setMeta(blamePluginKey, segments);
      editor.view.dispatch(tr);

      const decoSet = blamePluginKey.getState(editor.state);
      let count = 0;
      decoSet?.find().forEach(() => count++);
      expect(count).toBe(3);

      editor.destroy();
    });

    test('empty paragraphs are handled', () => {
      const editor = createEditor('<p>hello</p><p></p><p>world</p>');
      editor.registerPlugin(createBlamePlugin());

      // Y.Text: "hello\n\nworld" — 0-5, 6 (empty), 7-12
      const segments: BlameSegment[] = [
        { start: 0, end: 5, userName: 'alice' },
        { start: 7, end: 12, userName: 'bob' },
      ];

      const { tr } = editor.state;
      tr.setMeta(blamePluginKey, segments);
      editor.view.dispatch(tr);

      // Should not throw
      const decoSet = blamePluginKey.getState(editor.state);
      expect(decoSet).toBeDefined();

      editor.destroy();
    });

    test('null segments clears decorations', () => {
      const editor = createEditor('<p>hello</p>');
      editor.registerPlugin(createBlamePlugin());

      // Add decorations
      const { tr: tr1 } = editor.state;
      tr1.setMeta(blamePluginKey, [{ start: 0, end: 5, userName: 'alice' }]);
      editor.view.dispatch(tr1);

      // Clear
      const { tr: tr2 } = editor.state;
      tr2.setMeta(blamePluginKey, null);
      editor.view.dispatch(tr2);

      const decoSet = blamePluginKey.getState(editor.state);
      let count = 0;
      decoSet?.find().forEach(() => count++);
      expect(count).toBe(0);

      editor.destroy();
    });

    test('bullet list items', () => {
      const editor = createEditor('<ul><li><p>item 1</p></li><li><p>item 2</p></li></ul>');
      editor.registerPlugin(createBlamePlugin());

      // Y.Text for a bullet list: "item 1\nitem 2"
      const segments: BlameSegment[] = [
        { start: 0, end: 6, userName: 'alice' },
        { start: 7, end: 13, userName: 'bob' },
      ];

      // Should not throw
      const { tr } = editor.state;
      tr.setMeta(blamePluginKey, segments);
      expect(() => editor.view.dispatch(tr)).not.toThrow();

      editor.destroy();
    });

    test('code block', () => {
      const editor = createEditor('<pre><code>function hello() {}</code></pre>');
      editor.registerPlugin(createBlamePlugin());

      const segments: BlameSegment[] = [
        { start: 0, end: 20, userName: 'alice' },
      ];

      const { tr } = editor.state;
      tr.setMeta(blamePluginKey, segments);
      expect(() => editor.view.dispatch(tr)).not.toThrow();

      editor.destroy();
    });

    test('mixed content: heading + paragraph + list', () => {
      const editor = createEditor(
        '<h1>Title</h1><p>Some text</p><ul><li><p>item</p></li></ul>'
      );
      editor.registerPlugin(createBlamePlugin());

      // Rough Y.Text: "Title\nSome text\nitem"
      const segments: BlameSegment[] = [
        { start: 0, end: 5, userName: 'alice' },
        { start: 6, end: 15, userName: 'bob' },
        { start: 16, end: 20, userName: 'charlie' },
      ];

      const { tr } = editor.state;
      tr.setMeta(blamePluginKey, segments);
      expect(() => editor.view.dispatch(tr)).not.toThrow();

      const decoSet = blamePluginKey.getState(editor.state);
      expect(decoSet).toBeDefined();

      editor.destroy();
    });

    test('segments with out-of-range offsets are silently skipped', () => {
      const editor = createEditor('<p>hi</p>');
      editor.registerPlugin(createBlamePlugin());

      // Segment way beyond document length
      const segments: BlameSegment[] = [
        { start: 0, end: 2, userName: 'alice' },
        { start: 100, end: 200, userName: 'bob' },
      ];

      const { tr } = editor.state;
      tr.setMeta(blamePluginKey, segments);
      expect(() => editor.view.dispatch(tr)).not.toThrow();

      editor.destroy();
    });

    test('full-document segment with end exceeding PM text length is clamped', () => {
      // Simulates the real scenario: Y.Text has raw markdown (e.g. "# Title\n\nBody")
      // which is longer than the ProseMirror text content ("Title\nBody").
      // The blame segment covers the full Y.Text length, but PM has fewer chars.
      const editor = createEditor('<h1>Title</h1><p>Body</p>');
      editor.registerPlugin(createBlamePlugin());

      // PM text content is "Title\nBody" = 10 chars, but Y.Text markdown
      // "# Title\n\nBody" = 14 chars. Segment end=14 exceeds PM's 10.
      const segments: BlameSegment[] = [
        { start: 0, end: 14, userName: 'alice' },
      ];

      const { tr } = editor.state;
      tr.setMeta(blamePluginKey, segments);
      editor.view.dispatch(tr);

      const decoSet = blamePluginKey.getState(editor.state);
      let count = 0;
      decoSet?.find().forEach(() => count++);
      // Should produce at least 1 decoration (clamped to PM doc end)
      expect(count).toBeGreaterThan(0);

      editor.destroy();
    });

    test('decorations survive doc changes', () => {
      const editor = createEditor('<p>hello world</p>');
      editor.registerPlugin(createBlamePlugin());

      const { tr: tr1 } = editor.state;
      tr1.setMeta(blamePluginKey, [{ start: 0, end: 11, userName: 'alice' }]);
      editor.view.dispatch(tr1);

      // Make a doc change
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' more');

      const decoSet = blamePluginKey.getState(editor.state);
      let count = 0;
      decoSet?.find().forEach(() => count++);
      // Decorations should survive (mapped through change)
      expect(count).toBeGreaterThan(0);

      editor.destroy();
    });
  });

  describe('regression: markdown syntax-char offset shift', () => {
    function createMarkdownEditor(md: string): Editor {
      const el = document.createElement('div');
      document.body.appendChild(el);
      // @ts-expect-error — the Markdown extension import isn't typed
      const { Markdown } = require('@tiptap/markdown');
      const editor = new Editor({
        element: el,
        extensions: [StarterKit, Markdown],
      });
      editor.commands.setContent(md, { contentType: 'markdown' } as any);
      return editor;
    }

    test("heading blame: segment on `Hello` does NOT shift onto `#` space", () => {
      const editor = createMarkdownEditor('# Hello');
      editor.registerPlugin(createBlamePlugin());
      // Y.Text offsets [2, 7) cover the word `Hello` — the `# ` prefix
      // is at offsets 0-1 and is NOT part of the rendered PM text.
      const yText = '# Hello';
      const segs: BlameSegment[] = [{ start: 2, end: 7, userName: 'alice' }];
      const { tr } = editor.state;
      tr.setMeta(blamePluginKey, { segments: segs, ytext: { toString: () => yText } as any });
      editor.view.dispatch(tr);

      const decoSet = blamePluginKey.getState(editor.state);
      const found: any[] = [];
      decoSet?.find().forEach((d: any) => found.push(d));
      expect(found).toHaveLength(1);
      // Heading text "Hello" occupies PM pos 1..5 (5 chars). Decoration
      // must cover exactly that range — no shift onto the block boundary.
      expect(found[0].from).toBe(1);
      expect(found[0].to).toBe(6);
      editor.destroy();
    });

    test("inline bold: segment on `3` in `12**3**456` lands on `3` only", () => {
      const editor = createMarkdownEditor('12**3**456');
      editor.registerPlugin(createBlamePlugin());
      const yText = '12**3**456';
      // The `3` lives at Y.Text offset 4 (after `12**`).
      const segs: BlameSegment[] = [{ start: 4, end: 5, userName: 'bob' }];
      const { tr } = editor.state;
      tr.setMeta(blamePluginKey, { segments: segs, ytext: { toString: () => yText } as any });
      editor.view.dispatch(tr);

      const decoSet = blamePluginKey.getState(editor.state);
      const found: any[] = [];
      decoSet?.find().forEach((d: any) => found.push(d));
      expect(found).toHaveLength(1);
      // `3` is a single-char text node inside the <strong> mark. It's
      // bounded by tiny PM positions — assert the decoration is exactly
      // one PM char wide.
      expect(found[0].to - found[0].from).toBe(1);
      editor.destroy();
    });

    test('no spillover across block boundary', () => {
      // `# H\n\nbody`: if a segment from `H` was attributed to userA
      // and a segment from `body` was attributed to userB, neither
      // decoration should span the \n\n gap.
      const editor = createMarkdownEditor('# H\n\nbody');
      editor.registerPlugin(createBlamePlugin());
      const yText = '# H\n\nbody';

      const segs: BlameSegment[] = [
        { start: 2, end: 3, userName: 'alice' }, // `H`
        { start: 5, end: 9, userName: 'bob' }, // `body`
      ];
      const { tr } = editor.state;
      tr.setMeta(blamePluginKey, { segments: segs, ytext: { toString: () => yText } as any });
      editor.view.dispatch(tr);

      const decoSet = blamePluginKey.getState(editor.state);
      const found: any[] = [];
      decoSet?.find().forEach((d: any) => found.push(d));
      expect(found).toHaveLength(2);

      const aliceDec = found.find((d: any) => d.type.attrs['data-blame-user'] === 'alice');
      const bobDec = found.find((d: any) => d.type.attrs['data-blame-user'] === 'bob');
      expect(aliceDec).toBeDefined();
      expect(bobDec).toBeDefined();
      // Alice's decoration must end before Bob's begins — no overlap.
      expect(aliceDec.to).toBeLessThanOrEqual(bobDec.from);
      // Alice's decoration is 1 PM char wide (`H`).
      expect(aliceDec.to - aliceDec.from).toBe(1);
      // Bob's decoration is 4 PM chars wide (`body`).
      expect(bobDec.to - bobDec.from).toBe(4);
      editor.destroy();
    });
  });
});
