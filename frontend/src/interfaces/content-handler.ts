/**
 * Content type hint for the editor.
 * - 'markdown': content is raw markdown text
 * - 'html': content is raw HTML
 * - 'text': content is plain text (code, config, etc.)
 */
export interface EditorContent {
  type: 'markdown' | 'html' | 'text';
  content: string;
}

/**
 * Converts between plain text (stored in Y.Text) and the editor's format.
 *
 * For source editors, parse/serialize are identity transforms.
 * For WYSIWYG editors, they handle markdown↔Tiptap or html↔Tiptap conversion.
 */
export interface IContentHandler {
  /** MIME types this handler supports */
  readonly supportedMimeTypes: readonly string[];

  /**
   * Parse a plain text string into the format the editor needs.
   * Returns a typed EditorContent indicating the content type.
   */
  parse(text: string): EditorContent;

  /**
   * Serialize editor output back to plain text for Y.Text storage.
   */
  serialize(editorOutput: string): string;
}
