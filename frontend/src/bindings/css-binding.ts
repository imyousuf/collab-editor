import { SourceOnlyBinding } from './source-only-binding.js';

export class CssBinding extends SourceOnlyBinding {
  constructor() { super('html'); } // CodeMirror html() includes CSS support
}
