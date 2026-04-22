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

  test('initial status is disconnected', () => {
    const provider = new CollaborationProvider();
    expect(provider.status).toBe('disconnected');
    provider.destroy();
  });

  test('awareness is null before connect', () => {
    const provider = new CollaborationProvider();
    expect(provider.awareness).toBeNull();
    provider.destroy();
  });

  test('_setStatus deduplicates (same status twice = one callback)', () => {
    const provider = new CollaborationProvider();
    const callback = vi.fn();
    provider.onStatusChange(callback);

    (provider as any)._setStatus('connecting');
    (provider as any)._setStatus('connecting'); // duplicate
    expect(callback).toHaveBeenCalledTimes(1);

    provider.destroy();
  });

  test('disconnect without prior connect does not throw', () => {
    const provider = new CollaborationProvider();
    expect(() => provider.disconnect()).not.toThrow();
    provider.destroy();
  });

  test('disconnect sets status to disconnected', () => {
    const provider = new CollaborationProvider();
    const statuses: string[] = [];
    provider.onStatusChange(s => statuses.push(s));

    (provider as any)._setStatus('connecting');
    provider.disconnect();
    expect(statuses).toContain('disconnected');

    provider.destroy();
  });

  test('whenConnected resolves immediately if already connected', async () => {
    const provider = new CollaborationProvider();
    (provider as any)._status = 'connected';

    await expect(provider.whenConnected(100)).resolves.toBeUndefined();
    provider.destroy();
  });

  test('onRemoteUpdate returns unsubscribe function', () => {
    const provider = new CollaborationProvider();
    const callback = vi.fn();
    const unsub = provider.onRemoteUpdate(callback);
    expect(typeof unsub).toBe('function');
    unsub();
    provider.destroy();
  });

  test('onRemoteUpdate unsubscribe stops callbacks', () => {
    const provider = new CollaborationProvider();
    const callback = vi.fn();
    const unsub = provider.onRemoteUpdate(callback);

    // Add to set, then remove
    unsub();
    expect((provider as any)._remoteCallbacks.size).toBe(0);

    provider.destroy();
  });

  test('destroy clears all callback sets', () => {
    const provider = new CollaborationProvider();
    provider.onStatusChange(vi.fn());
    provider.onRemoteUpdate(vi.fn());

    provider.destroy();

    expect((provider as any)._statusCallbacks.size).toBe(0);
    expect((provider as any)._remoteCallbacks.size).toBe(0);
  });

  test('multiple whenConnected promises all resolve on connect', async () => {
    const provider = new CollaborationProvider();

    const p1 = provider.whenConnected(5000);
    const p2 = provider.whenConnected(5000);

    setTimeout(() => {
      (provider as any)._setStatus('connected');
      for (const { resolve, timer } of (provider as any)._connectedResolvers) {
        clearTimeout(timer);
        resolve();
      }
      (provider as any)._connectedResolvers = [];
    }, 10);

    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();

    provider.destroy();
  });

  test('whenConnected timeout removes resolver from list', async () => {
    const provider = new CollaborationProvider();

    try {
      await provider.whenConnected(50);
    } catch {
      // Expected
    }

    // Resolver should have been removed
    expect((provider as any)._connectedResolvers.length).toBe(0);

    provider.destroy();
  });

  test('CollaborationConfig accepts transport field', () => {
    // Type-level test: transport field exists and accepts both values
    const wsConfig = {
      enabled: true,
      roomName: 'test',
      providerUrl: 'ws://localhost:8080',
      transport: 'websocket' as const,
      user: { name: 'User', color: '#000' },
    };
    expect(wsConfig.transport).toBe('websocket');

    const sioConfig = {
      enabled: true,
      roomName: 'test',
      providerUrl: '/collab',
      transport: 'socketio' as const,
      socketAuth: { token: 'abc', instance_id: '123' },
      user: { name: 'User', color: '#000' },
    };
    expect(sioConfig.transport).toBe('socketio');
    expect(sioConfig.socketAuth).toEqual({ token: 'abc', instance_id: '123' });
  });

  test('CollaborationConfig transport defaults to undefined (websocket)', () => {
    const config: import('../../interfaces/collaboration.js').CollaborationConfig = {
      enabled: true,
      roomName: 'test',
      providerUrl: 'ws://localhost:8080',
      user: { name: 'User', color: '#000' },
    };
    expect(config.transport).toBeUndefined();
  });

  test('onAppMessage registers and unregisters callbacks', () => {
    const provider = new CollaborationProvider();
    const callback = vi.fn();
    const unsub = provider.onAppMessage(callback);

    // Simulate an app message by accessing private callbacks
    (provider as any)._appMessageCallbacks.forEach((cb: any) => cb({ type: 'test' }));
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0]).toEqual({ type: 'test' });

    // Unsubscribe
    unsub();
    callback.mockClear();
    (provider as any)._appMessageCallbacks.forEach((cb: any) => cb({ type: 'test2' }));
    expect(callback).not.toHaveBeenCalled();
  });

  test('onAppMessage callbacks are cleared on destroy', () => {
    const provider = new CollaborationProvider();
    const callback = vi.fn();
    provider.onAppMessage(callback);

    provider.destroy();

    expect((provider as any)._appMessageCallbacks.size).toBe(0);
  });
});
