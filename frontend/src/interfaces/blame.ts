/**
 * Blame capability interface for editor bindings.
 *
 * Optional interface — only bindings with editor instances implement it.
 * Checked via isBlameCapable() type guard.
 */

import type { BlameSegment } from '../collab/blame-engine.js';
import type * as Y from 'yjs';

/**
 * Extra context the WYSIWYG binding needs so the blame plugin can do
 * two things the source binding doesn't need:
 *
 * 1. Build a correct Y.Text-offset ↔ PM-position map by walking PM
 *    text nodes against the true Y.Text source (Markdown / HTML).
 * 2. Compute "formatting authorship" overrides — when one user wrapped
 *    another user's text in a mark, credit the formatter for the
 *    visible text with a tooltip that preserves the original author.
 *
 * The source (CodeMirror) binding ignores this; Y.Text offsets map 1:1
 * to source positions there.
 */
export interface BlameContext {
  ytext?: Y.Text;
  clientToUser?: Map<number, string>;
}

export interface IBlameCapability {
  /** Enable blame view with the given segments. */
  enableBlame(segments: BlameSegment[], ctx?: BlameContext): void;

  /** Disable blame view and remove decorations. */
  disableBlame(): void;

  /** Update blame data (when segments change while blame is active). */
  updateBlame(segments: BlameSegment[], ctx?: BlameContext): void;
}

/** Type guard for checking if a binding supports blame. */
export function isBlameCapable(binding: any): binding is IBlameCapability {
  return (
    binding !== null &&
    typeof binding === 'object' &&
    typeof binding.enableBlame === 'function' &&
    typeof binding.disableBlame === 'function' &&
    typeof binding.updateBlame === 'function'
  );
}
