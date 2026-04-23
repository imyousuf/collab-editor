/**
 * Shared helpers for projecting Y.Text character offsets onto
 * ProseMirror positions, and for detecting "formatting authorship"
 * overrides where one user wrapped another user's text in a mark.
 *
 * Y.Text stores *source* (Markdown or HTML), ProseMirror stores the
 * parsed structure. Syntax characters like `#`, `**`, `<p>`, `<strong>`
 * do not appear in PM text nodes. A naive 1:1 offset map (which is what
 * blame-tiptap-plugin.ts and comment-tiptap-plugin.ts used to ship)
 * therefore mis-attributes decorations — sometimes by a few characters,
 * sometimes by a full block after the accumulated shift from a
 * `\n\n` block separator that the old map undercounted.
 *
 * This module replaces that with a substring walker: for each PM text
 * node in document order we find its content as a literal substring of
 * Y.Text starting from a running cursor. The PM text tree is always a
 * set of literal substrings of Y.Text for Markdown/HTML/plain-text
 * content handlers, so the walk is well-defined without parsing
 * the source.
 */

import type * as Y from 'yjs';

/**
 * Build a map from Y.Text character offset → ProseMirror position,
 * for every character that is *visible* in the PM doc.
 *
 * Syntax characters in Y.Text that don't appear in PM text nodes are
 * intentionally absent from the map; callers should snap to nearby
 * mapped offsets (see {@link snapRange}).
 */
export function buildPositionMap(
  doc: any,
  yText: string,
): Map<number, number> {
  const map = new Map<number, number>();
  let cursor = 0;
  doc.descendants((node: any, pos: number) => {
    if (node.isText) {
      const text: string = node.text ?? '';
      if (text.length === 0) return false;
      const idx = yText.indexOf(text, cursor);
      if (idx < 0) {
        // PM text isn't a literal substring of Y.Text from `cursor`
        // onward — happens when the content handler normalizes (HTML
        // whitespace collapse, entity decoding). Skip this node so we
        // don't emit wrong decorations, and resume matching from the
        // old cursor so later siblings still have a chance.
        return false;
      }
      for (let i = 0; i < text.length; i++) {
        map.set(idx + i, pos + i);
      }
      cursor = idx + text.length;
      return false;
    }
    return true;
  });
  return map;
}

/**
 * Snap a half-open range `[start, end)` in Y.Text offset space onto PM
 * positions. `start` snaps forward to the next mapped offset; `end`
 * snaps backward to the previous mapped offset plus one (so the
 * decoration covers the last visible character inside the range).
 *
 * Returns `undefined` fields when no mapped offset is reachable — the
 * caller must skip such segments rather than render them at a wrong
 * position.
 */
export function snapRange(
  start: number,
  end: number,
  map: Map<number, number>,
): { from?: number; to?: number } {
  if (end <= start) return {};
  if (map.size === 0) return {};

  // Snap start FORWARD.
  let fromKey = start;
  let fromPos: number | undefined = map.get(fromKey);
  if (fromPos === undefined) {
    // Find the smallest mapped key >= start that is still < end.
    const keys = sortedKeys(map);
    for (const k of keys) {
      if (k < start) continue;
      if (k >= end) break;
      fromKey = k;
      fromPos = map.get(k)!;
      break;
    }
  }
  if (fromPos === undefined) return {};

  // Snap end BACKWARD to include the last visible char strictly inside
  // the range. The PM decoration endpoint is EXCLUSIVE, so we want
  // `map[lastVisibleOffset] + 1`.
  let lastKey = end - 1;
  let lastPos: number | undefined = map.get(lastKey);
  if (lastPos === undefined) {
    const keys = sortedKeys(map);
    for (let i = keys.length - 1; i >= 0; i--) {
      const k = keys[i];
      if (k > end - 1) continue;
      if (k < fromKey) break;
      lastKey = k;
      lastPos = map.get(k)!;
      break;
    }
  }
  if (lastPos === undefined) return {};

  return { from: fromPos, to: lastPos + 1 };
}

/** Cached, sorted-ascending keys of a Map<number, any>. */
const _cachedSortedKeys = new WeakMap<Map<number, number>, number[]>();
function sortedKeys(map: Map<number, number>): number[] {
  const existing = _cachedSortedKeys.get(map);
  if (existing && existing.length === map.size) return existing;
  const keys: number[] = [];
  map.forEach((_, k) => keys.push(k));
  keys.sort((a, b) => a - b);
  _cachedSortedKeys.set(map, keys);
  return keys;
}

// --- Formatting-authorship override ---

/** A Markdown/HTML delimiter pattern understood by the override detector. */
export interface DelimiterPattern {
  /** Which PM mark this pattern creates (e.g., `strong`, `em`, `code`, `strike`). */
  mark: string;
  /** The exact string a client would have inserted to open the mark. */
  open: string;
  /** The exact string a client would have inserted to close the mark. */
  close: string;
}

/**
 * Default delimiter registry. Mark names match Tiptap's StarterKit
 * extension names (`bold`, `italic`, `code`, `strike`) — which differ
 * from ProseMirror's HTML-inspired names (`strong`, `em`, ...). We
 * include both so the registry works against other Tiptap setups too.
 */
export const DEFAULT_DELIMITERS: DelimiterPattern[] = [
  // Bold — Tiptap's StarterKit mark name is `bold`.
  { mark: 'bold', open: '**', close: '**' },
  { mark: 'bold', open: '__', close: '__' },
  { mark: 'bold', open: '<strong>', close: '</strong>' },
  { mark: 'bold', open: '<b>', close: '</b>' },
  // Italic — StarterKit mark `italic`.
  { mark: 'italic', open: '*', close: '*' },
  { mark: 'italic', open: '_', close: '_' },
  { mark: 'italic', open: '<em>', close: '</em>' },
  { mark: 'italic', open: '<i>', close: '</i>' },
  // Strike — StarterKit mark `strike`.
  { mark: 'strike', open: '~~', close: '~~' },
  { mark: 'strike', open: '<s>', close: '</s>' },
  { mark: 'strike', open: '<del>', close: '</del>' },
  // Code (inline).
  { mark: 'code', open: '`', close: '`' },
  { mark: 'code', open: '<code>', close: '</code>' },
  // ProseMirror canonical names — kept for non-Tiptap consumers.
  { mark: 'strong', open: '**', close: '**' },
  { mark: 'strong', open: '<strong>', close: '</strong>' },
  { mark: 'em', open: '*', close: '*' },
  { mark: 'em', open: '<em>', close: '</em>' },
  { mark: 's', open: '~~', close: '~~' },
  { mark: 's', open: '<s>', close: '</s>' },
];

/** Result of detecting a pure-formatting edit on a mark range. */
export interface FormattingOverride {
  /** PM `from` position of the inner text. */
  from: number;
  /** PM `to` position (exclusive) of the inner text. */
  to: number;
  /** Name of the user who added the delimiters (the formatter). */
  delimiterUser: string;
  /** Name of the user who originally typed the inner text. */
  textUser: string;
}

/**
 * Walk the PM doc and detect ranges where one user wrapped another
 * user's text in a mark, so the blame plugin can credit the formatter
 * for the visible text.
 *
 * Returns an empty array when the user-resolution callback is missing,
 * or when no qualifying override was found.
 */
export function findFormattingOverrides(
  doc: any,
  ytext: Y.Text,
  clientToUser: Map<number, string>,
  patterns: DelimiterPattern[] = DEFAULT_DELIMITERS,
): FormattingOverride[] {
  const overrides: FormattingOverride[] = [];
  const yTextStr = ytext.toString();
  const posMap = buildPositionMap(doc, yTextStr);

  // Group delimiter patterns by mark name for O(1) lookup per text node.
  const patternsByMark = new Map<string, DelimiterPattern[]>();
  for (const p of patterns) {
    const list = patternsByMark.get(p.mark) ?? [];
    list.push(p);
    patternsByMark.set(p.mark, list);
  }

  doc.descendants((node: any, pos: number) => {
    if (!node.isText) return true;
    const text: string = node.text ?? '';
    if (text.length === 0) return false;
    if (!node.marks || node.marks.length === 0) return false;

    // Find the Y.Text offset of this text node. `indexOf` starting from
    // any position that already mapped it (map has pos+0) — but we
    // re-derive it quickly from the posMap above.
    const startOffset = findYTextStartForPMPos(posMap, pos);
    if (startOffset === undefined) return false;
    const endOffset = startOffset + text.length;

    for (const mark of node.marks) {
      const candidates = patternsByMark.get(mark.type?.name ?? mark.type);
      if (!candidates) continue;

      for (const { open, close } of candidates) {
        // Check that Y.Text has the expected delimiters immediately
        // before/after the text node's offset range.
        const openStart = startOffset - open.length;
        const closeStart = endOffset;
        if (openStart < 0) continue;
        if (yTextStr.substring(openStart, startOffset) !== open) continue;
        if (yTextStr.substring(closeStart, closeStart + close.length) !== close) continue;

        // Collect clients for the OPENING and CLOSING delimiter runs
        // SEPARATELY from the inner text. Using the full [openStart,
        // closeStart+close.length) range would mix the inner text's
        // client into the delimiter set and the override never fires.
        const openClients = collectClientsInRange(ytext, openStart, startOffset);
        const closeClients = collectClientsInRange(
          ytext,
          closeStart,
          closeStart + close.length,
        );
        const delimClients = new Set<number>();
        for (const c of openClients) delimClients.add(c);
        for (const c of closeClients) delimClients.add(c);
        const textClients = collectClientsInRange(ytext, startOffset, endOffset);

        // Pure formatting action: delimiters are all one client AND
        // inner text is all one *different* client.
        if (delimClients.size !== 1 || textClients.size !== 1) continue;
        const delimClient = delimClients.values().next().value!;
        const textClient = textClients.values().next().value!;
        if (delimClient === textClient) continue;

        // Convert clients to user names; skip if either is unresolvable.
        const delimUser = clientToUser.get(delimClient);
        const textUser = clientToUser.get(textClient);
        if (!delimUser || !textUser || delimUser === textUser) continue;

        // Map inner range back to PM positions.
        const snapped = snapRange(startOffset, endOffset, posMap);
        if (snapped.from === undefined || snapped.to === undefined) continue;

        overrides.push({
          from: snapped.from,
          to: snapped.to,
          delimiterUser: delimUser,
          textUser: textUser,
        });
        // First matching delimiter pattern wins; stop scanning others.
        break;
      }
    }
    return false;
  });

  return overrides;
}

/**
 * Find the Y.Text offset for the PM text node starting at `pmPos`.
 * We scan the posMap for the first entry whose value equals `pmPos`.
 * O(N) where N is doc length; acceptable because we only call it once
 * per marked text node.
 */
function findYTextStartForPMPos(
  posMap: Map<number, number>,
  pmPos: number,
): number | undefined {
  for (const [yOffset, mappedPos] of posMap.entries()) {
    if (mappedPos === pmPos) return yOffset;
  }
  return undefined;
}

/**
 * Walk the Y.Text item chain and collect the set of client IDs that
 * own at least one character in the Y.Text offset range `[start, end)`.
 */
export function collectClientsInRange(
  ytext: Y.Text,
  start: number,
  end: number,
): Set<number> {
  const clients = new Set<number>();
  let item = (ytext as any)._start;
  let offset = 0;
  while (item !== null) {
    if (!item.deleted && item.content) {
      const len = item.content.getLength();
      const itemStart = offset;
      const itemEnd = offset + len;
      // Overlap test.
      if (itemStart < end && itemEnd > start) {
        clients.add(item.id.client);
      }
      offset += len;
    }
    item = item.right;
  }
  return clients;
}
