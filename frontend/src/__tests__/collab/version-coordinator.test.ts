import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { VersionCoordinator, type VersionCoordinatorCallbacks } from '../../collab/version-coordinator.js';
import { BlameCoordinator } from '../../collab/blame-coordinator.js';

// Mock fetch globally
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Mock localStorage
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

function createMockBinding() {
  return {
    enableBlame: vi.fn(),
    disableBlame: vi.fn(),
    updateBlame: vi.fn(),
    supportedModes: ['source', 'wysiwyg'] as const,
    activeMode: 'source' as any,
    mounted: true,
    mount: vi.fn(),
    unmount: vi.fn(),
    switchMode: vi.fn(),
    getContent: vi.fn(() => ''),
    setContent: vi.fn(),
    setReadonly: vi.fn(),
    onContentChange: vi.fn(() => () => {}),
    onRemoteChange: vi.fn(() => () => {}),
    rebindSharedText: vi.fn(),
    getCurrentSerialized: vi.fn(() => ''),
    focusEditor: vi.fn(),
    destroy: vi.fn(),
  };
}

function createMockCollabProvider(doc: Y.Doc) {
  const text = doc.getText('source');
  return {
    syncText: text,
    syncDoc: doc,
    editorText: text,
    editorDoc: doc,
    awareness: { clientID: 1, getStates: () => new Map() },
  };
}

function createCallbacks(): VersionCoordinatorCallbacks & { calls: Record<string, any[]> } {
  const calls: Record<string, any[]> = {
    versions: [],
    selected: [],
    diff: [],
    viewing: [],
  };
  return {
    calls,
    onVersionsChange: vi.fn((v) => { calls.versions.push(v); }),
    onSelectedVersionChange: vi.fn((v) => { calls.selected.push(v); }),
    onDiffResultChange: vi.fn((d) => { calls.diff.push(d); }),
    onViewingVersionChange: vi.fn((viewing) => { calls.viewing.push(viewing); }),
  };
}

function mockFetchResponse(data: any, ok = true) {
  fetchMock.mockResolvedValueOnce({
    ok,
    json: () => Promise.resolve(data),
  });
}

describe('VersionCoordinator', () => {
  let coordinator: VersionCoordinator;
  let doc: Y.Doc;
  let binding: ReturnType<typeof createMockBinding>;
  let collabProvider: ReturnType<typeof createMockCollabProvider>;
  let callbacks: ReturnType<typeof createCallbacks>;

  beforeEach(() => {
    localStorageMock.clear();
    fetchMock.mockReset();
    coordinator = new VersionCoordinator();
    doc = new Y.Doc();
    binding = createMockBinding();
    collabProvider = createMockCollabProvider(doc);
    callbacks = createCallbacks();

    // Default: listVersions returns empty
    mockFetchResponse({ versions: [] });
  });

  afterEach(() => {
    coordinator.detach();
    doc.destroy();
  });

  function attachCoordinator(config?: Partial<Parameters<typeof coordinator.attach>[3]>) {
    coordinator.attach(binding, doc, collabProvider, {
      relayUrl: 'http://localhost:3000',
      documentId: 'test-doc',
      userName: 'Alice',
      autoSnapshot: false,
      ...config,
    }, callbacks);
  }

  test('starts unavailable', () => {
    expect(coordinator.available).toBe(false);
    expect(coordinator.panelOpen).toBe(false);
    expect(coordinator.viewingVersion).toBe(false);
  });

  test('available after attach', async () => {
    attachCoordinator();
    // Wait for initial listVersions
    await vi.waitFor(() => expect(coordinator.available).toBe(true));
  });

  test('not available after detach', () => {
    attachCoordinator();
    coordinator.detach();
    expect(coordinator.available).toBe(false);
  });

  test('togglePanel opens and closes', () => {
    mockFetchResponse({ versions: [] }); // for the refresh on open
    attachCoordinator();
    expect(coordinator.panelOpen).toBe(false);

    coordinator.togglePanel();
    expect(coordinator.panelOpen).toBe(true);

    coordinator.togglePanel();
    expect(coordinator.panelOpen).toBe(false);
  });

  test('closePanel closes panel', () => {
    mockFetchResponse({ versions: [] }); // for the refresh on open
    attachCoordinator();
    coordinator.togglePanel();
    expect(coordinator.panelOpen).toBe(true);

    coordinator.closePanel();
    expect(coordinator.panelOpen).toBe(false);
  });

  test('save creates version and notifies', async () => {
    attachCoordinator();
    const entry = { id: 'v1', created_at: '2026-01-01', type: 'manual', creator: 'Alice' };
    mockFetchResponse(entry);

    await coordinator.save();

    expect(coordinator.versions).toHaveLength(1);
    expect(coordinator.versions[0].id).toBe('v1');
    expect(callbacks.onVersionsChange).toHaveBeenCalled();
  });

  test('select fetches and notifies', async () => {
    attachCoordinator();
    const version = { id: 'v1', content: 'hello', created_at: '2026-01-01', type: 'manual' };
    mockFetchResponse(version);

    await coordinator.select('v1');

    expect(coordinator.selectedVersion?.id).toBe('v1');
    expect(callbacks.onSelectedVersionChange).toHaveBeenCalledWith(version);
  });

  test('view enters version view mode', async () => {
    attachCoordinator();
    const version = { id: 'v1', content: 'hello world', created_at: '2026-01-01', type: 'manual' };
    mockFetchResponse(version);

    await coordinator.view('v1');

    expect(coordinator.viewingVersion).toBe(true);
    expect(binding.setReadonly).toHaveBeenCalledWith(true);
    expect(binding.setContent).toHaveBeenCalledWith('hello world');
    expect(callbacks.onViewingVersionChange).toHaveBeenCalledWith(true);
  });

  test('view applies version blame when available', async () => {
    const blameCoordinator = new BlameCoordinator();
    blameCoordinator.attach(binding, doc, collabProvider.awareness, 'test-doc');

    coordinator.attach(binding, doc, collabProvider, {
      relayUrl: 'http://localhost:3000',
      documentId: 'test-doc',
      userName: 'Alice',
      autoSnapshot: false,
    }, callbacks, blameCoordinator);

    const version = {
      id: 'v1',
      content: 'hello',
      created_at: '2026-01-01',
      type: 'manual',
      blame: [{ start: 0, end: 5, user_name: 'alice' }],
    };
    mockFetchResponse(version);

    await coordinator.view('v1');

    expect(binding.enableBlame).toHaveBeenCalledWith([
      { start: 0, end: 5, userName: 'alice' },
    ]);

    blameCoordinator.detach();
  });

  test('view does not apply blame when versionBlameEnabled is false', async () => {
    const blameCoordinator = new BlameCoordinator();
    blameCoordinator.attach(binding, doc, collabProvider.awareness, 'test-doc', {
      versionBlameEnabled: false,
    });

    coordinator.attach(binding, doc, collabProvider, {
      relayUrl: 'http://localhost:3000',
      documentId: 'test-doc',
      userName: 'Alice',
      autoSnapshot: false,
      versionBlameEnabled: false,
    }, callbacks, blameCoordinator);

    const version = {
      id: 'v1',
      content: 'hello',
      created_at: '2026-01-01',
      type: 'manual',
      blame: [{ start: 0, end: 5, user_name: 'alice' }],
    };
    mockFetchResponse(version);

    await coordinator.view('v1');

    expect(binding.enableBlame).not.toHaveBeenCalled();

    blameCoordinator.detach();
  });

  test('revert exits version view and creates new version', async () => {
    attachCoordinator();
    doc.getText('source').insert(0, 'current content');

    // First fetch: getVersion for view
    mockFetchResponse({ id: 'v1', content: 'old content', created_at: '2026-01-01', type: 'manual' });
    await coordinator.view('v1');

    // Second fetch: getVersion for revert
    mockFetchResponse({ id: 'v1', content: 'old content', created_at: '2026-01-01', type: 'manual' });
    // Third fetch: createVersion (revert creates a new version)
    mockFetchResponse({ id: 'v2', created_at: '2026-01-01', type: 'manual', label: 'Reverted to v1' });
    // Fourth fetch: listVersions after revert
    mockFetchResponse({ versions: [
      { id: 'v2', created_at: '2026-01-01', type: 'manual' },
      { id: 'v1', created_at: '2026-01-01', type: 'manual' },
    ]});

    await coordinator.revert('v1');

    expect(coordinator.viewingVersion).toBe(false);
    expect(binding.setReadonly).toHaveBeenCalledWith(false);
    expect(doc.getText('source').toString()).toBe('old content');
  });

  test('diff computes and notifies', async () => {
    attachCoordinator();

    mockFetchResponse({ id: 'v1', content: 'hello', created_at: '2026-01-01', type: 'manual' });
    mockFetchResponse({ id: 'v2', content: 'hello world', created_at: '2026-01-02', type: 'manual' });

    await coordinator.diff('v1', 'v2');

    expect(coordinator.diffResult).not.toBeNull();
    expect(coordinator.diffResult!.length).toBeGreaterThan(0);
    expect(callbacks.onDiffResultChange).toHaveBeenCalled();
  });

  test('clearDiff resets diff state', async () => {
    attachCoordinator();
    mockFetchResponse({ id: 'v1', content: 'hello', created_at: '2026-01-01', type: 'manual' });
    mockFetchResponse({ id: 'v2', content: 'world', created_at: '2026-01-02', type: 'manual' });

    await coordinator.diff('v1', 'v2');
    coordinator.clearDiff();

    expect(coordinator.diffResult).toBeNull();
    expect(callbacks.onDiffResultChange).toHaveBeenCalledWith(null);
  });

  test('handleAppMessage adds version-created entries', () => {
    attachCoordinator();
    const entry = { id: 'v-new', created_at: '2026-01-01', type: 'auto' };
    coordinator.handleAppMessage({ type: 'version-created', version: entry });

    expect(coordinator.versions).toHaveLength(1);
    expect(coordinator.versions[0].id).toBe('v-new');
  });

  test('handleAppMessage ignores unrelated messages', () => {
    attachCoordinator();
    coordinator.handleAppMessage({ type: 'other-event' });
    coordinator.handleAppMessage(null);

    expect(coordinator.versions).toHaveLength(0);
  });

  test('closePanel exits version view mode', async () => {
    attachCoordinator();
    mockFetchResponse({ id: 'v1', content: 'hello', created_at: '2026-01-01', type: 'manual' });
    await coordinator.view('v1');

    coordinator.closePanel();

    expect(coordinator.viewingVersion).toBe(false);
    expect(coordinator.panelOpen).toBe(false);
  });

  test('detach cleans up version view state', async () => {
    attachCoordinator();
    mockFetchResponse({ id: 'v1', content: 'hello', created_at: '2026-01-01', type: 'manual' });
    await coordinator.view('v1');

    coordinator.detach();

    expect(coordinator.viewingVersion).toBe(false);
    expect(coordinator.versions).toHaveLength(0);
    expect(coordinator.selectedVersion).toBeNull();
    expect(coordinator.diffResult).toBeNull();
  });
});
