/**
 * TypeScript type definitions for the relay gRPC API.
 * These mirror the protobuf messages in relay.proto.
 */

/** Envelope for bidirectional streaming in JoinRoom. */
export interface RoomMessage {
  /** Set only on the first message from client to server (join handshake). */
  document_id?: string;
  /** Raw Yjs binary frame (sync, awareness, etc). */
  payload?: Uint8Array;
}

export interface HealthRequest {}

export interface HealthResponse {
  status: string;
}

/** gRPC service client type for RelayService. */
export interface RelayServiceClient {
  joinRoom(): RelayDuplexStream;
  health(
    request: HealthRequest,
    callback: (error: Error | null, response: HealthResponse) => void,
  ): void;
}

/** Bidirectional stream for JoinRoom. */
export interface RelayDuplexStream {
  write(message: RoomMessage): boolean;
  on(event: 'data', handler: (message: RoomMessage) => void): this;
  on(event: 'end', handler: () => void): this;
  on(event: 'error', handler: (err: Error) => void): this;
  on(event: 'status', handler: (status: { code: number; details: string }) => void): this;
  end(): void;
  cancel(): void;
}
