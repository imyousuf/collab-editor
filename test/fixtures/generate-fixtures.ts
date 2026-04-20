/**
 * Generates shared test fixtures for provider SDK cross-language testing.
 *
 * Uses the canonical JavaScript `yjs` library to create Y.Doc instances,
 * perform operations, capture binary updates, and record expected text.
 *
 * Run: npx tsx test/fixtures/generate-fixtures.ts
 * Requires: yjs, lib0 (available from frontend/node_modules)
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface UpdateEntry {
  sequence: number;
  data: string; // base64
  client_id: number;
}

interface Fixture {
  name: string;
  description: string;
  initial_content: string;
  updates: UpdateEntry[];
  expected_text: string;
}

/** Wrap a raw Yjs update in the y-websocket protocol envelope (sync update message) */
function wrapAsYWebSocketUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0); // messageSync
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

/** Capture updates from a Y.Doc as y-websocket protocol messages */
function captureUpdates(doc: Y.Doc, operations: (text: Y.Text) => void): UpdateEntry[] {
  const updates: UpdateEntry[] = [];
  let seq = 1;

  doc.on('update', (update: Uint8Array) => {
    const wrapped = wrapAsYWebSocketUpdate(update);
    updates.push({
      sequence: seq++,
      data: toBase64(wrapped),
      client_id: doc.clientID,
    });
  });

  operations(doc.getText('source'));

  doc.off('update', () => {});
  return updates;
}

// --- Fixture definitions ---

function fixture001_simpleInsert(): Fixture {
  const doc = new Y.Doc();
  const updates = captureUpdates(doc, (text) => {
    text.insert(0, 'hello');
  });
  return {
    name: '001-simple-insert',
    description: 'Insert "hello" into an empty document',
    initial_content: '',
    updates,
    expected_text: doc.getText('source').toString(),
  };
}

function fixture002_multipleInserts(): Fixture {
  const doc = new Y.Doc();
  const updates = captureUpdates(doc, (text) => {
    text.insert(0, 'hello');
    text.insert(5, ' world');
  });
  return {
    name: '002-multiple-inserts',
    description: 'Multiple sequential inserts: "hello" then " world"',
    initial_content: '',
    updates,
    expected_text: doc.getText('source').toString(),
  };
}

function fixture003_delete(): Fixture {
  const doc = new Y.Doc();
  const updates = captureUpdates(doc, (text) => {
    text.insert(0, 'hello world');
    text.delete(5, 6); // delete " world"
  });
  return {
    name: '003-delete',
    description: 'Insert "hello world" then delete " world"',
    initial_content: '',
    updates,
    expected_text: doc.getText('source').toString(),
  };
}

function fixture004_concurrentEdits(): Fixture {
  const doc1 = new Y.Doc();
  const doc2 = new Y.Doc();
  const allUpdates: UpdateEntry[] = [];
  let seq = 1;

  // doc1 inserts "AA"
  doc1.on('update', (update: Uint8Array) => {
    allUpdates.push({
      sequence: seq++,
      data: toBase64(wrapAsYWebSocketUpdate(update)),
      client_id: doc1.clientID,
    });
  });
  doc1.getText('source').insert(0, 'AA');
  doc1.off('update', () => {});

  // doc2 inserts "BB" concurrently (before syncing with doc1)
  doc2.on('update', (update: Uint8Array) => {
    allUpdates.push({
      sequence: seq++,
      data: toBase64(wrapAsYWebSocketUpdate(update)),
      client_id: doc2.clientID,
    });
  });
  doc2.getText('source').insert(0, 'BB');
  doc2.off('update', () => {});

  // Merge: apply all updates to a fresh doc to get the resolved text
  const merged = new Y.Doc();
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(doc1));
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(doc2));

  return {
    name: '004-concurrent-edits',
    description: 'Two clients insert concurrently without syncing first',
    initial_content: '',
    updates: allUpdates,
    expected_text: merged.getText('source').toString(),
  };
}

function fixture005_largeDocument(): Fixture {
  const doc = new Y.Doc();
  const lines: string[] = [];
  for (let i = 0; i < 100; i++) {
    lines.push(`Line ${i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.`);
  }
  const content = lines.join('\n');

  const updates = captureUpdates(doc, (text) => {
    text.insert(0, content);
  });
  return {
    name: '005-large-document',
    description: '100-line document inserted at once',
    initial_content: '',
    updates,
    expected_text: doc.getText('source').toString(),
  };
}

function fixture006_emptyDocument(): Fixture {
  return {
    name: '006-empty-document',
    description: 'No updates applied — document stays empty',
    initial_content: '',
    updates: [],
    expected_text: '',
  };
}

function fixture007_unicode(): Fixture {
  const doc = new Y.Doc();
  const updates = captureUpdates(doc, (text) => {
    text.insert(0, 'Hello, World!');
    text.insert(6, ' \u{1F30D}'); // globe emoji
  });
  return {
    name: '007-unicode',
    description: 'Text with emoji and unicode characters',
    initial_content: '',
    updates,
    expected_text: doc.getText('source').toString(),
  };
}

function fixture008_rapidEdits(): Fixture {
  const doc = new Y.Doc();
  const updates = captureUpdates(doc, (text) => {
    // Simulate character-by-character typing
    const phrase = 'The quick brown fox jumps over the lazy dog.';
    for (let i = 0; i < phrase.length; i++) {
      text.insert(i, phrase[i]);
    }
  });
  return {
    name: '008-rapid-edits',
    description: 'Character-by-character typing (44 individual inserts)',
    initial_content: '',
    updates,
    expected_text: doc.getText('source').toString(),
  };
}

function fixture009_replaceContent(): Fixture {
  const doc = new Y.Doc();
  const updates = captureUpdates(doc, (text) => {
    text.insert(0, 'original content');
    text.delete(0, text.length);
    text.insert(0, 'replaced content');
  });
  return {
    name: '009-replace-content',
    description: 'Insert text, delete all, insert new text',
    initial_content: '',
    updates,
    expected_text: doc.getText('source').toString(),
  };
}

function fixture010_withInitialContent(): Fixture {
  // Simulate: provider has initial content, then new edits arrive.
  // The seed state is included as the first update so tests can apply
  // all updates to an empty doc and get the expected result.
  const doc = new Y.Doc();
  const allUpdates: { sequence: number; data: string; client_id: number }[] = [];
  let seq = 1;

  doc.on('update', (update: Uint8Array) => {
    allUpdates.push({
      sequence: seq++,
      data: toBase64(wrapAsYWebSocketUpdate(update)),
      client_id: doc.clientID,
    });
  });

  // Seed content (captured as first update)
  doc.getText('source').insert(0, '# Hello\n\nInitial content.');

  // Additional edit on top
  doc.getText('source').insert(doc.getText('source').length, '\n\nAppended paragraph.');

  doc.off('update', () => {});

  return {
    name: '010-with-initial-content',
    description: 'Edits applied on top of pre-existing content (seed included in updates)',
    initial_content: '# Hello\n\nInitial content.',
    updates: allUpdates,
    expected_text: doc.getText('source').toString(),
  };
}

// --- Generate all fixtures ---

const fixtures = [
  fixture001_simpleInsert(),
  fixture002_multipleInserts(),
  fixture003_delete(),
  fixture004_concurrentEdits(),
  fixture005_largeDocument(),
  fixture006_emptyDocument(),
  fixture007_unicode(),
  fixture008_rapidEdits(),
  fixture009_replaceContent(),
  fixture010_withInitialContent(),
];

for (const fixture of fixtures) {
  const path = join(__dirname, `${fixture.name}.json`);
  writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`Generated: ${fixture.name}.json (${fixture.updates.length} updates, expected: ${JSON.stringify(fixture.expected_text.substring(0, 50))}${fixture.expected_text.length > 50 ? '...' : ''})`);
}

console.log(`\nGenerated ${fixtures.length} fixture files.`);
