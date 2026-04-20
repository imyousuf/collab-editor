/** SPI request/response types matching the relay's JSON payloads */

export interface UpdatePayload {
  sequence: number;
  data: string; // base64-encoded y-websocket binary
  client_id: number;
  created_at?: string;
}

export interface LoadResponse {
  content: string;
  mime_type: string;
  updates?: UpdatePayload[];
  snapshot?: SnapshotPayload;
  metadata?: DocumentMetadata;
}

export interface SnapshotPayload {
  data: string;
  state_vector: string;
  created_at: string;
  update_count: number;
}

export interface DocumentMetadata {
  format?: string;
  language?: string;
  created_by?: string;
  permissions?: string;
}

export interface StoreRequest {
  updates: UpdatePayload[];
}

export interface StoreResponse {
  stored: number;
  duplicates_ignored?: number;
  failed?: FailedUpdate[];
}

export interface FailedUpdate {
  sequence: number;
  error: string;
}

export interface HealthResponse {
  status: string;
  storage?: string;
}

export interface DocumentListEntry {
  name: string;
  size: number;
  mime_type: string;
}

/** Result from the implementor's readContent method */
export interface ContentResult {
  content: string;
  mimeType: string;
}
