/**
 * Provider interface and SDK processor.
 *
 * Implementors write readContent() and writeContent().
 * The SDK handles Yjs diff application, state encoding, and text extraction.
 */
import type {
  ContentResult,
  LoadResponse,
  StoreResponse,
  UpdatePayload,
  HealthResponse,
  DocumentListEntry,
  VersionEntry,
  VersionListEntry,
  CreateVersionRequest,
  BlameSegment,
  ClientUserMapping,
} from './types.js';
import {
  applyBase64Update,
  createDocWithContent,
  extractText,
  DocCache,
} from './engine.js';

/**
 * Interface that storage backends implement.
 *
 * Two storage strategies supported (choose one or both):
 *
 * 1. **Resolved text mode**: Implement readContent() + writeContent().
 *    The SDK applies Yjs diffs and gives you the final text.
 *    Simple, but you lose granular update history.
 *
 * 2. **Raw updates mode**: Implement readContent() + storeRawUpdates() + loadRawUpdates().
 *    You store the raw Yjs binary yourself (append-only journal).
 *    On load, return them for replay. More efficient, preserves history.
 *
 * 3. **Both**: Implement all methods. The SDK calls writeContent() with resolved text
 *    AND storeRawUpdates() with the raw diffs. You get searchable text + efficient replay.
 */
export interface Provider {
  /** Read the current full text from your storage */
  readContent(documentId: string): Promise<ContentResult>;

  /** Write the resolved full text back to your storage (called after diffs are applied) */
  writeContent?(documentId: string, content: string, mimeType: string): Promise<void>;

  /** Store raw Yjs updates (base64) for later replay — append-only */
  storeRawUpdates?(documentId: string, updates: UpdatePayload[]): Promise<void>;

  /** Load previously stored raw Yjs updates for replay to new peers */
  loadRawUpdates?(documentId: string): Promise<UpdatePayload[]>;

  /** Optional: list available documents */
  listDocuments?(): Promise<DocumentListEntry[]>;

  /** Optional: custom health check */
  onHealth?(): Promise<HealthResponse>;

  /** Optional: list versions for a document */
  listVersions?(documentId: string): Promise<VersionListEntry[]>;

  /** Optional: create a new version snapshot */
  createVersion?(documentId: string, req: CreateVersionRequest): Promise<VersionListEntry>;

  /** Optional: get a full version with content and blame */
  getVersion?(documentId: string, versionId: string): Promise<VersionEntry | null>;

  /** Optional: get client-ID-to-user mappings for blame */
  getClientMappings?(documentId: string): Promise<ClientUserMapping[]>;

  /** Optional: store client-ID-to-user mappings */
  storeClientMappings?(documentId: string, mappings: ClientUserMapping[]): Promise<void>;
}

/** SDK processor — bridges Provider interface with the relay's SPI protocol */
export class ProviderProcessor {
  private _provider: Provider;
  private _cache: DocCache;

  constructor(provider: Provider, opts?: { cacheSize?: number }) {
    this._provider = provider;
    this._cache = new DocCache(opts?.cacheSize ?? 1000);
  }

  /** Process a load request from the relay */
  async processLoad(documentId: string): Promise<LoadResponse> {
    const { content, mimeType } = await this._provider.readContent(documentId);

    // Seed the cache so subsequent stores can apply diffs
    if (!this._cache.get(documentId)) {
      const doc = createDocWithContent(content);
      this._cache.set(documentId, doc);
    }

    return {
      content,
      mime_type: mimeType,
    };
  }

  /**
   * Process a store request from the relay.
   *
   * Always resolves content via the Y.Doc engine. The provider receives both
   * resolved content AND raw updates. Depending on what the provider implements:
   * - writeContent: called with the resolved text
   * - storeRawUpdates: called with the raw Yjs updates
   * - Both: provider gets resolved text AND raw updates
   */
  async processStore(documentId: string, updates: UpdatePayload[]): Promise<StoreResponse> {
    if (updates.length === 0) {
      return { stored: 0 };
    }

    // Always resolve content via Y.Doc engine
    let doc = this._cache.get(documentId);
    if (!doc) {
      const { content } = await this._provider.readContent(documentId);
      doc = createDocWithContent(content);
      this._cache.set(documentId, doc);
    }

    let applied = 0;
    for (const update of updates) {
      if (applyBase64Update(doc, update.data)) {
        applied++;
      }
    }

    const resolvedText = extractText(doc);
    const { mimeType } = await this._provider.readContent(documentId);

    // Store raw updates if provider supports it
    if (this._provider.storeRawUpdates) {
      await this._provider.storeRawUpdates(documentId, updates);
    }

    // Write resolved text if provider supports it
    if (this._provider.writeContent) {
      await this._provider.writeContent(documentId, resolvedText, mimeType);
    }

    return { stored: applied };
  }

  /** Process a health request */
  async processHealth(): Promise<HealthResponse> {
    if (this._provider.onHealth) {
      return this._provider.onHealth();
    }
    return { status: 'ok' };
  }

  /** Process a list request */
  async processList(): Promise<DocumentListEntry[]> {
    if (this._provider.listDocuments) {
      return this._provider.listDocuments();
    }
    return [];
  }

  /** Process a list versions request */
  async processListVersions(documentId: string): Promise<VersionListEntry[]> {
    if (this._provider.listVersions) {
      return this._provider.listVersions(documentId);
    }
    return [];
  }

  /** Process a create version request */
  async processCreateVersion(
    documentId: string,
    req: CreateVersionRequest,
  ): Promise<VersionListEntry | null> {
    if (this._provider.createVersion) {
      return this._provider.createVersion(documentId, req);
    }
    return null;
  }

  /** Process a get version request. Auto-computes blame if not populated. */
  async processGetVersion(
    documentId: string,
    versionId: string,
  ): Promise<VersionEntry | null> {
    if (!this._provider.getVersion) {
      return null;
    }
    const entry = await this._provider.getVersion(documentId, versionId);
    if (!entry) return null;

    // Auto-compute blame from version history if not populated
    if (
      (!entry.blame || entry.blame.length === 0) &&
      this._provider.listVersions &&
      this._provider.getVersion
    ) {
      const allVersions = await this._provider.listVersions(documentId);
      // Find versions up to and including the requested one (use Date for correct timezone handling)
      const entryTime = new Date(entry.created_at!).getTime();
      const sorted = allVersions
        .filter((v) => new Date(v.created_at).getTime() <= entryTime)
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      if (sorted.length > 0) {
        // Fetch full content for each version in the chain
        const fullVersions: VersionEntry[] = [];
        for (const v of sorted) {
          const full = await this._provider.getVersion(documentId, v.id);
          if (full) fullVersions.push(full);
        }
        if (fullVersions.length > 0) {
          const { computeBlameFromVersions } = await import('./blame.js');
          entry.blame = computeBlameFromVersions(fullVersions);
        }
      }
    }

    return entry;
  }

  /** Process a get client mappings request */
  async processGetClientMappings(documentId: string): Promise<ClientUserMapping[]> {
    if (this._provider.getClientMappings) {
      return this._provider.getClientMappings(documentId);
    }
    return [];
  }

  /** Process a store client mappings request */
  async processStoreClientMappings(
    documentId: string,
    mappings: ClientUserMapping[],
  ): Promise<void> {
    if (this._provider.storeClientMappings) {
      await this._provider.storeClientMappings(documentId, mappings);
    }
  }

  /** Clear the Y.Doc cache (for testing or shutdown) */
  clearCache(): void {
    this._cache.clear();
  }
}
