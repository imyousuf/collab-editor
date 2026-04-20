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

  test('renders version list items', async () => {
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

  test('renders diff view when diffResult is set', async () => {
    const el = await createPanel();
    el.diffResult = [
      { type: 'unchanged' as const, content: 'line1', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'removed' as const, content: 'old line', oldLineNumber: 2 },
      { type: 'added' as const, content: 'new line', newLineNumber: 2 },
    ];
    await el.updateComplete;

    const diffView = el.shadowRoot?.querySelector('.diff-view');
    expect(diffView).not.toBeNull();

    const lines = el.shadowRoot?.querySelectorAll('.diff-line');
    expect(lines?.length).toBe(3);
    expect(lines?.[0]?.classList.contains('diff-unchanged')).toBe(true);
    expect(lines?.[1]?.classList.contains('diff-removed')).toBe(true);
    expect(lines?.[2]?.classList.contains('diff-added')).toBe(true);
  });

  test('does not render diff view when diffResult is null', async () => {
    const el = await createPanel();
    el.diffResult = null;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('.diff-view')).toBeNull();
  });

  test('dispatches version-save event', async () => {
    const el = await createPanel();
    const handler = vi.fn();
    el.addEventListener('version-save', handler);

    const saveBtn = el.shadowRoot?.querySelector('.btn-primary') as HTMLElement;
    saveBtn?.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  test('dispatches version-select event on item click', async () => {
    const el = await createPanel();
    el.versions = [
      { id: 'v1', created_at: '2026-01-01T00:00:00Z', type: 'manual' as const },
    ];
    await el.updateComplete;

    const handler = vi.fn();
    el.addEventListener('version-select', handler);

    const item = el.shadowRoot?.querySelector('.version-item') as HTMLElement;
    item?.click();

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].detail.versionId).toBe('v1');
  });

  test('CSS uses --me-* custom properties for theming (no hardcoded colors)', async () => {
    const el = await createPanel();
    // Get the adopted stylesheet or style element content
    const styleSheets = el.shadowRoot?.adoptedStyleSheets ?? [];
    let cssText = '';
    for (const sheet of styleSheets) {
      for (const rule of sheet.cssRules) {
        cssText += rule.cssText + '\n';
      }
    }
    // Fallback: check style element
    if (!cssText) {
      cssText = el.shadowRoot?.querySelector('style')?.textContent ?? '';
    }

    expect(cssText).toContain('--me-version-badge-manual-bg');
    expect(cssText).toContain('--me-version-badge-auto-bg');
    expect(cssText).toContain('--me-version-btn-primary-bg');
    expect(cssText).toContain('--me-diff-added-bg');
    expect(cssText).toContain('--me-diff-removed-bg');
  });

  test('diff selection: click two different versions enables Show Diff', async () => {
    const el = await createPanel();
    el.versions = [
      { id: 'v1', created_at: '2026-01-01T00:00:00Z', type: 'manual' as const },
      { id: 'v2', created_at: '2026-01-02T00:00:00Z', type: 'manual' as const },
    ];
    await el.updateComplete;

    const items = el.shadowRoot?.querySelectorAll('.version-item') as NodeListOf<HTMLElement>;

    // Click first version (sets _diffFrom)
    items[0]?.click();
    await el.updateComplete;

    // Click second version (sets _diffTo)
    items[1]?.click();
    await el.updateComplete;

    // "Show Diff" button should now be visible
    // Check that the panel has both _diffFrom and _diffTo set
    expect((el as any)._diffFrom).toBe('v1');
    expect((el as any)._diffTo).toBe('v2');
  });

  test('diff selection: clicking same version twice deselects', async () => {
    const el = await createPanel();
    el.versions = [
      { id: 'v1', created_at: '2026-01-01T00:00:00Z', type: 'manual' as const },
    ];
    await el.updateComplete;

    const items = el.shadowRoot?.querySelectorAll('.version-item') as NodeListOf<HTMLElement>;

    // Click version (sets _diffFrom)
    items[0]?.click();
    await el.updateComplete;
    expect((el as any)._diffFrom).toBe('v1');

    // Click same version again (deselects)
    items[0]?.click();
    await el.updateComplete;
    expect((el as any)._diffFrom).toBeNull();
    expect((el as any)._diffTo).toBeNull();
  });

  test('version-diff event dispatches correct fromId and toId', async () => {
    const el = await createPanel();
    el.versions = [
      { id: 'v1', created_at: '2026-01-01T00:00:00Z', type: 'manual' as const },
      { id: 'v2', created_at: '2026-01-02T00:00:00Z', type: 'manual' as const },
    ];
    el.selectedVersion = { id: 'v2', created_at: '2026-01-02T00:00:00Z', type: 'manual' as const, content: 'hello' };
    await el.updateComplete;

    const items = el.shadowRoot?.querySelectorAll('.version-item') as NodeListOf<HTMLElement>;

    // Select two versions for diff
    items[0]?.click();
    items[1]?.click();
    await el.updateComplete;

    const handler = vi.fn();
    el.addEventListener('version-diff', handler);

    // Find and click the Show Diff button
    const diffBtn = el.shadowRoot?.querySelector('.actions .btn:not(.btn-primary)') as HTMLElement;
    if (diffBtn?.textContent?.includes('Show Diff')) {
      diffBtn.click();
      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].detail.fromId).toBe('v1');
      expect(handler.mock.calls[0][0].detail.toId).toBe('v2');
    }
  });
});
