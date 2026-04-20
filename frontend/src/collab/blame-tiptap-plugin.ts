/**
 * ProseMirror/Tiptap blame view plugin.
 *
 * Renders inline decorations with author color backgrounds.
 * Maps character offsets from BlameSegment to ProseMirror positions.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { BlameSegment } from './blame-engine.js';
import { BlameEngine } from './blame-engine.js';

export const blamePluginKey = new PluginKey('blame');

/**
 * Create a ProseMirror plugin that renders blame decorations.
 */
export function createBlamePlugin(): Plugin {
  return new Plugin({
    key: blamePluginKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, oldSet) {
        const meta = tr.getMeta(blamePluginKey);
        if (meta !== undefined) {
          if (meta === null || (Array.isArray(meta) && meta.length === 0)) {
            return DecorationSet.empty;
          }
          return createDecorations(tr.doc, meta as BlameSegment[]);
        }
        // Map existing decorations through document changes
        if (tr.docChanged) {
          return oldSet.map(tr.mapping, tr.doc);
        }
        return oldSet;
      },
    },
    props: {
      decorations(state) {
        return blamePluginKey.getState(state) as DecorationSet;
      },
    },
  });
}

/**
 * Build a DecorationSet from blame segments.
 *
 * Maps character offsets to ProseMirror positions.
 * ProseMirror adds 1 for the doc node and 1 for each block node,
 * so positions don't map 1:1 with character offsets.
 */
function createDecorations(doc: any, segments: BlameSegment[]): DecorationSet {
  const decorations: Decoration[] = [];

  // Build a character offset -> PM position mapping by walking the doc
  const posMap = buildPositionMap(doc);

  for (const seg of segments) {
    const from = posMap.get(seg.start);
    const to = posMap.get(seg.end);
    if (from === undefined || to === undefined) continue;
    if (from >= to) continue;

    const color = BlameEngine.assignColor(seg.userName);

    decorations.push(
      Decoration.inline(from, to, {
        style: `background-color: ${color}20; border-bottom: 2px solid ${color};`,
        'data-blame-user': seg.userName,
        title: seg.userName,
      }),
    );
  }

  return DecorationSet.create(doc, decorations);
}

/**
 * Build a map from character offset (0-based) to ProseMirror position.
 *
 * Walks the ProseMirror document and records the PM position for each
 * character offset in the plain text representation.
 */
function buildPositionMap(doc: any): Map<number, number> {
  const map = new Map<number, number>();
  let charOffset = 0;

  doc.descendants((node: any, pos: number) => {
    if (node.isText) {
      for (let i = 0; i < node.text!.length; i++) {
        map.set(charOffset + i, pos + i);
      }
      charOffset += node.text!.length;
      return false; // don't descend into text nodes
    }

    if (node.isBlock && node !== doc && charOffset > 0) {
      // Block boundaries map to newline characters in plain text
      map.set(charOffset, pos);
      charOffset++; // account for the \n between blocks
    }

    return true; // descend into non-text nodes
  });

  // Map the end position
  map.set(charOffset, doc.content.size);

  return map;
}
