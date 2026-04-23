import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { BlameCoordinator } from '../../collab/blame-coordinator.js';

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
    // IEditorBinding stubs
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
    destroy: vi.fn(),
  };
}

function createMockAwareness() {
  const states = new Map<number, any>();
  states.set(1, { user: { name: 'Alice' } });
  return {
    clientID: 1,
    getStates: () => states,
    getLocalState: () => ({ user: { name: 'Alice' } }),
  };
}

describe('BlameCoordinator', () => {
  let coordinator: BlameCoordinator;
  let doc: Y.Doc;
  let binding: ReturnType<typeof createMockBinding>;
  let awareness: ReturnType<typeof createMockAwareness>;

  beforeEach(() => {
    localStorageMock.clear();
    coordinator = new BlameCoordinator();
    doc = new Y.Doc();
    binding = createMockBinding();
    awareness = createMockAwareness();
  });

  afterEach(() => {
    coordinator.detach();
    doc.destroy();
  });

  test('starts inactive', () => {
    expect(coordinator.active).toBe(false);
    expect(coordinator.available).toBe(false);
  });

  test('available after attach', () => {
    coordinator.attach(binding, doc, awareness, 'doc1');
    expect(coordinator.available).toBe(true);
    expect(coordinator.active).toBe(false);
  });

  test('not available when liveBlameEnabled is false', () => {
    coordinator.attach(binding, doc, awareness, 'doc1', { liveBlameEnabled: false });
    expect(coordinator.available).toBe(false);
  });

  test('not available after detach', () => {
    coordinator.attach(binding, doc, awareness, 'doc1');
    coordinator.detach();
    expect(coordinator.available).toBe(false);
    expect(coordinator.active).toBe(false);
  });

  test('toggle on enables blame', () => {
    coordinator.attach(binding, doc, awareness, 'doc1');
    coordinator.toggle(true);

    expect(coordinator.active).toBe(true);
    expect(binding.enableBlame).toHaveBeenCalledTimes(1);
  });

  test('toggle off disables blame', () => {
    coordinator.attach(binding, doc, awareness, 'doc1');
    coordinator.toggle(true);
    coordinator.toggle(false);

    expect(coordinator.active).toBe(false);
    expect(binding.disableBlame).toHaveBeenCalled();
  });

  test('toggle does nothing when liveBlameEnabled is false', () => {
    coordinator.attach(binding, doc, awareness, 'doc1', { liveBlameEnabled: false });
    coordinator.toggle(true);

    expect(coordinator.active).toBe(false);
    expect(binding.enableBlame).not.toHaveBeenCalled();
  });

  test('onActiveChange callback fires on toggle', () => {
    const callback = vi.fn();
    coordinator.onActiveChange(callback);
    coordinator.attach(binding, doc, awareness, 'doc1');

    coordinator.toggle(true);
    expect(callback).toHaveBeenCalledWith(true);

    coordinator.toggle(false);
    expect(callback).toHaveBeenCalledWith(false);
  });

  test('debounced update on Y.Doc change', async () => {
    vi.useFakeTimers();
    coordinator.attach(binding, doc, awareness, 'doc1');
    coordinator.toggle(true);

    // Seed content to produce blame segments
    doc.getText('source').insert(0, 'hello');

    // No update yet (debounce pending)
    expect(binding.updateBlame).not.toHaveBeenCalled();

    // Advance past debounce (300ms)
    vi.advanceTimersByTime(300);

    expect(binding.updateBlame).toHaveBeenCalled();
    vi.useRealTimers();
  });

  test('debounce coalesces rapid updates', () => {
    vi.useFakeTimers();
    coordinator.attach(binding, doc, awareness, 'doc1');
    coordinator.toggle(true);

    const text = doc.getText('source');
    text.insert(0, 'a');
    vi.advanceTimersByTime(100);
    text.insert(1, 'b');
    vi.advanceTimersByTime(100);
    text.insert(2, 'c');
    vi.advanceTimersByTime(300);

    // Should only update once after the last change + debounce
    expect(binding.updateBlame).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test('onModeSwitch re-pushes blame when active', () => {
    coordinator.attach(binding, doc, awareness, 'doc1');
    coordinator.toggle(true);
    binding.updateBlame.mockClear();

    coordinator.onModeSwitch();
    expect(binding.updateBlame).toHaveBeenCalledTimes(1);
  });

  test('onModeSwitch does nothing when inactive', () => {
    coordinator.attach(binding, doc, awareness, 'doc1');
    coordinator.onModeSwitch();
    expect(binding.updateBlame).not.toHaveBeenCalled();
  });

  test('enableVersionBlame delegates to binding', () => {
    coordinator.attach(binding, doc, awareness, 'doc1');
    const segments = [{ start: 0, end: 5, userName: 'alice' }];
    coordinator.enableVersionBlame(segments);
    expect(binding.enableBlame).toHaveBeenCalledWith(segments);
  });

  test('enableVersionBlame respects versionBlameEnabled config', () => {
    coordinator.attach(binding, doc, awareness, 'doc1', { versionBlameEnabled: false });
    coordinator.enableVersionBlame([{ start: 0, end: 5, userName: 'alice' }]);
    expect(binding.enableBlame).not.toHaveBeenCalled();
  });

  test('disableVersionBlame delegates to binding', () => {
    coordinator.attach(binding, doc, awareness, 'doc1');
    coordinator.disableVersionBlame();
    expect(binding.disableBlame).toHaveBeenCalled();
  });

  test('detach stops live blame and clears observer', () => {
    vi.useFakeTimers();
    coordinator.attach(binding, doc, awareness, 'doc1');
    coordinator.toggle(true);

    coordinator.detach();

    // Changes after detach should not trigger updates
    binding.updateBlame.mockClear();
    doc.getText('source').insert(0, 'test');
    vi.advanceTimersByTime(500);
    expect(binding.updateBlame).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  test('attach after detach works cleanly', () => {
    coordinator.attach(binding, doc, awareness, 'doc1');
    coordinator.toggle(true);
    coordinator.detach();

    // Re-attach with fresh state
    const binding2 = createMockBinding();
    coordinator.attach(binding2, doc, awareness, 'doc2');
    coordinator.toggle(true);

    expect(coordinator.active).toBe(true);
    expect(binding2.enableBlame).toHaveBeenCalled();
  });

  test('non-blame-capable binding is handled gracefully', () => {
    const plainBinding = {
      supportedModes: ['source'] as const,
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
      destroy: vi.fn(),
      // No blame methods
    };

    coordinator.attach(plainBinding as any, doc, awareness, 'doc1');
    expect(coordinator.available).toBe(false);
    expect(() => coordinator.toggle(true)).not.toThrow();
  });
});
