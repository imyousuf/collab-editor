import { describe, test, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

// Mock socket.io-client before importing SocketIOProvider
const mockSocket = {
  on: vi.fn(),
  emit: vi.fn(),
  disconnect: vi.fn(),
  connected: false,
};

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocket),
}));

import { SocketIOProvider } from '../../collab/socketio-provider.js';
import { io } from 'socket.io-client';

function getHandler(eventName: string): ((...args: any[]) => void) | undefined {
  const call = mockSocket.on.mock.calls.find((c: any[]) => c[0] === eventName);
  return call ? call[1] : undefined;
}

function triggerSocketEvent(eventName: string, ...args: any[]): void {
  const handler = getHandler(eventName);
  if (handler) handler(...args);
}

describe('SocketIOProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket.connected = false;
  });

  test('constructor creates socket with correct options', () => {
    const doc = new Y.Doc();
    const provider = new SocketIOProvider('http://localhost:3000/collab', 'test-doc', doc, {
      auth: { token: 'abc' },
    });

    expect(io).toHaveBeenCalledWith('http://localhost:3000/collab', expect.objectContaining({
      query: { doc: 'test-doc' },
      auth: { token: 'abc' },
      transports: ['websocket'],
    }));

    provider.destroy();
    doc.destroy();
  });

  test('connect emits sync step 1 and awareness on socket connect', () => {
    const doc = new Y.Doc();
    const provider = new SocketIOProvider('http://localhost/collab', 'doc1', doc);

    // Simulate socket connect
    triggerSocketEvent('connect');

    expect(provider.wsconnected).toBe(true);

    // Should have emitted yjs-sync at least twice (sync step 1 + awareness)
    const yjsSyncCalls = mockSocket.emit.mock.calls.filter((c: any[]) => c[0] === 'yjs-sync');
    expect(yjsSyncCalls.length).toBeGreaterThanOrEqual(1);

    // First yjs-sync should be a sync message (message type 0)
    const firstMsg = new Uint8Array(yjsSyncCalls[0][1]);
    const decoder = decoding.createDecoder(firstMsg);
    const msgType = decoding.readVarUint(decoder);
    expect(msgType).toBe(0); // messageSync

    provider.destroy();
    doc.destroy();
  });

  test('status event fires on connect', () => {
    const doc = new Y.Doc();
    const provider = new SocketIOProvider('http://localhost/collab', 'doc1', doc);

    const statuses: string[] = [];
    provider.on('status', (event: any) => {
      statuses.push(event.status);
    });

    triggerSocketEvent('connect');
    expect(statuses).toContain('connected');

    provider.destroy();
    doc.destroy();
  });

  test('status event fires on disconnect', () => {
    const doc = new Y.Doc();
    const provider = new SocketIOProvider('http://localhost/collab', 'doc1', doc);

    const statuses: string[] = [];
    provider.on('status', (event: any) => {
      statuses.push(event.status);
    });

    triggerSocketEvent('connect');
    triggerSocketEvent('disconnect');
    expect(statuses).toContain('disconnected');
    expect(provider.wsconnected).toBe(false);

    provider.destroy();
    doc.destroy();
  });

  test('local Y.Doc update emits yjs-sync', () => {
    const doc = new Y.Doc();
    const provider = new SocketIOProvider('http://localhost/collab', 'doc1', doc);

    triggerSocketEvent('connect');
    mockSocket.emit.mockClear();

    // Make a local change
    doc.getArray('test').insert(0, ['hello']);

    // Should have emitted a sync update
    const yjsSyncCalls = mockSocket.emit.mock.calls.filter((c: any[]) => c[0] === 'yjs-sync');
    expect(yjsSyncCalls.length).toBeGreaterThan(0);

    provider.destroy();
    doc.destroy();
  });

  test('remote Y.Doc update with provider origin does NOT re-emit', () => {
    const doc = new Y.Doc();
    const provider = new SocketIOProvider('http://localhost/collab', 'doc1', doc);

    triggerSocketEvent('connect');
    mockSocket.emit.mockClear();

    // Simulate a remote update (origin === provider)
    doc.transact(() => {
      doc.getArray('test').insert(0, ['remote']);
    }, provider);

    // Should NOT have emitted (origin check)
    const yjsSyncCalls = mockSocket.emit.mock.calls.filter((c: any[]) => c[0] === 'yjs-sync');
    expect(yjsSyncCalls.length).toBe(0);

    provider.destroy();
    doc.destroy();
  });

  test('incoming yjs-sync applies to Y.Doc', () => {
    const doc = new Y.Doc();
    const provider = new SocketIOProvider('http://localhost/collab', 'doc1', doc);
    triggerSocketEvent('connect');

    // Create a remote doc and generate an update
    const remoteDoc = new Y.Doc();
    remoteDoc.getArray('items').insert(0, ['from-remote']);
    const update = Y.encodeStateAsUpdate(remoteDoc);

    // Encode as a sync update message
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0); // messageSync
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);

    // Deliver to provider
    triggerSocketEvent('yjs-sync', message.buffer);

    // Doc should now have the remote data
    expect(doc.getArray('items').length).toBe(1);
    expect(doc.getArray('items').get(0)).toBe('from-remote');

    provider.destroy();
    doc.destroy();
    remoteDoc.destroy();
  });

  test('incoming awareness update applies to awareness', () => {
    const doc = new Y.Doc();
    const provider = new SocketIOProvider('http://localhost/collab', 'doc1', doc);
    triggerSocketEvent('connect');

    // Create a fake awareness update from another client
    const remoteDoc = new Y.Doc();
    const remoteAwareness = new awarenessProtocol.Awareness(remoteDoc);
    remoteAwareness.setLocalState({ user: { name: 'Alice', color: '#f00' } });

    const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(
      remoteAwareness,
      [remoteDoc.clientID],
    );

    // Encode as awareness message
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1); // messageAwareness
    encoding.writeVarUint8Array(encoder, awarenessUpdate);
    const message = encoding.toUint8Array(encoder);

    triggerSocketEvent('yjs-sync', message.buffer);

    // Provider awareness should now have the remote state
    const states = provider.awareness.getStates();
    expect(states.size).toBeGreaterThan(0);

    provider.destroy();
    doc.destroy();
    remoteDoc.destroy();
  });

  test('disconnect calls socket.disconnect', () => {
    const doc = new Y.Doc();
    const provider = new SocketIOProvider('http://localhost/collab', 'doc1', doc);

    provider.disconnect();
    expect(mockSocket.disconnect).toHaveBeenCalled();
    expect(provider.wsconnected).toBe(false);

    provider.destroy();
    doc.destroy();
  });

  test('destroy cleans up listeners and socket', () => {
    const doc = new Y.Doc();
    const provider = new SocketIOProvider('http://localhost/collab', 'doc1', doc);

    provider.destroy();
    expect(mockSocket.disconnect).toHaveBeenCalled();

    // Double destroy should not throw
    expect(() => provider.destroy()).not.toThrow();

    doc.destroy();
  });

  test('does not emit when not connected', () => {
    const doc = new Y.Doc();
    const provider = new SocketIOProvider('http://localhost/collab', 'doc1', doc, {
      connect: false,
    });

    // Make a local change without being connected
    doc.getArray('test').insert(0, ['hello']);

    // Should not have emitted anything
    const yjsSyncCalls = mockSocket.emit.mock.calls.filter((c: any[]) => c[0] === 'yjs-sync');
    expect(yjsSyncCalls.length).toBe(0);

    provider.destroy();
    doc.destroy();
  });

  test('connect_error emits disconnected status', () => {
    const doc = new Y.Doc();
    const provider = new SocketIOProvider('http://localhost/collab', 'doc1', doc);

    const statuses: string[] = [];
    provider.on('status', (event: any) => {
      statuses.push(event.status);
    });

    triggerSocketEvent('connect_error');
    expect(statuses).toContain('disconnected');

    provider.destroy();
    doc.destroy();
  });
});
