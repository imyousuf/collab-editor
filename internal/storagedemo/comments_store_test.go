package storagedemo

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

func newTestCommentStore(t *testing.T) *CommentStore {
	t.Helper()
	dir := t.TempDir()
	mentions := NewMentionDirectory([]spi.MentionCandidate{
		{UserID: "alice", DisplayName: "Alice"},
		{UserID: "bob", DisplayName: "Bob"},
		{UserID: "carol", DisplayName: "Carol"},
	})
	cs, err := NewCommentStore(dir, mentions)
	if err != nil {
		t.Fatal(err)
	}
	cs.now = func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	return cs
}

func TestCommentStore_Capabilities(t *testing.T) {
	cs := newTestCommentStore(t)
	caps, err := cs.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !caps.CommentEdit || !caps.CommentDelete || !caps.Suggestions || !caps.PollSupported {
		t.Errorf("expected all core capabilities on: %+v", caps)
	}
	if len(caps.Reactions) == 0 {
		t.Errorf("expected non-empty reactions set")
	}
	if !caps.Mentions {
		t.Errorf("expected mentions=true when directory is non-empty")
	}
	if caps.MaxCommentSize != maxCommentBytes {
		t.Errorf("unexpected max_comment_size: %d", caps.MaxCommentSize)
	}
}

func TestCommentStore_EmptyMentionDirectoryDisablesMentions(t *testing.T) {
	dir := t.TempDir()
	cs, err := NewCommentStore(dir, NewMentionDirectory(nil))
	if err != nil {
		t.Fatal(err)
	}
	caps, _ := cs.Capabilities(context.Background())
	if caps.Mentions {
		t.Errorf("mentions must be false when directory is empty")
	}
}

func TestCommentStore_CreateThread_Basic(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()
	thread, err := cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 5, QuotedText: "hello"},
		Comment: &spi.NewComment{
			AuthorID: "alice", AuthorName: "Alice", Content: "Should we rephrase?",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if thread.ID == "" || thread.Status != "open" || len(thread.Comments) != 1 {
		t.Errorf("unexpected thread: %+v", thread)
	}

	// Round-trip via Get.
	got, err := cs.GetCommentThread(ctx, "doc.md", thread.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.ID != thread.ID || got.Comments[0].Content != "Should we rephrase?" {
		t.Errorf("round trip mismatch: %+v", got)
	}
}

func TestCommentStore_CreateThread_WithSuggestion_OpacityPreserved(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()
	want := "Vz8AAAEBAgMEBQYHCAkKCwwNDg8Q"
	thread, err := cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 5, QuotedText: "hello"},
		Suggestion: &spi.Suggestion{
			YjsPayload: want,
			HumanReadable: spi.SuggestionView{
				Summary: "change", BeforeText: "hello", AfterText: "hi",
			},
			AuthorID: "alice", AuthorName: "Alice",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if thread.Suggestion == nil || thread.Suggestion.YjsPayload != want {
		t.Errorf("create mangled payload: %+v", thread.Suggestion)
	}

	got, err := cs.GetCommentThread(ctx, "doc.md", thread.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Suggestion.YjsPayload != want {
		t.Errorf("get mangled payload: %q", got.Suggestion.YjsPayload)
	}
	if got.Suggestion.Status != "pending" {
		t.Errorf("suggestion default status should be pending, got %q", got.Suggestion.Status)
	}
}

func TestCommentStore_AddReply_AppendsComment(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()
	t1, _ := cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
		Comment: &spi.NewComment{AuthorID: "alice", AuthorName: "Alice", Content: "first"},
	})
	reply, err := cs.AddReply(ctx, "doc.md", t1.ID, &spi.AddReplyRequest{
		AuthorID: "bob", AuthorName: "Bob", Content: "second",
	})
	if err != nil {
		t.Fatal(err)
	}
	if reply.ID == "" || reply.Content != "second" {
		t.Errorf("unexpected reply: %+v", reply)
	}
	got, _ := cs.GetCommentThread(ctx, "doc.md", t1.ID)
	if len(got.Comments) != 2 {
		t.Errorf("expected 2 comments, got %d", len(got.Comments))
	}
}

func TestCommentStore_ResolveAndReopen(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()
	t1, _ := cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
	})
	resolved, err := cs.UpdateThreadStatus(ctx, "doc.md", t1.ID, &spi.UpdateThreadStatusRequest{
		Status: "resolved", ResolvedBy: "alice",
	})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Status != "resolved" || resolved.ResolvedAt == nil || resolved.ResolvedBy != "alice" {
		t.Errorf("resolve mismatch: %+v", resolved)
	}
	reopened, err := cs.UpdateThreadStatus(ctx, "doc.md", t1.ID, &spi.UpdateThreadStatusRequest{
		Status: "open",
	})
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Status != "open" || reopened.ResolvedAt != nil || reopened.ResolvedBy != "" {
		t.Errorf("reopen mismatch: %+v", reopened)
	}
}

func TestCommentStore_ListSortsByCreationDesc(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	cs.now = func() time.Time { return base }
	t1, _ := cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
	})
	cs.now = func() time.Time { return base.Add(time.Minute) }
	t2, _ := cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 1, End: 2, QuotedText: "b"},
	})

	list, err := cs.ListCommentThreads(ctx, "doc.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("want 2 entries, got %d", len(list))
	}
	if list[0].ID != t2.ID || list[1].ID != t1.ID {
		t.Errorf("ordering wrong, want %s then %s, got %s then %s",
			t2.ID, t1.ID, list[0].ID, list[1].ID)
	}
}

func TestCommentStore_DeleteThread(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()
	t1, _ := cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
	})
	if err := cs.DeleteCommentThread(ctx, "doc.md", t1.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := cs.GetCommentThread(ctx, "doc.md", t1.ID)
	if got != nil {
		t.Errorf("expected thread gone, got %+v", got)
	}
}

func TestCommentStore_Edit_And_SoftDeleteComment(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()
	t1, _ := cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
		Comment: &spi.NewComment{AuthorID: "alice", AuthorName: "Alice", Content: "orig"},
	})
	commentID := t1.Comments[0].ID

	edited, err := cs.UpdateComment(ctx, "doc.md", t1.ID, commentID, &spi.UpdateCommentRequest{
		Content: "edited",
	})
	if err != nil {
		t.Fatal(err)
	}
	if edited.Content != "edited" || edited.UpdatedAt == nil {
		t.Errorf("edit mismatch: %+v", edited)
	}

	if err := cs.DeleteComment(ctx, "doc.md", t1.ID, commentID); err != nil {
		t.Fatal(err)
	}
	got, _ := cs.GetCommentThread(ctx, "doc.md", t1.ID)
	if got.Comments[0].DeletedAt == nil || got.Comments[0].Content != "" {
		t.Errorf("soft-delete mismatch: %+v", got.Comments[0])
	}
}

func TestCommentStore_Reactions_Idempotent(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()
	t1, _ := cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
	})
	req := &spi.ReactionRequest{UserID: "alice", UserName: "Alice", Emoji: "thumbsup"}
	if err := cs.AddReaction(ctx, "doc.md", t1.ID, req); err != nil {
		t.Fatal(err)
	}
	// Adding twice must not duplicate.
	if err := cs.AddReaction(ctx, "doc.md", t1.ID, req); err != nil {
		t.Fatal(err)
	}
	got, _ := cs.GetCommentThread(ctx, "doc.md", t1.ID)
	if len(got.Reactions) != 1 {
		t.Errorf("expected 1 reaction, got %d", len(got.Reactions))
	}

	if err := cs.RemoveReaction(ctx, "doc.md", t1.ID, req); err != nil {
		t.Fatal(err)
	}
	got, _ = cs.GetCommentThread(ctx, "doc.md", t1.ID)
	if len(got.Reactions) != 0 {
		t.Errorf("expected 0 reactions after remove, got %d", len(got.Reactions))
	}
}

func TestCommentStore_Reactions_RejectsUnknownEmoji(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()
	t1, _ := cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
	})
	err := cs.AddReaction(ctx, "doc.md", t1.ID, &spi.ReactionRequest{
		UserID: "alice", UserName: "Alice", Emoji: "not-allowed",
	})
	if err == nil {
		t.Errorf("expected error for unknown emoji")
	}
}

func TestCommentStore_DecideSuggestion_AcceptResolvesThread(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()
	t1, _ := cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
		Suggestion: &spi.Suggestion{
			YjsPayload: "AAA=", HumanReadable: spi.SuggestionView{Summary: "x"},
			AuthorID: "alice", AuthorName: "Alice",
		},
	})
	thread, err := cs.DecideSuggestion(ctx, "doc.md", t1.ID, &spi.SuggestionDecisionRequest{
		Decision: "accepted", DecidedBy: "bob", AppliedVersionID: "v42",
	})
	if err != nil {
		t.Fatal(err)
	}
	if thread.Status != "resolved" {
		t.Errorf("thread should be resolved on accept, got %q", thread.Status)
	}
	if thread.Suggestion.Status != "accepted" ||
		thread.Suggestion.DecidedBy != "bob" ||
		thread.Suggestion.AppliedVersionID != "v42" {
		t.Errorf("suggestion fields wrong: %+v", thread.Suggestion)
	}
}

func TestCommentStore_DecideSuggestion_RejectsInvalidDecision(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()
	t1, _ := cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
		Suggestion: &spi.Suggestion{
			YjsPayload: "AAA=", AuthorID: "alice", AuthorName: "Alice",
		},
	})
	_, err := cs.DecideSuggestion(ctx, "doc.md", t1.ID, &spi.SuggestionDecisionRequest{
		Decision: "hmm", DecidedBy: "bob",
	})
	if err == nil {
		t.Errorf("expected invalid-decision error")
	}
}

func TestCommentStore_DecideSuggestion_ErrorsOnMissingSuggestion(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()
	t1, _ := cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
	})
	_, err := cs.DecideSuggestion(ctx, "doc.md", t1.ID, &spi.SuggestionDecisionRequest{
		Decision: "accepted", DecidedBy: "bob",
	})
	if err == nil {
		t.Errorf("expected error when thread has no suggestion")
	}
}

func TestCommentStore_SearchMentions_ByNameAndId(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()

	results, err := cs.SearchMentions(ctx, "doc.md", "ali", 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].UserID != "alice" {
		t.Errorf("expected alice, got %+v", results)
	}

	results, err = cs.SearchMentions(ctx, "doc.md", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 (limit), got %d", len(results))
	}
}

func TestCommentStore_Poll_FiltersBySince(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()

	cs.now = func() time.Time { return time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC) }
	_, _ = cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
	})
	cs.now = func() time.Time { return time.Date(2026, 1, 1, 13, 0, 0, 0, time.UTC) }
	_, _ = cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 1, End: 2, QuotedText: "b"},
	})

	resp, err := cs.PollCommentChanges(ctx, "doc.md", "2026-01-01T12:30:00Z")
	if err != nil {
		t.Fatal(err)
	}
	// Only the 13:00 creation should be included.
	if len(resp.Changes) != 1 {
		t.Fatalf("expected 1 change, got %d", len(resp.Changes))
	}
	if resp.Changes[0].Action != "created" {
		t.Errorf("unexpected action: %q", resp.Changes[0].Action)
	}
}

func TestCommentStore_RejectsOversizedComment(t *testing.T) {
	cs := newTestCommentStore(t)
	ctx := context.Background()
	oversize := strings.Repeat("a", maxCommentBytes+1)
	_, err := cs.CreateCommentThread(ctx, "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
		Comment: &spi.NewComment{
			AuthorID: "alice", AuthorName: "Alice", Content: oversize,
		},
	})
	if err == nil {
		t.Errorf("expected oversize error")
	}
}
