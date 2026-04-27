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
  // Default-on while we diagnose the "preview-then-wait corruption"
  // bug. Toggle off via window.__ME_DEBUG__ = false or ?debug=0.
  if (typeof window === 'undefined') return true;
  if (typeof window.__ME_DEBUG__ !== 'undefined') return window.__ME_DEBUG__;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('debug') === '0') return false;
  } catch {
    /* swallow */
  }
  return true;
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
  let line = `[ME ${ts()}] ${category} | ${message}`;
  if (data !== undefined) {
    // Inline-stringify the payload. ATR's console capture drops the
    // second argument to console.log, so passing data as a separate
    // arg loses every snapshot we care about. JSON.stringify keeps
    // the trace intact in the captured stream.
    let payload: string;
    try {
      payload = JSON.stringify(data, (_k, v) => {
        if (typeof v === 'symbol') return v.description ? `Symbol(${v.description})` : 'Symbol()';
        if (v instanceof Uint8Array) return `Uint8Array(${v.byteLength})`;
        return v;
      });
    } catch {
      payload = String(data);
    }
    if (payload && payload.length > 1500) {
      payload = payload.slice(0, 1500) + '…[truncated]';
    }
    line += ` ${payload}`;
  }
  // eslint-disable-next-line no-console
  console.log(line);
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
