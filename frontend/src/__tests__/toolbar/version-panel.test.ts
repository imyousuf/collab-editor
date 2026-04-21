import { describe, test, expect, vi, beforeEach } from 'vitest';
import '../../toolbar/version-panel.js';
import type { VersionPanel } from '../../toolbar/version-panel.js';

async function createPanel(open = true): Promise<VersionPanel> {
  const el = document.createElement('version-panel') as VersionPanel;
  if (open) el.setAttribute('open', '');
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('VersionPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('renders nothing when closed', async () => {
    const el = await createPanel(false);
    expect(el.shadowRoot?.querySelector('.panel')).toBeNull();
  });

  test('renders panel when open', async () => {
    const el = await createPanel();
    expect(el.shadowRoot?.querySelector('.panel')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('.header')).not.toBeNull();
  });

  test('shows empty message when no versions', async () => {
    const el = await createPanel();
    const empty = el.shadowRoot?.querySelector('.empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('No versions yet');
  });

  test('shows hint text when versions exist', async () => {
    const el = await createPanel();
    el.versions = [
      { id: 'v1', created_at: '2026-01-01T00:00:00Z', type: 'manual' as const },
    ];
    await el.updateComplete;
    const hint = el.shadowRoot?.querySelector('.hint');
    expect(hint).not.toBeNull();
    expect(hint?.textContent).toContain('Click two versions');
  });

  test('renders version list items with badges', async () => {
    const el = await createPanel();
    el.versions = [
      { id: 'v1', created_at: '2026-01-01T00:00:00Z', type: 'manual' as const, label: 'First' },
      { id: 'v2', created_at: '2026-01-02T00:00:00Z', type: 'auto' as const },
    ];
    await el.updateComplete;

    const items = el.shadowRoot?.querySelectorAll('.version-item');
    expect(items?.length).toBe(2);

    const badges = el.shadowRoot?.querySelectorAll('.version-badge');
    expect(badges?.[0]?.textContent).toBe('manual');
    expect(badges?.[1]?.textContent).toBe('auto');
  });

  test('first click highlights version as FROM with tag', async () => {
    const el = await createPanel();
    el.versions = [
      { id: 'v1', created_at: '2026-01-01T00:00:00Z', type: 'manual' as const },
      { id: 'v2', created_at: '2026-01-02T00:00:00Z', type: 'manual' as const },
    ];
    await el.updateComplete;

    const items = el.shadowRoot?.querySelectorAll('.version-item') as NodeListOf<HTMLElement>;
    items[0]?.click();
    await el.updateComplete;

    expect((el as any)._diffFrom).toBe('v1');
    expect((el as any)._diffTo).toBeNull();

    // Should show FROM tag
    const fromTag = el.shadowRoot?.querySelector('.diff-tag.from');
    expect(fromTag).not.toBeNull();
    expect(fromTag?.textContent).toBe('FROM');

    // First item should have diff-from class
    const updatedItems = el.shadowRoot?.querySelectorAll('.version-item');
    expect(updatedItems?.[0]?.classList.contains('diff-from')).toBe(true);
  });

  test('second click on different version sets TO', async () => {
    const el = await createPanel();
    el.versions = [
      { id: 'v1', created_at: '2026-01-01T00:00:00Z', type: 'manual' as const },
      { id: 'v2', created_at: '2026-01-02T00:00:00Z', type: 'manual' as const },
    ];
    await el.updateComplete;

    const items = el.shadowRoot?.querySelectorAll('.version-item') as NodeListOf<HTMLElement>;
    items[0]?.click();
    items[1]?.click();
    await el.updateComplete;

    expect((el as any)._diffFrom).toBe('v1');
    expect((el as any)._diffTo).toBe('v2');

    // Should show both tags
    expect(el.shadowRoot?.querySelector('.diff-tag.from')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('.diff-tag.to')).not.toBeNull();

    // Compare button should be visible in the actions bar
    const compareBtn = el.shadowRoot?.querySelector('.actions .btn-primary');
    expect(compareBtn?.textContent).toContain('Compare');
  });

  test('clicking same FROM version deselects it', async () => {
    const el = await createPanel();
    el.versions = [
      { id: 'v1', created_at: '2026-01-01T00:00:00Z', type: 'manual' as const },
    ];
    await el.updateComplete;

    const items = el.shadowRoot?.querySelectorAll('.version-item') as NodeListOf<HTMLElement>;
    items[0]?.click();
    await el.updateComplete;
    expect((el as any)._diffFrom).toBe('v1');

    items[0]?.click();
    await el.updateComplete;
    expect((el as any)._diffFrom).toBeNull();
    expect((el as any)._diffTo).toBeNull();
  });

  test('Clear button resets selection and dispatches event', async () => {
    const el = await createPanel();
    el.versions = [
      { id: 'v1', created_at: '2026-01-01T00:00:00Z', type: 'manual' as const },
    ];
    await el.updateComplete;

    const items = el.shadowRoot?.querySelectorAll('.version-item') as NodeListOf<HTMLElement>;
    items[0]?.click();
    await el.updateComplete;

    const handler = vi.fn();
    el.addEventListener('version-diff-clear', handler);

    const clearBtn = Array.from(el.shadowRoot?.querySelectorAll('.btn') ?? [])
      .find(b => b.textContent?.includes('Clear')) as HTMLElement;
    clearBtn?.click();
    await el.updateComplete;

    expect((el as any)._diffFrom).toBeNull();
    expect(handler).toHaveBeenCalledOnce();
  });

  test('diff view shows with Back button', async () => {
    const el = await createPanel();
    el.versions = [
      { id: 'v1', created_at: '2026-01-01T00:00:00Z', type: 'manual' as const, label: 'V1' },
      { id: 'v2', created_at: '2026-01-02T00:00:00Z', type: 'manual' as const, label: 'V2' },
    ];
    el.diffResult = [
      { type: 'unchanged' as const, content: 'same', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'removed' as const, content: 'old', oldLineNumber: 2 },
      { type: 'added' as const, content: 'new', newLineNumber: 2 },
    ];
    (el as any)._diffFrom = 'v1';
    (el as any)._diffTo = 'v2';
    (el as any)._view = 'diff';
    await el.updateComplete;

    // Should show diff header with labels
    const diffHeader = el.shadowRoot?.querySelector('.diff-header');
    expect(diffHeader?.textContent).toContain('V1');
    expect(diffHeader?.textContent).toContain('V2');

    // Should show diff lines
    const lines = el.shadowRoot?.querySelectorAll('.diff-line');
    expect(lines?.length).toBe(3);

    // Should have Back button
    const backBtn = diffHeader?.querySelector('.btn');
    expect(backBtn?.textContent).toContain('Back');
  });

  test('Back button returns to list view', async () => {
    const el = await createPanel();
    (el as any)._view = 'diff';
    el.diffResult = [{ type: 'unchanged' as const, content: 'x', oldLineNumber: 1, newLineNumber: 1 }];
    (el as any)._diffFrom = 'v1';
    (el as any)._diffTo = 'v2';
    el.versions = [
      { id: 'v1', created_at: '2026-01-01T00:00:00Z', type: 'manual' as const },
      { id: 'v2', created_at: '2026-01-02T00:00:00Z', type: 'manual' as const },
    ];
    await el.updateComplete;

    const backBtn = el.shadowRoot?.querySelector('.diff-header .btn') as HTMLElement;
    backBtn?.click();
    await el.updateComplete;

    expect((el as any)._view).toBe('list');
    expect(el.shadowRoot?.querySelector('.version-list')).not.toBeNull();
  });

  test('dispatches version-save event', async () => {
    const el = await createPanel();
    const handler = vi.fn();
    el.addEventListener('version-save', handler);

    const saveBtn = el.shadowRoot?.querySelector('.btn-primary') as HTMLElement;
    saveBtn?.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  test('version-diff event fires with correct fromId and toId', async () => {
    const el = await createPanel();
    el.versions = [
      { id: 'v1', created_at: '2026-01-01T00:00:00Z', type: 'manual' as const },
      { id: 'v2', created_at: '2026-01-02T00:00:00Z', type: 'manual' as const },
    ];
    await el.updateComplete;

    // Select two versions
    const items = el.shadowRoot?.querySelectorAll('.version-item') as NodeListOf<HTMLElement>;
    items[0]?.click();
    items[1]?.click();
    await el.updateComplete;

    const handler = vi.fn();
    el.addEventListener('version-diff', handler);

    // Click Compare
    const compareBtn = Array.from(el.shadowRoot?.querySelectorAll('.btn-primary') ?? [])
      .find(b => b.textContent?.includes('Compare')) as HTMLElement;
    compareBtn?.click();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail.fromId).toBe('v1');
    expect(handler.mock.calls[0][0].detail.toId).toBe('v2');
  });

  test('CSS uses --me-* custom properties for theming', async () => {
    const el = await createPanel();
    const styleSheets = el.shadowRoot?.adoptedStyleSheets ?? [];
    let cssText = '';
    for (const sheet of styleSheets) {
      for (const rule of sheet.cssRules) {
        cssText += rule.cssText + '\n';
      }
    }
    if (!cssText) {
      cssText = el.shadowRoot?.querySelector('style')?.textContent ?? '';
    }

    expect(cssText).toContain('--me-version-badge-manual-bg');
    expect(cssText).toContain('--me-version-btn-primary-bg');
    expect(cssText).toContain('--me-diff-added-bg');
    expect(cssText).toContain('--me-diff-removed-bg');
  });
});
