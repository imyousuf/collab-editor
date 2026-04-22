/**
 * @vitest-environment jsdom
 *
 * Smoke tests confirming that every binding advertises ICommentCapability
 * and delegates enable/disable/update through its editor instance.
 */
import { describe, test, expect } from 'vitest';
import { DualModeBinding } from '../../bindings/dual-mode-binding.js';
import { SourceOnlyBinding } from '../../bindings/source-only-binding.js';
import { PreviewSourceBinding } from '../../bindings/preview-source-binding.js';
import { isCommentCapable } from '../../interfaces/comments.js';
import { MarkdownContentHandler } from '../../handlers/markdown-handler.js';

describe('Comment capability on all bindings', () => {
  test('DualModeBinding is comment-capable', () => {
    const b = new DualModeBinding(new MarkdownContentHandler(), 'markdown');
    expect(isCommentCapable(b)).toBe(true);
    // enable/disable with no editors attached must be a safe no-op.
    expect(() => b.enableComments()).not.toThrow();
    expect(() => b.updateComments([], [], null)).not.toThrow();
    expect(() => b.disableComments()).not.toThrow();
  });

  test('SourceOnlyBinding is comment-capable', () => {
    const b = new SourceOnlyBinding('javascript');
    expect(isCommentCapable(b)).toBe(true);
    expect(() => b.enableComments()).not.toThrow();
    expect(() => b.updateComments([], [], null)).not.toThrow();
    expect(() => b.disableComments()).not.toThrow();
  });

  test('PreviewSourceBinding is comment-capable', () => {
    const b = new PreviewSourceBinding('jsx');
    expect(isCommentCapable(b)).toBe(true);
    expect(() => b.enableComments()).not.toThrow();
    expect(() => b.updateComments([], [], null)).not.toThrow();
    expect(() => b.disableComments()).not.toThrow();
  });
});
