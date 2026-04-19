import { describe, test, expect } from 'vitest';
import type { IContentHandler } from '../../interfaces/content-handler.js';

/**
 * Contract tests for IContentHandler implementations.
 * Call this function once per handler class to verify it meets the interface contract.
 */
export function contentHandlerContractTests(
  name: string,
  createHandler: () => IContentHandler,
  testCases: Array<{ input: string; expectedType: 'markdown' | 'html' | 'text' }>,
) {
  describe(`IContentHandler contract: ${name}`, () => {
    test('supportedMimeTypes is non-empty', () => {
      const handler = createHandler();
      expect(handler.supportedMimeTypes.length).toBeGreaterThan(0);
    });

    test('supportedMimeTypes entries are non-empty strings', () => {
      const handler = createHandler();
      for (const mime of handler.supportedMimeTypes) {
        expect(typeof mime).toBe('string');
        expect(mime.length).toBeGreaterThan(0);
        expect(mime).toContain('/');
      }
    });

    for (const tc of testCases) {
      test(`parse("${tc.input.substring(0, 30)}...") returns type "${tc.expectedType}"`, () => {
        const handler = createHandler();
        const result = handler.parse(tc.input);
        expect(result.type).toBe(tc.expectedType);
        expect(typeof result.content).toBe('string');
      });
    }

    test('parse empty string does not throw', () => {
      const handler = createHandler();
      expect(() => handler.parse('')).not.toThrow();
    });

    test('serialize empty string does not throw', () => {
      const handler = createHandler();
      expect(() => handler.serialize('')).not.toThrow();
    });

    test('serialize returns a string', () => {
      const handler = createHandler();
      const result = handler.serialize('hello world');
      expect(typeof result).toBe('string');
    });

    for (const tc of testCases) {
      test(`round-trip: serialize(parse("${tc.input.substring(0, 30)}...").content) returns original`, () => {
        const handler = createHandler();
        const parsed = handler.parse(tc.input);
        const serialized = handler.serialize(parsed.content);
        expect(serialized).toBe(tc.input);
      });
    }
  });
}
