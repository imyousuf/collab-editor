/**
 * @vitest-environment jsdom
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const renderMock = vi.fn(async (_id: string, code: string) => {
  if (!code || code.includes('BOOM')) throw new Error('parse error');
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" data-code="${code.length}"><g/></svg>` };
});

vi.mock('mermaid', () => ({
  default: { initialize: vi.fn(), render: renderMock },
}));

import '../../toolbar/mermaid-edit-dialog.js';
import type { MermaidEditDialog } from '../../toolbar/mermaid-edit-dialog.js';
import { __resetMermaidLoaderForTests } from '../../collab/mermaid-renderer.js';

async function mount(source: string): Promise<MermaidEditDialog> {
  const el = document.createElement('mermaid-edit-dialog') as MermaidEditDialog;
  el.source = source;
  document.body.appendChild(el);
  el.open = true;
  await (el as any).updateComplete;
  return el;
}

function flush(ms = 300): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('mermaid-edit-dialog', () => {
  beforeEach(() => {
    renderMock.mockClear();
    __resetMermaidLoaderForTests();
    document.body.innerHTML = '';
  });

  test('initial render renders the source as preview SVG', async () => {
    const dlg = await mount('graph TD\nA-->B');
    await flush(50); // immediate render path is async via the mermaid promise
    const svg = dlg.shadowRoot!.querySelector('.preview svg');
    expect(svg).toBeTruthy();
  });

  test('Save dispatches mermaid-save with the edited draft', async () => {
    const dlg = await mount('graph TD\nA-->B');
    let detail: any = null;
    dlg.addEventListener('mermaid-save', (e: any) => { detail = e.detail; });

    const ta = dlg.shadowRoot!.querySelector('textarea')! as HTMLTextAreaElement;
    ta.value = 'graph LR\nX-->Y';
    ta.dispatchEvent(new Event('input'));
    await (dlg as any).updateComplete;

    const save = Array.from(dlg.shadowRoot!.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save',
    )!;
    save.click();

    expect(detail).toEqual({ source: 'graph LR\nX-->Y' });
  });

  test('Cancel dispatches mermaid-cancel', async () => {
    const dlg = await mount('graph TD\nA-->B');
    let cancelled = false;
    dlg.addEventListener('mermaid-cancel', () => { cancelled = true; });

    const cancel = Array.from(dlg.shadowRoot!.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Cancel',
    )!;
    cancel.click();

    expect(cancelled).toBe(true);
  });

  test('Esc cancels, Cmd+Enter saves', async () => {
    const dlg = await mount('graph TD\nA-->B');
    let saved: any = null;
    let cancelled = false;
    dlg.addEventListener('mermaid-save', (e: any) => { saved = e.detail; });
    dlg.addEventListener('mermaid-cancel', () => { cancelled = true; });

    const ta = dlg.shadowRoot!.querySelector('textarea')! as HTMLTextAreaElement;
    ta.value = 'graph TD\nC-->D';
    ta.dispatchEvent(new Event('input'));
    await (dlg as any).updateComplete;

    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    expect(saved).toEqual({ source: 'graph TD\nC-->D' });

    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cancelled).toBe(true);
  });

  test('parse error renders an inline error block', async () => {
    const dlg = await mount('graph TD\nA-->B');
    await flush(50);

    const ta = dlg.shadowRoot!.querySelector('textarea')! as HTMLTextAreaElement;
    ta.value = 'BOOM';
    ta.dispatchEvent(new Event('input'));

    // Debounced 250ms; wait past it.
    await flush(400);
    await (dlg as any).updateComplete;

    const err = dlg.shadowRoot!.querySelector('.preview .error');
    expect(err?.textContent).toContain('parse error');
  });

  test('typing debounces preview rendering', async () => {
    const dlg = await mount('graph TD\nA-->B');
    await flush(50);
    const initial = renderMock.mock.calls.length;

    const ta = dlg.shadowRoot!.querySelector('textarea')! as HTMLTextAreaElement;
    // Three quick keystrokes within the debounce window.
    ta.value = 'graph TD\nA-->B\nC';
    ta.dispatchEvent(new Event('input'));
    ta.value = 'graph TD\nA-->B\nC-';
    ta.dispatchEvent(new Event('input'));
    ta.value = 'graph TD\nA-->B\nC->D';
    ta.dispatchEvent(new Event('input'));

    // Before debounce fires.
    await flush(50);
    expect(renderMock.mock.calls.length).toBe(initial);

    // After debounce.
    await flush(300);
    expect(renderMock.mock.calls.length).toBe(initial + 1);
  });
});
