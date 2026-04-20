/**
 * Line-level diff engine for comparing two version content strings.
 *
 * Uses the LCS (Longest Common Subsequence) algorithm.
 * No external dependencies.
 */

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * Compute a line-by-line diff between two text strings.
 *
 * @param oldText - The original text
 * @param newText - The new text
 * @returns Array of DiffLine entries
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  const lcs = computeLCS(oldLines, newLines);

  const result: DiffLine[] = [];
  let oi = 0;
  let ni = 0;

  for (const [oldIdx, newIdx] of lcs) {
    // Emit removed lines before this match
    while (oi < oldIdx) {
      result.push({
        type: 'removed',
        content: oldLines[oi],
        oldLineNumber: oi + 1,
      });
      oi++;
    }

    // Emit added lines before this match
    while (ni < newIdx) {
      result.push({
        type: 'added',
        content: newLines[ni],
        newLineNumber: ni + 1,
      });
      ni++;
    }

    // Emit the matched (unchanged) line
    result.push({
      type: 'unchanged',
      content: oldLines[oi],
      oldLineNumber: oi + 1,
      newLineNumber: ni + 1,
    });
    oi++;
    ni++;
  }

  // Trailing removed lines
  while (oi < oldLines.length) {
    result.push({
      type: 'removed',
      content: oldLines[oi],
      oldLineNumber: oi + 1,
    });
    oi++;
  }

  // Trailing added lines
  while (ni < newLines.length) {
    result.push({
      type: 'added',
      content: newLines[ni],
      newLineNumber: ni + 1,
    });
    ni++;
  }

  return result;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n');
}

/** Compute LCS indices. Returns pairs of [oldIdx, newIdx]. */
function computeLCS(a: string[], b: string[]): [number, number][] {
  const m = a.length;
  const n = b.length;

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
