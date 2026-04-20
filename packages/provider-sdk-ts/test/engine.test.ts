import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as Y from 'yjs';
import {
  extractYjsUpdate,
  applyBase64Update,
  extractText,
  createDocWithContent,
  encodeDocState,
  DocCache,
} from '../src/engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../..', 'test/fixtures');

interface Fixture {
  name: string;
  description: string;
  initial_content: string;
  updates: { sequence: number; data: string; client_id: number }[];
  expected_text: string;
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf-8'));
}

describe('extractYjsUpdate', () => {
  test('extracts update from sync update message (0x00, 0x02)', () => {
    // Create a real Yjs update wrapped in y-websocket protocol
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    doc.getText('source').insert(0, 'test');

    // Manually wrap: [varuint(0), varuint(2), varuint8array(update)]
    const { createEncoder, writeVarUint, writeVarUint8Array, toUint8Array } = require('lib0/encoding');
    const encoder = createEncoder();
    writeVarUint(encoder, 0); // messageSync
    writeVarUint(encoder, 2); // syncUpdate
    writeVarUint8Array(encoder, updates[0]);
    const wrapped = toUint8Array(encoder);

    const extracted = extractYjsUpdate(wrapped);
    expect(extracted).not.toBeNull();
    expect(extracted!.length).toBeGreaterThan(0);

    // Apply to a new doc and verify
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, extracted!);
    expect(doc2.getText('source').toString()).toBe('test');
  });

  test('returns null for awareness message (0x01)', () => {
    const data = new Uint8Array([1, 0x01, 0x02]);
    expect(extractYjsUpdate(data)).toBeNull();
  });

  test('returns null for sync step1 (0x00, 0x00)', () => {
    const data = new Uint8Array([0, 0, 0x01]);
    expect(extractYjsUpdate(data)).toBeNull();
  });

  test('returns null for empty data', () => {
    expect(extractYjsUpdate(new Uint8Array([]))).toBeNull();
    expect(extractYjsUpdate(new Uint8Array([0]))).toBeNull();
  });
});

describe('applyBase64Update', () => {
  test('applies a valid base64 sync update', () => {
    const fixture = loadFixture('001-simple-insert');
    const doc = new Y.Doc();

    for (const update of fixture.updates) {
      applyBase64Update(doc, update.data);
    }

    expect(extractText(doc)).toBe(fixture.expected_text);
  });

  test('returns false for non-update messages', () => {
    const doc = new Y.Doc();
    // Awareness message base64
    const result = applyBase64Update(doc, Buffer.from([1, 0x01]).toString('base64'));
    expect(result).toBe(false);
  });
});

describe('createDocWithContent', () => {
  test('creates doc with text', () => {
    const doc = createDocWithContent('hello world');
    expect(doc.getText('source').toString()).toBe('hello world');
    doc.destroy();
  });

  test('creates empty doc for empty string', () => {
    const doc = createDocWithContent('');
    expect(doc.getText('source').toString()).toBe('');
    doc.destroy();
  });
});

describe('encodeDocState', () => {
  test('round-trips through encode/decode', () => {
    const doc1 = createDocWithContent('test content');
    const encoded = encodeDocState(doc1);

    const doc2 = new Y.Doc();
    const raw = Buffer.from(encoded, 'base64');
    Y.applyUpdate(doc2, new Uint8Array(raw));

    expect(doc2.getText('source').toString()).toBe('test content');
    doc1.destroy();
    doc2.destroy();
  });
});

describe('DocCache', () => {
  test('get/set/delete', () => {
    const cache = new DocCache(10);
    const doc = new Y.Doc();
    cache.set('doc1', doc);
    expect(cache.get('doc1')).toBe(doc);
    expect(cache.size).toBe(1);

    cache.delete('doc1');
    expect(cache.get('doc1')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test('LRU eviction', () => {
    const cache = new DocCache(2);
    cache.set('a', new Y.Doc());
    cache.set('b', new Y.Doc());
    cache.set('c', new Y.Doc()); // evicts 'a'

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).not.toBeUndefined();
    expect(cache.get('c')).not.toBeUndefined();
  });

  test('access refreshes LRU position', () => {
    const cache = new DocCache(2);
    cache.set('a', new Y.Doc());
    cache.set('b', new Y.Doc());
    cache.get('a'); // refresh 'a'
    cache.set('c', new Y.Doc()); // should evict 'b', not 'a'

    expect(cache.get('a')).not.toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).not.toBeUndefined();
  });

  test('clear destroys all docs', () => {
    const cache = new DocCache(10);
    cache.set('a', new Y.Doc());
    cache.set('b', new Y.Doc());
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('shared fixtures', () => {
  const fixtureNames = [
    '001-simple-insert',
    '002-multiple-inserts',
    '003-delete',
    '004-concurrent-edits',
    '005-large-document',
    '006-empty-document',
    '007-unicode',
    '008-rapid-edits',
    '009-replace-content',
    '010-with-initial-content',
  ];

  for (const name of fixtureNames) {
    test(`fixture: ${name}`, () => {
      const fixture = loadFixture(name);
      // All fixture updates include the full state (seed + edits).
      // Apply to an empty doc.
      const doc = new Y.Doc();

      for (const update of fixture.updates) {
        applyBase64Update(doc, update.data);
      }

      expect(extractText(doc)).toBe(fixture.expected_text);
      doc.destroy();
    });
  }
});
