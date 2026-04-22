"""Blame computation from version history.

Computes per-character blame segments by diffing consecutive version contents.
No Yjs knowledge needed -- operates purely on plain text strings.
"""

from __future__ import annotations

from .types import BlameSegment, VersionEntry


def compute_blame_from_versions(versions: list[VersionEntry]) -> list[BlameSegment]:
    """Compute blame segments for the last version in a chronologically sorted chain.

    Algorithm:
    1. Version 0: all content attributed to version[0].creator
    2. For each subsequent version: diff previous vs current content
    3. New/modified lines attributed to that version's creator
    4. Unchanged lines retain prior attribution

    Args:
        versions: Versions sorted chronologically (oldest first), each with content.

    Returns:
        Blame segments for the final version's content.
    """
    if not versions:
        return []

    first_content = versions[0].content or ""
    first_creator = versions[0].creator or "unknown"
    first_lines = _split_lines(first_content)
    line_authors = [first_creator] * len(first_lines)

    for i in range(1, len(versions)):
        prev_content = versions[i - 1].content or ""
        curr_content = versions[i].content or ""
        creator = versions[i].creator or "unknown"

        prev_lines = _split_lines(prev_content)
        curr_lines = _split_lines(curr_content)

        line_authors = _apply_diff_attribution(
            prev_lines, curr_lines, line_authors, creator
        )

    final_content = versions[-1].content or ""
    return _lines_to_segments(_split_lines(final_content), line_authors)


def _split_lines(text: str) -> list[str]:
    if text == "":
        return [""]
    return text.split("\n")


def _apply_diff_attribution(
    old_lines: list[str],
    new_lines: list[str],
    old_authors: list[str],
    creator: str,
) -> list[str]:
    lcs = _compute_lcs(old_lines, new_lines)
    new_authors = [creator] * len(new_lines)

    for old_idx, new_idx in lcs:
        if old_idx < len(old_authors):
            new_authors[new_idx] = old_authors[old_idx]
        else:
            new_authors[new_idx] = creator

    return new_authors


def _compute_lcs(a: list[str], b: list[str]) -> list[tuple[int, int]]:
    """Compute LCS indices between two string lists. Returns (old_idx, new_idx) pairs."""
    m, n = len(a), len(b)
    dp = [[0] * (n + 1) for _ in range(m + 1)]

    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if a[i - 1] == b[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
            else:
                dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])

    result: list[tuple[int, int]] = []
    i, j = m, n
    while i > 0 and j > 0:
        if a[i - 1] == b[j - 1]:
            result.append((i - 1, j - 1))
            i -= 1
            j -= 1
        elif dp[i - 1][j] >= dp[i][j - 1]:
            i -= 1
        else:
            j -= 1

    return list(reversed(result))


def _lines_to_segments(
    lines: list[str], authors: list[str]
) -> list[BlameSegment]:
    segments: list[BlameSegment] = []
    offset = 0

    for i, line in enumerate(lines):
        line_len = len(line) + (1 if i < len(lines) - 1 else 0)  # +1 for \n
        if line_len == 0:
            continue

        author = authors[i] if i < len(authors) else "unknown"
        if segments and segments[-1].user_name == author and segments[-1].end == offset:
            segments[-1].end += line_len
        else:
            segments.append(BlameSegment(start=offset, end=offset + line_len, user_name=author))

        offset += line_len

    return segments
