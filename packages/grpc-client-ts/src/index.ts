/**
 * gRPC client for the collab-editor relay service.
 *
 * Usage:
 * ```ts
 * import { createRelayClient, PROTO_PATH } from '@imyousuf/collab-editor-grpc';
 *
 * const client = createRelayClient('localhost:50051');
 * const stream = client.joinRoom();
 *
 * // Join a document room
 * stream.write({ document_id: 'my-doc', payload: syncStep1 });
 *
 * // Send Yjs updates
 * stream.write({ payload: update });
 *
 * // Receive updates
 * stream.on('data', (msg) => {
 *   // msg.payload is the raw Yjs binary
 * });
 * ```
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export type {
  RoomMessage,
  HealthRequest,
  HealthResponse,
  RelayServiceClient,
  RelayDuplexStream,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the relay.proto file bundled with this package. */
export const PROTO_PATH = join(__dirname, '..', 'proto', 'relay.proto');

/** Default proto-loader options for consistent behavior. */
const LOADER_OPTIONS: protoLoader.Options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

let _cachedDefinition: grpc.GrpcObject | null = null;

function getServiceDefinition(): grpc.GrpcObject {
  if (!_cachedDefinition) {
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, LOADER_OPTIONS);
    _cachedDefinition = grpc.loadPackageDefinition(packageDefinition);
  }
  return _cachedDefinition;
}

/**
 * Create a gRPC client for the relay's RelayService.
 *
 * @param address - Server address (e.g., 'localhost:50051')
 * @param credentials - gRPC credentials (defaults to insecure)
 * @param options - Additional gRPC channel options
 */
export function createRelayClient(
  address: string,
  credentials?: grpc.ChannelCredentials,
  options?: grpc.ClientOptions,
): any {
  const definition = getServiceDefinition();
  const relayapi = definition['relayapi'] as grpc.GrpcObject;
  const v1 = relayapi['v1'] as grpc.GrpcObject;
  const RelayService = v1['RelayService'] as grpc.ServiceClientConstructor;

  return new RelayService(
    address,
    credentials ?? grpc.credentials.createInsecure(),
    options,
  );
}

/**
 * Create a gRPC health client (convenience wrapper).
 * Returns a promise for the health response.
 */
export function checkHealth(
  address: string,
  credentials?: grpc.ChannelCredentials,
): Promise<{ status: string }> {
  const client = createRelayClient(address, credentials);
  return new Promise((resolve, reject) => {
    client.health({}, (err: Error | null, response: { status: string }) => {
      client.close();
      if (err) reject(err);
      else resolve(response);
    });
  });
}
