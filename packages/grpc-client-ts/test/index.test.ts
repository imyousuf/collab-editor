import { describe, test, expect } from 'vitest';
import { existsSync } from 'fs';
import { PROTO_PATH, createRelayClient } from '../src/index.js';

describe('PROTO_PATH', () => {
  test('points to existing proto file', () => {
    expect(PROTO_PATH).toBeDefined();
    expect(PROTO_PATH.endsWith('relay.proto')).toBe(true);
    expect(existsSync(PROTO_PATH)).toBe(true);
  });
});

describe('createRelayClient', () => {
  test('creates a client instance', () => {
    // Create a client pointing to a dummy address (we won't connect)
    const client = createRelayClient('localhost:50051');
    expect(client).toBeDefined();
    expect(typeof client.joinRoom).toBe('function');
    expect(typeof client.health).toBe('function');
    client.close();
  });

  test('client has expected methods', () => {
    const client = createRelayClient('localhost:50051');
    // Verify the service definition loaded correctly
    expect(typeof client.joinRoom).toBe('function');
    expect(typeof client.health).toBe('function');
    client.close();
  });
});

describe('proto file contents', () => {
  test('proto file contains expected service definition', async () => {
    const { readFileSync } = await import('fs');
    const content = readFileSync(PROTO_PATH, 'utf-8');
    expect(content).toContain('service RelayService');
    expect(content).toContain('rpc JoinRoom');
    expect(content).toContain('rpc Health');
    expect(content).toContain('message RoomMessage');
  });
});
