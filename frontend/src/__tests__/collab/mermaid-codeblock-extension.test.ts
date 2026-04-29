/**
 * @vitest-environment jsdom
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const initializeMock = vi.fn();
const renderMock = vi.fn(async (_id: string, code: string) => {
  if (!code || code.includes('BOOM')) throw new Error('parse error');
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" data-len="${code.length}"><g/></svg>` };
});
vi.mock('mermaid', () => ({
  default: { initialize: initializeMock, render: renderMock },
}));

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { MermaidCodeBlock } from '../../collab/mermaid-codeblock-extension.js';
import type { MermaidEditRequestDetail } from '../../collab/mermaid-codeblock-extension.js';
import { __resetMermaidLoaderForTests } from '../../collab/mermaid-renderer.js';

function makeEditor(initial: string, opts?: { editable?: boolean }): { editor: Editor; el: HTMLDivElement } {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [StarterKit.configure({ codeBlock: false }), Markdown, MermaidCodeBlock],
    editable: opts?.editable !== false,
    content: initial,
  });
  // Tiptap's initial content as markdown:
  (editor.commands as any).setContent(initial, { contentType: 'markdown' });
  return { editor, el };
}

function tick(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('MermaidCodeBlock extension', () => {
  beforeEach(() => {
    initializeMock.mockClear();
    renderMock.mockClear();
    __resetMermaidLoaderForTests();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('language="mermaid" mounts the custom node view with pencil', async () => {
    const { editor, el } = makeEditor('```mermaid\ngraph TD\nA-->B\n```\n');
    await tick(80);
    const block = el.querySelector('.me-mermaid-block');
    expect(block).toBeTruthy();
    expect(block?.querySelector('.me-mermaid-edit-btn')).toBeTruthy();
    editor.destroy();
  });

  test('non-mermaid language falls through to default code-block rendering', async () => {
    const { editor, el } = makeEditor('```javascript\nconsole.log(1)\n```\n');
    await tick(50);
    expect(el.querySelector('.me-mermaid-block')).toBeNull();
    expect(el.querySelector('pre')).toBeTruthy();
    editor.destroy();
  });

  test('pencil click dispatches mermaid-edit-request with from/to/source', async () => {
    const { editor, el } = makeEditor('```mermaid\ngraph TD\nA-->B\n```\n');
    await tick(80);
    let detail: MermaidEditRequestDetail | null = null;
    el.addEventListener('mermaid-edit-request', (e: Event) => {
      detail = (e as CustomEvent<MermaidEditRequestDetail>).detail;
    });
    const btn = el.querySelector('.me-mermaid-edit-btn') as HTMLButtonElement;
    btn.click();
    expect(detail).not.toBeNull();
    const d = detail as unknown as MermaidEditRequestDetail;
    expect(d.source).toBe('graph TD\nA-->B');
    expect(d.from).toBeGreaterThanOrEqual(0);
    expect(d.to).toBeGreaterThan(d.from);
    editor.destroy();
  });

  test('updating the block source re-renders the SVG', async () => {
    const { editor, el } = makeEditor('```mermaid\ngraph TD\nA-->B\n```\n');
    await tick(80);
    const renderArea = el.querySelector('.me-mermaid-render')!;
    const initialSvg = renderArea.querySelector('svg');
    expect(initialSvg).toBeTruthy();

    const initialCalls = renderMock.mock.calls.length;
    // Simulate the dialog Save by replacing the block's content.
    const { state, view } = editor;
    const codeBlockType = state.schema.nodes.codeBlock!;
    let from = 0;
    let to = 0;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'codeBlock') {
        from = pos;
        to = pos + node.nodeSize;
        return false;
      }
      return true;
    });
    const tr = state.tr.replaceRangeWith(
      from,
      to,
      codeBlockType.create({ language: 'mermaid' }, state.schema.text('graph LR\nX-->Y')),
    );
    view.dispatch(tr);

    // Debounced 250ms.
    await tick(400);
    expect(renderMock.mock.calls.length).toBeGreaterThan(initialCalls);
    editor.destroy();
  });

  test('readonly editor hides the pencil', async () => {
    const { editor, el } = makeEditor('```mermaid\ngraph TD\nA-->B\n```\n', { editable: false });
    await tick(80);
    const btn = el.querySelector('.me-mermaid-edit-btn') as HTMLButtonElement | null;
    expect(btn).toBeTruthy();
    expect(btn!.style.display).toBe('none');
    editor.destroy();
  });

  test('multiple mermaid blocks share one mermaid runtime load', async () => {
    const md =
      '```mermaid\ngraph TD\nA-->B\n```\n\n```mermaid\nsequenceDiagram\nA->>B: hi\n```\n';
    const { editor, el } = makeEditor(md);
    await tick(80);
    const blocks = el.querySelectorAll('.me-mermaid-block');
    expect(blocks.length).toBe(2);
    expect(initializeMock).toHaveBeenCalledTimes(1);
    editor.destroy();
  });

  test('parse error renders an error block instead of SVG', async () => {
    const { editor, el } = makeEditor('```mermaid\nBOOM\n```\n');
    await tick(80);
    const renderArea = el.querySelector('.me-mermaid-render')!;
    expect(renderArea.classList.contains('me-mermaid-error')).toBe(true);
    expect(renderArea.querySelector('.me-mermaid-error-text')?.textContent).toContain('parse error');
    editor.destroy();
  });
});
