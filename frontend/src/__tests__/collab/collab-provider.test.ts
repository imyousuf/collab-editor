import { describe, test, expect, vi } from 'vitest';
import { collaborationProviderContractTests } from '../interfaces/collaboration.contract.js';
import { CollaborationProvider } from '../../collab/collab-provider.js';

// Run contract tests
collaborationProviderContractTests(
  'CollaborationProvider',
  () => new CollaborationProvider(),
  { canConnect: false }, // Can't test connect without a real WebSocket server
);

describe('CollaborationProvider unit tests', () => {
  test('sharedText is named "source"', () => {
    const provider = new CollaborationProvider();
    // Verify the Y.Text is the one we expect
    provider.sharedText.insert(0, 'test');
    expect(provider.ydoc.getText('source').toString()).toBe('test');
    provider.destroy();
  });

  test('meta is a Y.Map', () => {
    const provider = new CollaborationProvider();
    provider.meta.set('key', 'value');
    expect(provider.meta.get('key')).toBe('value');
    provider.destroy();
  });

  test('onStatusChange fires on internal status change', () => {
    const provider = new CollaborationProvider();
    const statuses: string[] = [];
    provider.onStatusChange((s) => statuses.push(s));

    // Simulate status changes via internal method
    (provider as any)._setStatus('connecting');
    (provider as any)._setStatus('connected');
    (provider as any)._setStatus('disconnected');

    expect(statuses).toEqual(['connecting', 'connected', 'disconnected']);
    provider.destroy();
  });

  test('onStatusChange unsubscribe stops callbacks', () => {
    const provider = new CollaborationProvider();
    const callback = vi.fn();
    const unsub = provider.onStatusChange(callback);

    (provider as any)._setStatus('connecting');
    expect(callback).toHaveBeenCalledTimes(1);

    unsub();
    (provider as any)._setStatus('connected');
    expect(callback).toHaveBeenCalledTimes(1); // Not called again
    provider.destroy();
  });

  test('whenConnected resolves when status becomes connected', async () => {
    const provider = new CollaborationProvider();

    const promise = provider.whenConnected(5000);

    // Simulate connection
    setTimeout(() => {
      (provider as any)._setStatus('connecting');
      (provider as any)._setStatus('connected');
      // Resolve pending promises
      for (const { resolve, timer } of (provider as any)._connectedResolvers) {
        clearTimeout(timer);
        resolve();
      }
      (provider as any)._connectedResolvers = [];
    }, 10);

    await expect(promise).resolves.toBeUndefined();
    provider.destroy();
  });

  test('whenConnected rejects on timeout', async () => {
    const provider = new CollaborationProvider();
    await expect(provider.whenConnected(50)).rejects.toThrow('timed out');
    provider.destroy();
  });

  test('destroy rejects pending whenConnected promises', async () => {
    const provider = new CollaborationProvider();
    const promise = provider.whenConnected(10000);
    provider.destroy();
    await expect(promise).rejects.toThrow('destroyed');
  });
});
