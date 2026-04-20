import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { BlameEngine } from '../../collab/blame-engine.js';
import type { BlameSegment } from '../../collab/blame-engine.js';

// Mock localStorage for tests
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

describe('BlameEngine', () => {
  let doc: Y.Doc;
  let engine: BlameEngine;

  beforeEach(() => {
    localStorageMock.clear();
    doc = new Y.Doc();
    engine = new BlameEngine(doc, 'test-doc');
  });

  afterEach(() => {
    doc.destroy();
  });

  describe('color assignment', () => {
    test('same user always gets same color', () => {
      const color1 = BlameEngine.assignColor('alice');
      const color2 = BlameEngine.assignColor('alice');
      expect(color1).toBe(color2);
    });

    test('different users get (usually) different colors', () => {
      const color1 = BlameEngine.assignColor('alice');
      const color2 = BlameEngine.assignColor('bob');
      // Not guaranteed different due to hash collisions, but very likely
      expect(typeof color1).toBe('string');
      expect(typeof color2).toBe('string');
      expect(color1.startsWith('#')).toBe(true);
    });

    test('returns valid hex color', () => {
      const color = BlameEngine.assignColor('test');
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });

  describe('version blame passthrough', () => {
    test('returns same segments', () => {
      const segments: BlameSegment[] = [
        { start: 0, end: 5, userName: 'alice' },
        { start: 5, end: 10, userName: 'bob' },
      ];
      const result = BlameEngine.fromVersionBlame(segments);
      expect(result).toEqual(segments);
    });

    test('handles empty array', () => {
      expect(BlameEngine.fromVersionBlame([])).toEqual([]);
    });
  });

  describe('live blame', () => {
    test('startLiveBlame captures updates', () => {
      engine.startLiveBlame();

      // Make an edit
      doc.getText('source').insert(0, 'hello');

      // Should have stored an entry
      const stored = localStorageMock.getItem('collab-blame:test-doc');
      expect(stored).not.toBeNull();
      const entries = JSON.parse(stored!);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].userName).toBeDefined();
      expect(entries[0].clientId).toBeDefined();
    });

    test('stored entries do not contain Yjs update binary (no dead data)', () => {
      engine.startLiveBlame();
      doc.getText('source').insert(0, 'hello');

      const stored = localStorageMock.getItem('collab-blame:test-doc');
      const entries = JSON.parse(stored!);
      // LiveBlameEntry should NOT have an 'update' field (dead code removed)
      expect(entries[0]).not.toHaveProperty('update');
      // Should only have userName, clientId, timestamp
      expect(Object.keys(entries[0]).sort()).toEqual(['clientId', 'timestamp', 'userName']);
    });

    test('stopLiveBlame clears storage', () => {
      engine.startLiveBlame();
      doc.getText('source').insert(0, 'hello');
      engine.stopLiveBlame();

      expect(localStorageMock.getItem('collab-blame:test-doc')).toBeNull();
    });

    test('stopLiveBlame stops capturing', () => {
      engine.startLiveBlame();
      engine.stopLiveBlame();

      doc.getText('source').insert(0, 'hello');
      expect(localStorageMock.getItem('collab-blame:test-doc')).toBeNull();
    });

    test('getLiveBlame returns segments', () => {
      engine.startLiveBlame();
      doc.getText('source').insert(0, 'hello');

      const blame = engine.getLiveBlame();
      expect(blame.length).toBeGreaterThan(0);
      expect(blame[0].start).toBe(0);
      expect(blame[0].end).toBe(5);
    });

    test('getLiveBlame returns empty when no captures', () => {
      expect(engine.getLiveBlame()).toEqual([]);
    });

    test('setAwareness uses user name from awareness', () => {
      const awareness = {
        getLocalState: () => ({ user: { name: 'alice' } }),
      };
      engine.setAwareness(awareness);
      engine.startLiveBlame();

      doc.getText('source').insert(0, 'hello');

      const stored = localStorageMock.getItem('collab-blame:test-doc');
      const entries = JSON.parse(stored!);
      expect(entries[0].userName).toBe('alice');
    });

    test('startLiveBlame is idempotent', () => {
      engine.startLiveBlame();
      engine.startLiveBlame(); // should not add duplicate observer

      doc.getText('source').insert(0, 'hi');

      const stored = localStorageMock.getItem('collab-blame:test-doc');
      const entries = JSON.parse(stored!);
      // Should have exactly 1 entry, not 2
      expect(entries.length).toBe(1);
    });

    test('getLiveBlame reads from live doc items, not replay', () => {
      // Pre-populate the doc with some content BEFORE starting blame
      doc.getText('source').insert(0, 'existing content');

      engine.startLiveBlame();

      // getLiveBlame should return segments for existing content
      // even though blame was started after the content was inserted
      const blame = engine.getLiveBlame();
      expect(blame.length).toBeGreaterThan(0);
      expect(blame[0].start).toBe(0);
      expect(blame[0].end).toBe(16); // "existing content"
    });

    test('getLiveBlame uses awareness for user names', () => {
      const awareness = {
        getStates: () => {
          const map = new Map();
          map.set(doc.clientID, { user: { name: 'alice' } });
          return map;
        },
      };
      engine.setAwareness(awareness);

      doc.getText('source').insert(0, 'hello');
      engine.startLiveBlame();

      const blame = engine.getLiveBlame();
      expect(blame.length).toBeGreaterThan(0);
      expect(blame[0].userName).toBe('alice');
    });

    test('getLiveBlame shows different users for multi-client content', () => {
      // Simulate two clients editing the same doc
      const doc2 = new Y.Doc();
      const text2 = doc2.getText('source');

      // Client 1 types "hello"
      doc.getText('source').insert(0, 'hello');

      // Sync doc1 -> doc2
      const update1 = Y.encodeStateAsUpdate(doc);
      Y.applyUpdate(doc2, update1);

      // Client 2 types " world"
      text2.insert(5, ' world');

      // Sync doc2 -> doc1
      const update2 = Y.encodeStateAsUpdate(doc2);
      Y.applyUpdate(doc, update2);

      engine.startLiveBlame();
      const blame = engine.getLiveBlame();

      // Should have 2 segments (different client IDs)
      expect(blame.length).toBe(2);
      // The user names will be user-{clientId} since no awareness mapping
      expect(blame[0].userName).not.toBe(blame[1].userName);

      doc2.destroy();
    });
  });
});
