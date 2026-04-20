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

// --- Version History ---

/** Full version record with content and blame. Returned by getVersion(). */
export interface VersionEntry {
  id: string;
  created_at: string;
  type: 'auto' | 'manual';
  label?: string;
  creator?: string;
  content: string;
  mime_type?: string;
  blame?: BlameSegment[];
}

/** Lightweight version summary for list responses. No content or blame. */
export interface VersionListEntry {
  id: string;
  created_at: string;
  type: 'auto' | 'manual';
  label?: string;
  creator?: string;
  mime_type?: string;
}

/** Attributes a character range to a user. Color is NOT included — frontend assigns. */
export interface BlameSegment {
  start: number;
  end: number;
  user_name: string;
}

/** Request body for creating a new version. */
export interface CreateVersionRequest {
  content: string;
  mime_type?: string;
  label?: string;
  creator?: string;
  type?: 'auto' | 'manual';
  blame?: BlameSegment[];
}

// --- Client User Mappings ---

/** Maps a Yjs client ID to a user identity for blame attribution. */
export interface ClientUserMapping {
  client_id: number;
  user_name: string;
}
