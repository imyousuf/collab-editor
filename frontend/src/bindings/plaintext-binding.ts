import { SourceOnlyBinding } from './source-only-binding.js';

export class PlainTextBinding extends SourceOnlyBinding {
  constructor() { super('markdown'); } // No specific grammar
}
