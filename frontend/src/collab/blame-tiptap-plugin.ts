/**
 * ProseMirror/Tiptap blame view plugin.
 *
 * Renders inline decorations with author color backgrounds. Uses the
 * shared pm-position-map helper to project Y.Text-offset segments onto
 * ProseMirror positions correctly for Markdown, HTML, and plain text.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { BlameSegment } from './blame-engine.js';
import { BlameEngine } from './blame-engine.js';
import { buildPositionMap, snapRange } from './pm-position-map.js';
import type { FormattingOverride } from './pm-position-map.js';
import type * as Y from 'yjs';

export const blamePluginKey = new PluginKey('blame');

/**
 * Meta payload accepted by the plugin. Callers either pass a plain
 * segment array (legacy), or a structured payload with Y.Text access
 * needed for formatting-authorship overrides.
 */
export type BlameMeta =
  | BlameSegment[]
  | null
  | {
      segments: BlameSegment[];
      overrides?: FormattingOverride[];
      ytext?: Y.Text;
    };

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
        const meta = tr.getMeta(blamePluginKey) as BlameMeta | undefined;
        if (meta !== undefined) {
          if (meta === null) return DecorationSet.empty;
          if (Array.isArray(meta)) {
            if (meta.length === 0) return DecorationSet.empty;
            return createDecorations(tr.doc, meta, [], undefined);
          }
          if (!meta.segments || meta.segments.length === 0) {
            return meta.overrides && meta.overrides.length > 0
              ? createDecorations(tr.doc, [], meta.overrides, meta.ytext)
              : DecorationSet.empty;
          }
          return createDecorations(tr.doc, meta.segments, meta.overrides ?? [], meta.ytext);
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
 * Build a DecorationSet from blame segments and optional formatting
 * authorship overrides. Base segments paint every char per the CRDT
 * clientID that authored it; overrides layer on top to credit the
 * formatter of a mark when one user wrapped another user's text.
 */
function createDecorations(
  doc: any,
  segments: BlameSegment[],
  overrides: FormattingOverride[],
  ytext: Y.Text | undefined,
): DecorationSet {
  const decorations: Decoration[] = [];

  // The shared helper needs Y.Text content to know what's source vs
  // rendered. When callers didn't pass the Y.Text handle (legacy call
  // sites), derive the "source" from the PM text — this degrades to
  // the previous behavior for plain-text content handlers and avoids
  // crashing on Markdown/HTML docs where segment ranges may not snap
  // perfectly.
  const yTextStr = ytext ? ytext.toString() : pmToString(doc);
  const posMap = buildPositionMap(doc, yTextStr);

  for (const seg of segments) {
    const snapped = snapRange(seg.start, seg.end, posMap);
    if (snapped.from === undefined || snapped.to === undefined) continue;
    if (snapped.from >= snapped.to) continue;

    const color = BlameEngine.assignColor(seg.userName);

    decorations.push(
      Decoration.inline(snapped.from, snapped.to, {
        style: `background-color: ${color}20; border-bottom: 2px solid ${color};`,
        'data-blame-user': seg.userName,
        title: seg.userName,
      }),
    );
  }

  // Layer formatting-authorship overrides on top. A later decoration
  // with the same range wins in PM rendering, so the credit goes to
  // the formatter for the visible text while the tooltip preserves
  // the original author for hover.
  for (const ov of overrides) {
    if (ov.from >= ov.to) continue;
    const color = BlameEngine.assignColor(ov.delimiterUser);
    decorations.push(
      Decoration.inline(ov.from, ov.to, {
        style: `background-color: ${color}30; border-bottom: 2px dashed ${color};`,
        'data-blame-user': ov.delimiterUser,
        'data-blame-text-user': ov.textUser,
        title: `text by ${ov.textUser}, formatted by ${ov.delimiterUser}`,
      }),
    );
  }

  return DecorationSet.create(doc, decorations);
}

/** Serialize PM doc to plain text as a fallback when Y.Text isn't supplied. */
function pmToString(doc: any): string {
  const parts: string[] = [];
  doc.descendants((node: any) => {
    if (node.isText) {
      parts.push(node.text ?? '');
      return false;
    }
    if (node.isBlock && node !== doc && parts.length > 0) {
      parts.push('\n');
    }
    return true;
  });
  return parts.join('');
}
