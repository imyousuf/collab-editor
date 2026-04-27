/**
 * Structured debug logger for tracing content-mutation events across
 * the editorDoc / syncDoc split.
 *
 * Toggleable at runtime via:
 *   window.__ME_DEBUG__ = true   // enable
 *   window.__ME_DEBUG__ = false  // disable
 *
 * Or by URL param: open the page with `?debug=1`.
 *
 * All log lines share a `[ME]` prefix + a category tag so they're
 * easy to filter in DevTools console.
 */

type DebugFlag = boolean | ((category: string) => boolean);

declare global {
  interface Window {
    __ME_DEBUG__?: DebugFlag;
  }
}

let _enabled: DebugFlag = false;

function bootEnabled(): DebugFlag {
  if (typeof window === 'undefined') return false;
  if (typeof window.__ME_DEBUG__ !== 'undefined') return window.__ME_DEBUG__;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === '1') return true;
  } catch {
    /* swallow */
  }
  return false;
}

_enabled = bootEnabled();

function isEnabled(category: string): boolean {
  // Re-read the window flag every call — the user may toggle at runtime.
  const live: DebugFlag =
    typeof window !== 'undefined' && typeof window.__ME_DEBUG__ !== 'undefined'
      ? window.__ME_DEBUG__
      : _enabled;
  if (live === false) return false;
  if (live === true) return true;
  if (typeof live === 'function') {
    try { return !!live(category); } catch { return false; }
  }
  return !!live;
}

function ts(): string {
  // High-precision elapsed-since-page-load. Easier than wall clock when
  // you're inspecting interactions over short windows.
  if (typeof performance !== 'undefined' && performance.now) {
    return `+${performance.now().toFixed(1)}ms`;
  }
  return new Date().toISOString();
}

export function dlog(category: string, message: string, data?: unknown): void {
  if (!isEnabled(category)) return;
  // eslint-disable-next-line no-console
  if (data !== undefined) {
    console.log(`[ME ${ts()}] ${category} | ${message}`, data);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[ME ${ts()}] ${category} | ${message}`);
  }
}

/**
 * Snapshot a Y.Text content with length + first-N + last-N to keep
 * log lines short while still letting us see drift at the edges.
 */
export function snapText(text: string, head = 40, tail = 20): string {
  if (text.length <= head + tail + 5) {
    return JSON.stringify(text);
  }
  return `${JSON.stringify(text.slice(0, head))}…[${text.length - head - tail} chars]…${JSON.stringify(text.slice(text.length - tail))}`;
}
