import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { CollaborationConfig } from '../types.js';

export class CollabProvider {
  readonly ydoc: Y.Doc;
  readonly content: Y.XmlFragment;
  readonly sourceText: Y.Text;
  readonly meta: Y.Map<string>;
  readonly frontmatter: Y.Map<string>;

  provider: WebsocketProvider | null = null;

  constructor() {
    this.ydoc = new Y.Doc();
    this.content = this.ydoc.getXmlFragment('content');
    this.sourceText = this.ydoc.getText('source');
    this.meta = this.ydoc.getMap('meta');
    this.frontmatter = this.ydoc.getMap('frontmatter');
  }

  connect(config: CollaborationConfig): void {
    this.disconnect();
    this.provider = new WebsocketProvider(
      config.providerUrl,
      config.roomName,
      this.ydoc,
    );
    this.provider.awareness.setLocalStateField('user', config.user);
  }

  disconnect(): void {
    if (this.provider) {
      this.provider.disconnect();
      this.provider.destroy();
      this.provider = null;
    }
  }

  get awareness() {
    return this.provider?.awareness ?? null;
  }

  get connected(): boolean {
    return this.provider?.wsconnected ?? false;
  }

  destroy(): void {
    this.disconnect();
    this.ydoc.destroy();
  }
}
