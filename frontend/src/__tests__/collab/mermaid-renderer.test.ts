import { describe, test, expect, beforeEach, vi } from 'vitest';

const initializeMock = vi.fn();
const renderMock = vi.fn(async (_id: string, code: string) => {
  if (!code || code.includes('BOOM')) throw new Error('parse error');
  return { svg: '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>' };
});

vi.mock('mermaid', () => ({
  default: { initialize: initializeMock, render: renderMock },
}));

import {
  loadMermaid,
  renderMermaid,
  setMermaidTheme,
  getMermaidTheme,
  getThemeGeneration,
  __resetMermaidLoaderForTests,
} from '../../collab/mermaid-renderer.js';

describe('mermaid-renderer', () => {
  beforeEach(() => {
    initializeMock.mockClear();
    renderMock.mockClear();
    __resetMermaidLoaderForTests();
  });

  test('loadMermaid caches the import promise across calls', async () => {
    const a = loadMermaid();
    const b = loadMermaid();
    expect(a).toBe(b);
    await a;
    // initialize should run once even when many node views call loadMermaid
    await loadMermaid();
    await loadMermaid();
    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  test('renderMermaid returns the parsed SVG element on success', async () => {
    const out = await renderMermaid('graph TD\nA-->B');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.svg.tagName.toLowerCase()).toBe('svg');
    }
  });

  test('renderMermaid returns a structured error on parse failure', async () => {
    const out = await renderMermaid('BOOM');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toContain('parse error');
    }
  });

  test('renderMermaid rejects empty input without calling mermaid.render', async () => {
    const out = await renderMermaid('   \n  ');
    expect(out.ok).toBe(false);
    expect(renderMock).not.toHaveBeenCalled();
  });

  test('setMermaidTheme bumps generation and re-initializes when changed', async () => {
    await loadMermaid();
    expect(initializeMock).toHaveBeenCalledTimes(1);
    expect(getMermaidTheme()).toBe('default');

    const gen1 = setMermaidTheme('dark');
    expect(gen1).toBe(1);
    expect(getMermaidTheme()).toBe('dark');
    // Re-init is async-chained off the cached promise — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(initializeMock).toHaveBeenCalledTimes(2);

    // Setting to the same theme is a no-op.
    const gen2 = setMermaidTheme('dark');
    expect(gen2).toBe(1);
    expect(getThemeGeneration()).toBe(1);
  });

  test('setMermaidTheme called before load only stashes; load picks it up', async () => {
    setMermaidTheme('dark');
    expect(initializeMock).not.toHaveBeenCalled();
    await loadMermaid();
    expect(initializeMock).toHaveBeenCalledTimes(1);
    const call = initializeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.theme).toBe('dark');
  });
});
