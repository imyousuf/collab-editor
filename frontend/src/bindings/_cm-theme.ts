/**
 * CodeMirror theme extension that reads --me-source-* CSS custom properties.
 * Placed after oneDark in the extensions array so structural properties
 * (bg, fonts, gutters) use variables while syntax highlighting from
 * oneDark remains intact.
 */
import { EditorView } from '@codemirror/view';

export const cssVarTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--me-source-bg)',
    color: 'var(--me-source-color)',
    fontFamily: 'var(--me-source-font-family)',
    fontSize: 'var(--me-source-font-size)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--me-source-gutter-bg)',
    color: 'var(--me-source-gutter-color)',
    borderRight: '1px solid var(--me-source-gutter-border)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--me-source-cursor-color)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--me-source-active-line-bg)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--me-source-selection-bg) !important',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'var(--me-source-matching-bracket-bg)',
  },
  '.cm-content': {
    lineHeight: 'var(--me-source-line-height)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--me-source-font-family)',
  },
});
