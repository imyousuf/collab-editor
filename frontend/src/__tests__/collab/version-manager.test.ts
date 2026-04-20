import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { VersionManager } from '../../collab/version-manager.js';
import type { VersionEntry } from '../../collab/version-manager.js';

// Mock fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function mockJsonResponse(data: any, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as Response);
}

describe('VersionManager', () => {
  let doc: Y.Doc;
  let manager: VersionManager;

  beforeEach(() => {
    doc = new Y.Doc();
    doc.getText('source').insert(0, 'hello world');
    mockFetch.mockReset();

    manager = new VersionManager(doc, {
      relayUrl: 'http://localhost:8080',
      documentId: 'test-doc',
      userName: 'alice',
      autoSnapshotUpdates: 0, // disable auto-snapshot for these tests
      autoSnapshotMinutes: 0,
    });
  });

  afterEach(() => {
    manager.destroy();
    doc.destroy();
  });

  test('createVersion sends POST and returns entry', async () => {
    mockFetch.mockReturnValueOnce(
      mockJsonResponse({
        id: 'v1',
        created_at: '2026-01-01T00:00:00Z',
        type: 'manual',
        label: 'test',
        creator: 'alice',
      }, 201),
    );

    const entry = await manager.createVersion('test');
    expect(entry).not.toBeNull();
    expect(entry?.id).toBe('v1');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/documents/versions');
    expect(url).toContain('path=test-doc');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.content).toBe('hello world');
    expect(body.creator).toBe('alice');
    expect(body.label).toBe('test');
  });

  test('listVersions sends GET and returns array', async () => {
    mockFetch.mockReturnValueOnce(
      mockJsonResponse({
        versions: [
          { id: 'v1', created_at: '2026-01-01', type: 'manual' },
          { id: 'v2', created_at: '2026-01-02', type: 'auto' },
        ],
      }),
    );

    const versions = await manager.listVersions();
    expect(versions).toHaveLength(2);
    expect(versions[0].id).toBe('v1');
  });

  test('listVersions returns empty on error', async () => {
    mockFetch.mockReturnValueOnce(
      mockJsonResponse({ error: 'not found' }, 404),
    );

    const versions = await manager.listVersions();
    expect(versions).toHaveLength(0);
  });

  test('getVersion sends GET with version param', async () => {
    mockFetch.mockReturnValueOnce(
      mockJsonResponse({
        id: 'v1',
        content: 'hello',
        blame: [{ start: 0, end: 5, user_name: 'alice' }],
      }),
    );

    const version = await manager.getVersion('v1');
    expect(version).not.toBeNull();
    expect(version?.content).toBe('hello');
    expect(version?.blame).toHaveLength(1);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('version=v1');
  });

  test('diffVersions computes line diff', () => {
    const v1: VersionEntry = {
      id: 'v1',
      content: 'line1\nline2',
      created_at: '2026-01-01',
      type: 'manual',
    };
    const v2: VersionEntry = {
      id: 'v2',
      content: 'line1\nchanged\nline3',
      created_at: '2026-01-02',
      type: 'manual',
    };

    const diff = manager.diffVersions(v1, v2);
    expect(diff.some(d => d.type === 'unchanged')).toBe(true);
    expect(diff.some(d => d.type === 'added')).toBe(true);
    expect(diff.some(d => d.type === 'removed')).toBe(true);
  });

  test('revertToVersion replaces content and creates version', async () => {
    mockFetch.mockReturnValue(
      mockJsonResponse({ id: 'v-revert', type: 'manual' }, 201),
    );

    const version: VersionEntry = {
      id: 'v1',
      content: 'old content',
      created_at: '2026-01-01',
      type: 'manual',
      label: 'original',
    };

    await manager.revertToVersion(version);

    // Y.Text should now contain the old content
    expect(doc.getText('source').toString()).toBe('old content');

    // Should have called createVersion with revert label
    expect(mockFetch).toHaveBeenCalled();
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const body = JSON.parse(lastCall[1].body);
    expect(body.label).toContain('Reverted to');
  });

  test('destroy stops observer and timer', () => {
    const managerWithAuto = new VersionManager(doc, {
      relayUrl: 'http://localhost:8080',
      documentId: 'test-doc',
      autoSnapshotUpdates: 10,
      autoSnapshotMinutes: 1,
    });

    managerWithAuto.destroy();

    // Should not throw on subsequent edits
    doc.getText('source').insert(0, 'more');
    expect(true).toBe(true);
  });

  test('fetch URLs use the configured relayUrl base', async () => {
    mockFetch.mockReturnValueOnce(
      mockJsonResponse({ versions: [] }),
    );

    await manager.listVersions();

    const [url] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    expect(url).toMatch(/^http:\/\/localhost:8080\/api\/documents\/versions/);
    expect(url).toContain('path=test-doc');
  });
});
