"""Tests for the blame computation module."""

from __future__ import annotations

from collab_editor_provider.blame import compute_blame_from_versions
from collab_editor_provider.types import VersionEntry


def _make_version(
    id: str, content: str, creator: str, created_at: str = "2026-01-01"
) -> VersionEntry:
    return VersionEntry(
        id=id,
        content=content,
        creator=creator,
        created_at=created_at,
        type="manual",
    )


class TestComputeBlameFromVersions:
    def test_empty_versions(self) -> None:
        assert compute_blame_from_versions([]) == []

    def test_single_version(self) -> None:
        versions = [_make_version("v1", "hello\nworld", "alice")]
        blame = compute_blame_from_versions(versions)
        assert len(blame) == 1
        assert blame[0].user_name == "alice"
        assert blame[0].start == 0
        assert blame[0].end == 11  # "hello\nworld"

    def test_two_versions_new_lines(self) -> None:
        versions = [
            _make_version("v1", "line1\nline2", "alice", "2026-01-01"),
            _make_version("v2", "line1\nline2\nline3", "bob", "2026-01-02"),
        ]
        blame = compute_blame_from_versions(versions)
        assert len(blame) == 2
        assert blame[0].user_name == "alice"
        assert blame[1].user_name == "bob"

    def test_modified_line(self) -> None:
        versions = [
            _make_version("v1", "hello world", "alice", "2026-01-01"),
            _make_version("v2", "hello universe", "bob", "2026-01-02"),
        ]
        blame = compute_blame_from_versions(versions)
        assert len(blame) == 1
        assert blame[0].user_name == "bob"

    def test_unchanged_lines_retain_attribution(self) -> None:
        versions = [
            _make_version("v1", "line1\nline2\nline3", "alice", "2026-01-01"),
            _make_version("v2", "line1\nchanged\nline3", "bob", "2026-01-02"),
        ]
        blame = compute_blame_from_versions(versions)
        assert len(blame) == 3
        assert blame[0].user_name == "alice"  # line1
        assert blame[1].user_name == "bob"  # changed
        assert blame[2].user_name == "alice"  # line3

    def test_three_versions_accumulates(self) -> None:
        versions = [
            _make_version("v1", "a\nb\nc", "alice", "2026-01-01"),
            _make_version("v2", "a\nB\nc", "bob", "2026-01-02"),
            _make_version("v3", "a\nB\nC", "charlie", "2026-01-03"),
        ]
        blame = compute_blame_from_versions(versions)
        assert len(blame) == 3
        assert blame[0].user_name == "alice"  # a
        assert blame[1].user_name == "bob"  # B
        assert blame[2].user_name == "charlie"  # C

    def test_empty_to_content(self) -> None:
        versions = [
            _make_version("v1", "", "alice", "2026-01-01"),
            _make_version("v2", "hello", "bob", "2026-01-02"),
        ]
        blame = compute_blame_from_versions(versions)
        assert len(blame) == 1
        assert blame[0].user_name == "bob"

    def test_deletion(self) -> None:
        versions = [
            _make_version("v1", "hello\nworld", "alice", "2026-01-01"),
            _make_version("v2", "", "bob", "2026-01-02"),
        ]
        blame = compute_blame_from_versions(versions)
        assert len(blame) == 0

    def test_segment_merging(self) -> None:
        versions = [_make_version("v1", "a\nb\nc", "alice")]
        blame = compute_blame_from_versions(versions)
        assert len(blame) == 1
        assert blame[0].user_name == "alice"
        assert blame[0].start == 0
        assert blame[0].end == 5  # "a\nb\nc"

    def test_missing_creator(self) -> None:
        versions = [_make_version("v1", "hello", "")]
        versions[0].creator = None
        blame = compute_blame_from_versions(versions)
        assert blame[0].user_name == "unknown"
