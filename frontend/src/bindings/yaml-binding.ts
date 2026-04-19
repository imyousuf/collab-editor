import { SourceOnlyBinding } from './source-only-binding.js';

export class YamlBinding extends SourceOnlyBinding {
  constructor() { super('markdown'); } // Markdown mode works for YAML
}
