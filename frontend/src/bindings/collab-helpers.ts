/**
 * Shared helpers for collaborative content operations.
 */
import type { CollaborationContext } from '../interfaces/editor-binding.js';
import type { RemoteChangeCallback } from '../interfaces/editor-binding.js';

/**
 * Set content via Y.Text. Replaces existing content (idempotent).
 * Returns true if content was written, false if Y.Text already had content.
 */
export function setCollabContent(collab: CollaborationContext, text: string): boolean {
  console.log('setCollabContent: Y.Text length =', collab.sharedText.length, 'text length =', text.length);
  if (collab.sharedText.length > 0) {
    console.log('setCollabContent: SKIPPED (Y.Text not empty)');
    return false;
  }
  collab.ydoc.transact(() => {
    if (collab.sharedText.length > 0) {
      collab.sharedText.delete(0, collab.sharedText.length);
    }
    collab.sharedText.insert(0, text);
  });
  return true;
}

/**
 * Observe Y.Text for remote changes and notify callbacks.
 */
export function observeRemoteChanges(
  collab: CollaborationContext,
  callbacks: Set<RemoteChangeCallback>,
): void {
  collab.sharedText.observe((event) => {
    if (!event.transaction.local) {
      callbacks.forEach(cb => cb({ origin: event.transaction.origin, isRemote: true }));
    }
  });
}
