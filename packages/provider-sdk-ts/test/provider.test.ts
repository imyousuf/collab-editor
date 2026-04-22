import { describe, test, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Provider } from '../src/provider.js';
import { ProviderProcessor } from '../src/provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../../..', 'test/fixtures');

function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf-8'));
}

function createMockProvider(): Provider & {
  _store: Map<string, { content: string; mimeType: string }>;
} {
  const store = new Map<string, { content: string; mimeType: string }>();
  return {
    _store: store,
    async readContent(documentId: string) {
      const entry = store.get(documentId);
      return {
        content: entry?.content ?? '',
        mimeType: entry?.mimeType ?? 'text/plain',
      };
    },
    async writeContent(documentId: string, content: string, mimeType: string) {
      store.set(documentId, { content, mimeType });
    },
    async listDocuments() {
      return Array.from(store.entries()).map(([name, { mimeType }]) => ({
        name,
        mime_type: mimeType,
        size: 0,
      }));
    },
  };
}

describe('ProviderProcessor', () => {
  let mockProvider: ReturnType<typeof createMockProvider>;
  let processor: ProviderProcessor;

  beforeEach(() => {
    mockProvider = createMockProvider();
    processor = new ProviderProcessor(mockProvider);
  });

  test('processLoad returns content from provider', async () => {
    mockProvider._store.set('doc1', { content: '# Hello', mimeType: 'text/markdown' });

    const resp = await processor.processLoad('doc1');
    expect(resp.content).toBe('# Hello');
    expect(resp.mime_type).toBe('text/markdown');
    expect((resp as any).updates).toBeUndefined();
  });

  test('processLoad returns empty for nonexistent doc', async () => {
    const resp = await processor.processLoad('nonexistent');
    expect(resp.content).toBe('');
  });

  test('processStore applies diffs and writes resolved text', async () => {
    const fixture = loadFixture('001-simple-insert');
    mockProvider._store.set('doc1', { content: '', mimeType: 'text/plain' });

    const resp = await processor.processStore('doc1', fixture.updates);
    expect(resp.stored).toBeGreaterThan(0);

    // Provider should have received the resolved text
    const stored = mockProvider._store.get('doc1');
    expect(stored?.content).toBe(fixture.expected_text);
  });

  test('processStore with multiple updates merges correctly', async () => {
    const fixture = loadFixture('002-multiple-inserts');
    mockProvider._store.set('doc1', { content: '', mimeType: 'text/plain' });

    await processor.processStore('doc1', fixture.updates);

    const stored = mockProvider._store.get('doc1');
    expect(stored?.content).toBe(fixture.expected_text);
  });

  test('processStore with empty updates is a no-op', async () => {
    const writeSpy = vi.spyOn(mockProvider, 'writeContent');

    const resp = await processor.processStore('doc1', []);
    expect(resp.stored).toBe(0);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test('sequential stores accumulate', async () => {
    const fixture1 = loadFixture('001-simple-insert');
    mockProvider._store.set('doc1', { content: '', mimeType: 'text/plain' });

    // First store
    await processor.processStore('doc1', fixture1.updates);
    expect(mockProvider._store.get('doc1')?.content).toBe('hello');

    // Second store with more updates (simulate additional edits)
    const fixture2 = loadFixture('002-multiple-inserts');
    await processor.processStore('doc1', fixture2.updates);

    // The content should reflect accumulated state
    const stored = mockProvider._store.get('doc1');
    expect(stored?.content).toBeTruthy();
  });

  test('processLoad after processStore returns accumulated state', async () => {
    const fixture = loadFixture('001-simple-insert');
    mockProvider._store.set('doc1', { content: '', mimeType: 'text/plain' });

    await processor.processStore('doc1', fixture.updates);

    const loadResp = await processor.processLoad('doc1');
    expect(loadResp.content).toBe('hello');
    expect((loadResp as any).updates).toBeUndefined();
  });

  test('processList delegates to provider', async () => {
    mockProvider._store.set('a.md', { content: '', mimeType: 'text/markdown' });
    mockProvider._store.set('b.js', { content: '', mimeType: 'text/javascript' });

    const docs = await processor.processList();
    expect(docs.length).toBe(2);
  });

  test('processHealth returns ok by default', async () => {
    const resp = await processor.processHealth();
    expect(resp.status).toBe('ok');
  });

  test('processHealth uses custom onHealth if defined', async () => {
    mockProvider.onHealth = async () => ({ status: 'degraded', storage: 'disk full' });

    const resp = await processor.processHealth();
    expect(resp.status).toBe('degraded');
    expect(resp.storage).toBe('disk full');
  });

  describe('shared fixtures — full round-trip', () => {
    const fixtureNames = [
      '001-simple-insert',
      '002-multiple-inserts',
      '003-delete',
      '005-large-document',
      '007-unicode',
      '008-rapid-edits',
      '009-replace-content',
    ];

    for (const name of fixtureNames) {
      test(`fixture: ${name}`, async () => {
        const fixture = loadFixture(name);
        mockProvider._store.set('test-doc', { content: fixture.initial_content, mimeType: 'text/plain' });

        await processor.processStore('test-doc', fixture.updates);

        const stored = mockProvider._store.get('test-doc');
        expect(stored?.content).toBe(fixture.expected_text);
      });
    }
  });
});
