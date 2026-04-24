import { describe, test, expect } from 'vitest';
import { quoteLabel } from '../../toolbar/comment-panel.js';
import type { CommentThread } from '../../interfaces/comments.js';

function mkThread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't1',
    document_id: 'doc.md',
    anchor: { start: 0, end: 0, quoted_text: '' },
    status: 'open',
    created_at: '2026-01-01T00:00:00Z',
    comments: [],
    ...overrides,
  } as CommentThread;
}

describe('quoteLabel', () => {
  test('uses quoted_text for a range anchor', () => {
    const t = mkThread({ anchor: { start: 0, end: 5, quoted_text: 'hello' } });
    expect(quoteLabel(t)).toBe('"hello"');
  });

  test('falls back to suggestion after_text when quoted_text is empty', () => {
    const t = mkThread({
      anchor: { start: 5, end: 5, quoted_text: '' },
      suggestion: {
        human_readable: { summary: 's', before_text: '', after_text: ' - 123', operations: [] },
        author_id: 'u1',
        author_name: 'Alice',
        status: 'pending',
      },
    });
    expect(quoteLabel(t)).toBe('+ "- 123"');
  });

  test('truncates long suggestion after_text', () => {
    const long = 'x'.repeat(100);
    const t = mkThread({
      anchor: { start: 0, end: 0, quoted_text: '' },
      suggestion: {
        human_readable: { summary: 's', before_text: '', after_text: long, operations: [] },
        author_id: 'u1',
        author_name: 'Alice',
        status: 'pending',
      },
    });
    const label = quoteLabel(t);
    expect(label.startsWith('+ "')).toBe(true);
    expect(label.endsWith('…"')).toBe(true);
    // 48 char cap (47 content + ellipsis).
    expect(label.length).toBeLessThanOrEqual(52);
  });

  test('returns (orphaned) when nothing usable is present', () => {
    const t = mkThread({ anchor: { start: 0, end: 0, quoted_text: '' } });
    expect(quoteLabel(t)).toBe('(orphaned)');
  });

  test('returns (orphaned) when suggestion has empty after_text', () => {
    const t = mkThread({
      anchor: { start: 0, end: 5, quoted_text: '' },
      suggestion: {
        human_readable: { summary: 's', before_text: 'hello', after_text: '', operations: [] },
        author_id: 'u1',
        author_name: 'Alice',
        status: 'pending',
      },
    });
    // Delete-only suggestion with no anchored source text — fall through.
    expect(quoteLabel(t)).toBe('(orphaned)');
  });
});
