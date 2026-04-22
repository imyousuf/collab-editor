/**
 * Blame capability interface for editor bindings.
 *
 * Optional interface — only bindings with editor instances implement it.
 * Checked via isBlameCapable() type guard.
 */

import type { BlameSegment } from '../collab/blame-engine.js';

export interface IBlameCapability {
  /** Enable blame view with the given segments. */
  enableBlame(segments: BlameSegment[]): void;

  /** Disable blame view and remove decorations. */
  disableBlame(): void;

  /** Update blame data (when segments change while blame is active). */
  updateBlame(segments: BlameSegment[]): void;
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
