/**
 * Blame computation from version history.
 *
 * Computes per-character blame segments by diffing consecutive version contents.
 * No Yjs knowledge needed — operates purely on plain text strings.
 */

import type { VersionEntry, BlameSegment } from './types.js';

/**
 * Compute blame segments for the last version in a chronologically sorted chain.
 *
 * Algorithm:
 * 1. Version 0: all content attributed to version[0].creator
 * 2. For each subsequent version: diff previous vs current content
 * 3. New/modified lines attributed to that version's creator
 * 4. Unchanged lines retain prior attribution
 *
 * @param versions - Versions sorted chronologically (oldest first), each with content
 * @returns Blame segments for the final version's content
 */
export function computeBlameFromVersions(versions: VersionEntry[]): BlameSegment[] {
  if (versions.length === 0) return [];

  // Start: attribute all of first version to its creator
  let lineAuthors: string[] = [];
  const firstContent = versions[0].content ?? '';
  const firstCreator = versions[0].creator ?? 'unknown';
  const firstLines = splitLines(firstContent);
  lineAuthors = firstLines.map(() => firstCreator);

  // Walk through subsequent versions
  for (let i = 1; i < versions.length; i++) {
    const prevContent = versions[i - 1].content ?? '';
    const currContent = versions[i].content ?? '';
    const creator = versions[i].creator ?? 'unknown';

    const prevLines = splitLines(prevContent);
    const currLines = splitLines(currContent);

    lineAuthors = applyDiffAttribution(prevLines, currLines, lineAuthors, creator);
  }

  // Convert per-line attribution to character-offset segments
  const finalContent = versions[versions.length - 1].content ?? '';
  return linesToSegments(splitLines(finalContent), lineAuthors);
}

/** Split text into lines, preserving empty trailing line if present */
function splitLines(text: string): string[] {
  if (text === '') return [''];
  return text.split('\n');
}

/**
 * Apply diff attribution: compare old and new line arrays,
 * attributing changed/new lines to the creator, keeping unchanged.
 */
function applyDiffAttribution(
  oldLines: string[],
  newLines: string[],
  oldAuthors: string[],
  creator: string,
): string[] {
  const lcs = computeLCS(oldLines, newLines);
  const newAuthors: string[] = new Array(newLines.length).fill(creator);

  // Walk through LCS matches — matched lines keep their old attribution
  let oi = 0;
  let ni = 0;
  for (const [oldIdx, newIdx] of lcs) {
    // Lines between previous match and this match in newLines are new → creator
    // The matched line retains old author
    newAuthors[newIdx] = oldAuthors[oldIdx] ?? creator;
    oi = oldIdx + 1;
    ni = newIdx + 1;
  }

  return newAuthors;
}

/** Compute LCS indices between two string arrays. Returns pairs of [oldIdx, newIdx]. */
function computeLCS(a: string[], b: string[]): [number, number][] {
  const m = a.length;
  const n = b.length;

  // DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find pairs
  const result: [number, number][] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result.reverse();
}

/** Convert per-line authors to character-offset BlameSegments */
function linesToSegments(lines: string[], authors: string[]): BlameSegment[] {
  const segments: BlameSegment[] = [];
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length + (i < lines.length - 1 ? 1 : 0); // +1 for \n
    if (lineLen === 0) continue;

    const author = authors[i] ?? 'unknown';
    const last = segments[segments.length - 1];

    if (last && last.user_name === author && last.end === offset) {
      last.end += lineLen;
    } else {
      segments.push({ start: offset, end: offset + lineLen, user_name: author });
    }

    offset += lineLen;
  }

  return segments;
}
