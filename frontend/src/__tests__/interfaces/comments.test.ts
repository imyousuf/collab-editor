import { describe, test, expect } from 'vitest';
import { isCommentCapable } from '../../interfaces/comments.js';
import { isSuggestCapable } from '../../interfaces/suggest.js';

describe('isCommentCapable', () => {
  test('returns true when all three methods exist', () => {
    const candidate = {
      enableComments: () => {},
      disableComments: () => {},
      updateComments: () => {},
    };
    expect(isCommentCapable(candidate)).toBe(true);
  });

  test('returns false when any method is missing', () => {
    expect(isCommentCapable({ enableComments: () => {} })).toBe(false);
    expect(
      isCommentCapable({
        enableComments: () => {},
        disableComments: () => {},
      }),
    ).toBe(false);
  });

  test('returns false for nullish and primitives', () => {
    expect(isCommentCapable(null)).toBe(false);
    expect(isCommentCapable(undefined)).toBe(false);
    expect(isCommentCapable('binding')).toBe(false);
    expect(isCommentCapable(42)).toBe(false);
  });

  test('returns false when methods are not functions', () => {
    expect(
      isCommentCapable({
        enableComments: 'not-a-fn',
        disableComments: () => {},
        updateComments: () => {},
      }),
    ).toBe(false);
  });
});

describe('isSuggestCapable', () => {
  test('returns true when all four methods exist', () => {
    const candidate = {
      enableSuggest: () => {},
      disableSuggest: () => {},
      isSuggestActive: () => false,
      updatePendingOverlay: () => {},
    };
    expect(isSuggestCapable(candidate)).toBe(true);
  });

  test('returns false when isSuggestActive is missing', () => {
    expect(
      isSuggestCapable({
        enableSuggest: () => {},
        disableSuggest: () => {},
        updatePendingOverlay: () => {},
      }),
    ).toBe(false);
  });

  test('comment-capable bindings are not suggest-capable unless they opt in', () => {
    const commentOnly = {
      enableComments: () => {},
      disableComments: () => {},
      updateComments: () => {},
    };
    expect(isSuggestCapable(commentOnly)).toBe(false);
  });
});
