import { describe, test, expect } from 'vitest';
import { computeBlameFromVersions } from '../src/blame.js';
import type { VersionEntry } from '../src/types.js';

function makeVersion(id: string, content: string, creator: string, createdAt?: string): VersionEntry {
  return {
    id,
    content,
    creator,
    created_at: createdAt ?? new Date().toISOString(),
    type: 'manual',
  };
}

describe('computeBlameFromVersions', () => {
  test('returns empty for no versions', () => {
    expect(computeBlameFromVersions([])).toEqual([]);
  });

  test('single version — all attributed to creator', () => {
    const versions = [makeVersion('v1', 'hello\nworld', 'alice')];
    const blame = computeBlameFromVersions(versions);

    expect(blame.length).toBe(1);
    expect(blame[0].user_name).toBe('alice');
    expect(blame[0].start).toBe(0);
    expect(blame[0].end).toBe(11); // "hello\nworld" = 11 chars
  });

  test('two versions — new lines attributed to second creator', () => {
    const versions = [
      makeVersion('v1', 'line1\nline2', 'alice', '2026-01-01'),
      makeVersion('v2', 'line1\nline2\nline3', 'bob', '2026-01-02'),
    ];
    const blame = computeBlameFromVersions(versions);

    // line1 and line2 from alice, line3 from bob
    expect(blame.length).toBe(2);
    expect(blame[0].user_name).toBe('alice');
    expect(blame[1].user_name).toBe('bob');
  });

  test('modified line attributed to new creator', () => {
    const versions = [
      makeVersion('v1', 'hello world', 'alice', '2026-01-01'),
      makeVersion('v2', 'hello universe', 'bob', '2026-01-02'),
    ];
    const blame = computeBlameFromVersions(versions);

    // Content changed, so bob owns it
    expect(blame.length).toBe(1);
    expect(blame[0].user_name).toBe('bob');
  });

  test('unchanged lines retain attribution', () => {
    const versions = [
      makeVersion('v1', 'line1\nline2\nline3', 'alice', '2026-01-01'),
      makeVersion('v2', 'line1\nchanged\nline3', 'bob', '2026-01-02'),
    ];
    const blame = computeBlameFromVersions(versions);

    // line1 = alice, changed = bob, line3 = alice
    expect(blame.length).toBe(3);
    expect(blame[0].user_name).toBe('alice'); // line1
    expect(blame[1].user_name).toBe('bob');   // changed
    expect(blame[2].user_name).toBe('alice'); // line3
  });

  test('three versions — blame accumulates', () => {
    const versions = [
      makeVersion('v1', 'a\nb\nc', 'alice', '2026-01-01'),
      makeVersion('v2', 'a\nB\nc', 'bob', '2026-01-02'),
      makeVersion('v3', 'a\nB\nC', 'charlie', '2026-01-03'),
    ];
    const blame = computeBlameFromVersions(versions);

    expect(blame.length).toBe(3);
    expect(blame[0].user_name).toBe('alice');   // a
    expect(blame[1].user_name).toBe('bob');     // B
    expect(blame[2].user_name).toBe('charlie'); // C
  });

  test('empty content versions', () => {
    const versions = [
      makeVersion('v1', '', 'alice', '2026-01-01'),
      makeVersion('v2', 'hello', 'bob', '2026-01-02'),
    ];
    const blame = computeBlameFromVersions(versions);

    expect(blame.length).toBe(1);
    expect(blame[0].user_name).toBe('bob');
  });

  test('deletion — all content removed', () => {
    const versions = [
      makeVersion('v1', 'hello\nworld', 'alice', '2026-01-01'),
      makeVersion('v2', '', 'bob', '2026-01-02'),
    ];
    const blame = computeBlameFromVersions(versions);

    // Empty content has no characters to attribute
    expect(blame.length).toBe(0);
  });

  test('segment merging — adjacent lines by same author merge', () => {
    const versions = [
      makeVersion('v1', 'a\nb\nc', 'alice', '2026-01-01'),
    ];
    const blame = computeBlameFromVersions(versions);

    // All three lines by alice should merge into one segment
    expect(blame.length).toBe(1);
    expect(blame[0].user_name).toBe('alice');
    expect(blame[0].start).toBe(0);
    expect(blame[0].end).toBe(5); // "a\nb\nc" = 5 chars
  });

  test('defaults to "unknown" when creator is missing', () => {
    const versions = [makeVersion('v1', 'hello', '')];
    // Creator is empty string, should default to 'unknown'
    versions[0].creator = undefined;
    const blame = computeBlameFromVersions(versions);
    expect(blame[0].user_name).toBe('unknown');
  });
});
