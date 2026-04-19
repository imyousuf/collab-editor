import { SourceOnlyBinding } from './source-only-binding.js';

export class JsonBinding extends SourceOnlyBinding {
  constructor() { super('javascript'); } // JSON is a subset of JS
}
