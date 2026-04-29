/**
 * Lazy loader + render helper for Mermaid diagrams.
 *
 * The mermaid runtime is ~600 KB gzipped, so we defer it via dynamic
 * import. The first call to loadMermaid() kicks off the import; the
 * resolved module is cached on a module-level promise so every Mermaid
 * code block in the document shares one runtime.
 *
 * Theming is global to the runtime (mermaid.initialize is process-wide),
 * so setMermaidTheme re-initializes and bumps a generation counter that
 * node views can use to detect "I need to re-render under the new theme".
 */

export type MermaidTheme = 'default' | 'dark';

type MermaidApi = {
  initialize(config: Record<string, unknown>): void;
  render(id: string, code: string): Promise<{ svg: string; bindFunctions?: (el: Element) => void }>;
};

let _modulePromise: Promise<MermaidApi> | null = null;
let _currentTheme: MermaidTheme = 'default';
let _themeGeneration = 0;
let _idSeq = 0;

/**
 * Resolve (and cache) the mermaid runtime. Calls after the first share
 * the same promise — even if the first call hasn't resolved yet.
 */
export function loadMermaid(): Promise<MermaidApi> {
  if (!_modulePromise) {
    _modulePromise = import('mermaid').then((mod) => {
      const api = (mod.default ?? mod) as MermaidApi;
      api.initialize({
        startOnLoad: false,
        theme: _currentTheme,
        securityLevel: 'strict',
        fontFamily: 'inherit',
      });
      return api;
    });
  }
  return _modulePromise;
}

/**
 * Apply a new theme. Re-initializes the runtime if it's already loaded;
 * otherwise just stashes the theme so loadMermaid picks it up. Returns
 * the new generation counter — node views can compare against the value
 * they last rendered under to decide whether to re-run render().
 */
export function setMermaidTheme(theme: MermaidTheme): number {
  if (theme === _currentTheme) return _themeGeneration;
  _currentTheme = theme;
  _themeGeneration += 1;
  if (_modulePromise) {
    _modulePromise.then((api) => {
      api.initialize({
        startOnLoad: false,
        theme,
        securityLevel: 'strict',
        fontFamily: 'inherit',
      });
    });
  }
  return _themeGeneration;
}

export function getMermaidTheme(): MermaidTheme {
  return _currentTheme;
}

export function getThemeGeneration(): number {
  return _themeGeneration;
}

export interface RenderResult {
  ok: true;
  svg: SVGElement;
}
export interface RenderError {
  ok: false;
  message: string;
}
export type RenderOutcome = RenderResult | RenderError;

/**
 * Render a mermaid code string to an SVG element. Returns either the
 * SVG (success) or a structured error (so callers can show the message
 * inline rather than throwing).
 *
 * Uses a fresh, off-DOM container per call — mermaid.render mutates the
 * document with a temp node, which we don't want bleeding into the page.
 */
export async function renderMermaid(code: string): Promise<RenderOutcome> {
  const trimmed = code.trim();
  if (!trimmed) {
    return { ok: false, message: 'Empty diagram source' };
  }
  let api: MermaidApi;
  try {
    api = await loadMermaid();
  } catch (err) {
    return { ok: false, message: `Failed to load mermaid: ${stringifyError(err)}` };
  }
  _idSeq += 1;
  const id = `me-mermaid-${_idSeq}`;
  try {
    const { svg } = await api.render(id, trimmed);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = svg;
    const svgEl = wrapper.querySelector('svg');
    if (!svgEl) {
      return { ok: false, message: 'Mermaid produced no SVG output' };
    }
    return { ok: true, svg: svgEl as SVGElement };
  } catch (err) {
    // mermaid.render appends a stray temp node on parse error; clean it up.
    const stray = document.getElementById(id);
    if (stray) stray.remove();
    return { ok: false, message: stringifyError(err) };
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Test-only helper to reset module state between cases. */
export function __resetMermaidLoaderForTests(): void {
  _modulePromise = null;
  _currentTheme = 'default';
  _themeGeneration = 0;
  _idSeq = 0;
}
