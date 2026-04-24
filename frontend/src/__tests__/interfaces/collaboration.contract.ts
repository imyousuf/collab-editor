import { describe, test, expect, vi } from 'vitest';
import type { ICollaborationProvider } from '../../interfaces/collaboration.js';

/**
 * Contract tests for ICollaborationProvider implementations.
 * These test the interface contract, not WebSocket behavior.
 * The provider implementation must be testable without a real WebSocket server.
 */
export function collaborationProviderContractTests(
  name: string,
  createProvider: () => ICollaborationProvider,
  options: {
    /** If true, connect() can be tested (has mock/in-memory transport) */
    canConnect: boolean;
  },
) {
  describe(`ICollaborationProvider contract: ${name}`, () => {
    test('initial status is disconnected', () => {
      const provider = createProvider();
      expect(provider.status).toBe('disconnected');
      provider.destroy();
    });

    test('sharedText is a Y.Text instance', () => {
      const provider = createProvider();
      expect(provider.sharedText).toBeDefined();
      expect(typeof provider.sharedText.insert).toBe('function');
      expect(typeof provider.sharedText.delete).toBe('function');
      expect(typeof provider.sharedText.toString).toBe('function');
      provider.destroy();
    });

    test('meta is a Y.Map instance', () => {
      const provider = createProvider();
      expect(provider.meta).toBeDefined();
      expect(typeof provider.meta.set).toBe('function');
      expect(typeof provider.meta.get).toBe('function');
      provider.destroy();
    });

    test('ydoc is defined', () => {
      const provider = createProvider();
      expect(provider.ydoc).toBeDefined();
      provider.destroy();
    });

    test('syncDoc and editorDoc are distinct Y.Doc instances', () => {
      const provider = createProvider();
      expect(provider.syncDoc).toBeDefined();
      expect(provider.editorDoc).toBeDefined();
      expect(provider.syncDoc).not.toBe(provider.editorDoc);
      provider.destroy();
    });

    test('syncText == syncDoc.getText("source") and editorText == editorDoc.getText("source")', () => {
      const provider = createProvider();
      expect(provider.syncText).toBe(provider.syncDoc.getText('source'));
      expect(provider.editorText).toBe(provider.editorDoc.getText('source'));
      provider.destroy();
    });

    test('ydoc alias points at syncDoc', () => {
      const provider = createProvider();
      expect(provider.ydoc).toBe(provider.syncDoc);
      expect(provider.sharedText).toBe(provider.syncText);
      provider.destroy();
    });

    test('replicator is wired: editor edits propagate to syncDoc', () => {
      const provider = createProvider();
      provider.editorText.insert(0, 'hi');
      expect(provider.syncText.toString()).toBe('hi');
      provider.destroy();
    });

    test('replicator is wired: syncDoc edits propagate to editorDoc', () => {
      const provider = createProvider();
      provider.syncText.insert(0, 'hello');
      expect(provider.editorText.toString()).toBe('hello');
      provider.destroy();
    });

    test('onStatusChange returns unsubscribe function', () => {
      const provider = createProvider();
      const callback = vi.fn();
      const unsub = provider.onStatusChange(callback);
      expect(typeof unsub).toBe('function');
      unsub();
      provider.destroy();
    });

    test('onRemoteUpdate returns unsubscribe function', () => {
      const provider = createProvider();
      const callback = vi.fn();
      const unsub = provider.onRemoteUpdate(callback);
      expect(typeof unsub).toBe('function');
      unsub();
      provider.destroy();
    });

    test('destroy does not throw', () => {
      const provider = createProvider();
      expect(() => provider.destroy()).not.toThrow();
    });

    test('double destroy does not throw', () => {
      const provider = createProvider();
      provider.destroy();
      expect(() => provider.destroy()).not.toThrow();
    });

    if (options.canConnect) {
      test('whenConnected rejects after timeout when not connected', async () => {
        const provider = createProvider();
        await expect(provider.whenConnected(100)).rejects.toThrow();
        provider.destroy();
      });
    }
  });
}
