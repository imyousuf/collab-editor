/**
 * CodeMirror 6 blame view extension.
 *
 * Provides blame gutter and line decorations for the source editor.
 * Uses a Compartment for dynamic enable/disable.
 */

import {
  type Extension,
  StateField,
  StateEffect,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  gutter,
  GutterMarker,
  WidgetType,
} from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import type { BlameSegment } from './blame-engine.js';
import { BlameEngine } from './blame-engine.js';

/** Effect to push new blame segments into the editor state. */
export const setBlameData = StateEffect.define<BlameSegment[]>();

/** State field tracking the current blame decorations. */
export const blameDecorationField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBlameData)) {
        return buildLineDecorations(tr.state.doc, effect.value);
      }
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** State field tracking the blame segments (for gutter access). */
export const blameSegmentsField = StateField.define<BlameSegment[]>({
  create() {
    return [];
  },
  update(segments, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBlameData)) {
        return effect.value;
      }
    }
    return segments;
  },
});

/** Gutter marker showing the author name with a color bar. */
class BlameGutterWidget extends GutterMarker {
  constructor(
    private userName: string,
    private color: string,
  ) {
    super();
  }

  toDOM(): Node {
    const el = document.createElement('div');
    el.className = 'cm-blame-gutter-entry';
    el.style.borderLeft = `3px solid ${this.color}`;
    el.style.paddingLeft = '4px';
    el.style.fontSize = '11px';
    el.style.lineHeight = '1.4';
    el.style.color = 'var(--me-source-gutter-color, #6e7681)';
    el.style.whiteSpace = 'nowrap';
    el.style.overflow = 'hidden';
    el.style.textOverflow = 'ellipsis';
    el.style.maxWidth = '120px';
    el.textContent = this.userName;
    el.title = this.userName;
    return el;
  }
}

/** Spacer marker to set initial gutter width. */
class BlameSpacerMarker extends GutterMarker {
  toDOM(): Node {
    const el = document.createElement('div');
    el.style.width = '120px';
    return el;
  }
}

/** Blame gutter extension. */
export const blameGutter = gutter({
  class: 'cm-blame-gutter',
  lineMarker(view, line) {
    const segments = view.state.field(blameSegmentsField, false);
    if (!segments || segments.length === 0) return null;

    const lineStart = line.from;
    // Find the blame segment that covers this line
    for (const seg of segments) {
      if (seg.start <= lineStart && lineStart < seg.end) {
        const color = BlameEngine.assignColor(seg.userName);
        return new BlameGutterWidget(seg.userName, color);
      }
    }
    return null;
  },
  lineMarkerChange(update) {
    return update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(setBlameData)),
    );
  },
  initialSpacer: () => new BlameSpacerMarker(),
});

/** Theme for blame decorations. */
export const blameTheme = EditorView.baseTheme({
  '.cm-blame-gutter': {
    width: '130px',
    borderRight: '1px solid var(--me-source-gutter-border, #d0d7de)',
  },
});

/** Build line decorations from blame segments. */
function buildLineDecorations(doc: any, segments: BlameSegment[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  // RangeSetBuilder requires ranges added in ascending from-position order
  const sorted = [...segments].sort((a, b) => a.start - b.start);

  for (const seg of sorted) {
    // Find lines that overlap with this segment
    const startLine = doc.lineAt(Math.min(seg.start, doc.length));
    const endPos = Math.min(seg.end, doc.length);
    const endLine = endPos > 0 ? doc.lineAt(Math.max(0, endPos - 1)) : startLine;
    const color = BlameEngine.assignColor(seg.userName);

    for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
      const line = doc.line(lineNum);
      builder.add(
        line.from,
        line.from,
        Decoration.line({
          attributes: {
            style: `background-color: ${color}15; border-left: 3px solid ${color};`,
          },
        }),
      );
    }
  }

  return builder.finish();
}

/** Factory function returning all blame extensions. */
export function createBlameExtensions(): Extension[] {
  return [blameSegmentsField, blameDecorationField, blameGutter, blameTheme];
}
