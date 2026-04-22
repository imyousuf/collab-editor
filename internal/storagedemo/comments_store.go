package storagedemo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/imyousuf/collab-editor/pkg/spi"
)

// validThreadID matches UUID v4 (same as validUUID in store.go) or any safe
// short token.
const maxCommentBytes = 10 * 1024 // matches the default capabilities.max_comment_size

// CommentStore is a filesystem-backed implementation of spi.CommentsProvider
// (plus every Optional* sub-interface). It is intentionally not wired into
// FileStore because documents and comments are separate concerns — they just
// happen to share a root directory for demo convenience.
//
// Layout:
//
//	<baseDir>/.comments/<docID>/
//	    threads/<threadID>.json     // full thread with comments + suggestion (yjs_payload opaque)
//	    changes.log                 // append-only newline-delimited JSON for polling
type CommentStore struct {
	baseDir   string
	mentions  *MentionDirectory
	now       func() time.Time
	reactions []string // allowed emoji set
	mu        sync.Mutex
}

func NewCommentStore(baseDir string, mentions *MentionDirectory) (*CommentStore, error) {
	if err := os.MkdirAll(filepath.Join(baseDir, ".comments"), 0o755); err != nil {
		return nil, fmt.Errorf("creating comments dir: %w", err)
	}
	return &CommentStore{
		baseDir:  baseDir,
		mentions: mentions,
		now:      time.Now,
		reactions: []string{
			"thumbsup", "heart", "laugh", "confused", "celebrate",
		},
	}, nil
}

// --- Paths ---

func (cs *CommentStore) commentsDir(documentID string) string {
	return filepath.Join(cs.baseDir, ".comments", documentID)
}

func (cs *CommentStore) threadsDir(documentID string) string {
	return filepath.Join(cs.commentsDir(documentID), "threads")
}

func (cs *CommentStore) threadPath(documentID, threadID string) string {
	return filepath.Join(cs.threadsDir(documentID), threadID+".json")
}

func (cs *CommentStore) changeLogPath(documentID string) string {
	return filepath.Join(cs.commentsDir(documentID), "changes.log")
}

// --- CommentsProvider (required) ---

func (cs *CommentStore) Capabilities(_ context.Context) (*spi.CommentsCapabilities, error) {
	return &spi.CommentsCapabilities{
		CommentEdit:    true,
		CommentDelete:  true,
		Reactions:      cs.reactions,
		Mentions:       cs.mentions != nil && cs.mentions.Size() > 0,
		Suggestions:    true,
		MaxCommentSize: maxCommentBytes,
		PollSupported:  true,
	}, nil
}

func (cs *CommentStore) ListCommentThreads(_ context.Context, documentID string) ([]spi.CommentThreadListEntry, error) {
	if err := validateDocID(documentID); err != nil {
		return nil, err
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()

	threads, err := cs.readAllThreadsLocked(documentID)
	if err != nil {
		return nil, err
	}
	entries := make([]spi.CommentThreadListEntry, 0, len(threads))
	for _, t := range threads {
		entry := spi.CommentThreadListEntry{
			ID:           t.ID,
			Anchor:       t.Anchor,
			Status:       t.Status,
			CreatedAt:    t.CreatedAt,
			CommentCount: len(t.Comments),
		}
		if t.Suggestion != nil {
			entry.HasSuggestion = true
			entry.SuggestionStatus = t.Suggestion.Status
		}
		if n := len(t.Comments); n > 0 {
			last := t.Comments[n-1]
			entry.LastAuthorName = last.AuthorName
			at := last.CreatedAt
			entry.LastCommentAt = &at
		}
		entries = append(entries, entry)
	}
	// Most recent first.
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].CreatedAt.After(entries[j].CreatedAt)
	})
	return entries, nil
}

func (cs *CommentStore) GetCommentThread(_ context.Context, documentID, threadID string) (*spi.CommentThread, error) {
	if err := validateDocID(documentID); err != nil {
		return nil, err
	}
	if !validUUID.MatchString(threadID) {
		return nil, nil
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.readThreadLocked(documentID, threadID)
}

func (cs *CommentStore) CreateCommentThread(
	_ context.Context,
	documentID string,
	req *spi.CreateCommentThreadRequest,
) (*spi.CommentThread, error) {
	if err := validateDocID(documentID); err != nil {
		return nil, err
	}
	if req == nil {
		return nil, errors.New("missing request body")
	}
	if req.Comment != nil {
		if err := validateCommentContent(req.Comment.Content); err != nil {
			return nil, err
		}
	}
	if req.Suggestion != nil && req.Suggestion.AuthorNote != "" {
		if err := validateCommentContent(req.Suggestion.AuthorNote); err != nil {
			return nil, err
		}
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()

	if err := os.MkdirAll(cs.threadsDir(documentID), 0o755); err != nil {
		return nil, fmt.Errorf("creating threads dir: %w", err)
	}

	now := cs.now().UTC()
	threadID := uuid.NewString()
	thread := &spi.CommentThread{
		ID:         threadID,
		DocumentID: documentID,
		Anchor:     req.Anchor,
		Status:     "open",
		CreatedAt:  now,
		Comments:   []spi.Comment{},
	}
	if req.Comment != nil {
		c := spi.Comment{
			ID:         uuid.NewString(),
			ThreadID:   threadID,
			AuthorID:   req.Comment.AuthorID,
			AuthorName: req.Comment.AuthorName,
			Content:    req.Comment.Content,
			Mentions:   req.Comment.Mentions,
			CreatedAt:  now,
		}
		thread.Comments = append(thread.Comments, c)
	}
	if req.Suggestion != nil {
		s := *req.Suggestion
		if s.Status == "" {
			s.Status = "pending"
		}
		thread.Suggestion = &s
	}
	if err := cs.writeThreadLocked(documentID, thread); err != nil {
		return nil, err
	}
	cs.appendChangeLocked(documentID, spi.CommentChange{
		ThreadID: threadID, Action: "created",
		By: creatorOf(thread), At: now,
	})
	return thread, nil
}

func (cs *CommentStore) AddReply(
	_ context.Context,
	documentID, threadID string,
	req *spi.AddReplyRequest,
) (*spi.Comment, error) {
	if err := validateDocID(documentID); err != nil {
		return nil, err
	}
	if !validUUID.MatchString(threadID) {
		return nil, errors.New("invalid thread id")
	}
	if req == nil {
		return nil, errors.New("missing request body")
	}
	if err := validateCommentContent(req.Content); err != nil {
		return nil, err
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()

	thread, err := cs.readThreadLocked(documentID, threadID)
	if err != nil {
		return nil, err
	}
	if thread == nil {
		return nil, errors.New("thread not found")
	}

	now := cs.now().UTC()
	comment := spi.Comment{
		ID:         uuid.NewString(),
		ThreadID:   threadID,
		AuthorID:   req.AuthorID,
		AuthorName: req.AuthorName,
		Content:    req.Content,
		Mentions:   req.Mentions,
		CreatedAt:  now,
	}
	thread.Comments = append(thread.Comments, comment)
	if err := cs.writeThreadLocked(documentID, thread); err != nil {
		return nil, err
	}
	cs.appendChangeLocked(documentID, spi.CommentChange{
		ThreadID: threadID, Action: "reply_added",
		By: req.AuthorID, At: now, CommentID: comment.ID,
	})
	return &comment, nil
}

func (cs *CommentStore) UpdateThreadStatus(
	_ context.Context,
	documentID, threadID string,
	req *spi.UpdateThreadStatusRequest,
) (*spi.CommentThread, error) {
	if err := validateDocID(documentID); err != nil {
		return nil, err
	}
	if !validUUID.MatchString(threadID) {
		return nil, errors.New("invalid thread id")
	}
	if req == nil {
		return nil, errors.New("missing request body")
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()

	thread, err := cs.readThreadLocked(documentID, threadID)
	if err != nil {
		return nil, err
	}
	if thread == nil {
		return nil, errors.New("thread not found")
	}

	action := "reopened"
	if req.Status == "resolved" {
		action = "resolved"
		now := cs.now().UTC()
		thread.Status = "resolved"
		thread.ResolvedAt = &now
		thread.ResolvedBy = req.ResolvedBy
	} else {
		thread.Status = "open"
		thread.ResolvedAt = nil
		thread.ResolvedBy = ""
	}
	if err := cs.writeThreadLocked(documentID, thread); err != nil {
		return nil, err
	}
	cs.appendChangeLocked(documentID, spi.CommentChange{
		ThreadID: threadID, Action: action,
		By: req.ResolvedBy, At: cs.now().UTC(),
	})
	return thread, nil
}

func (cs *CommentStore) DeleteCommentThread(_ context.Context, documentID, threadID string) error {
	if err := validateDocID(documentID); err != nil {
		return err
	}
	if !validUUID.MatchString(threadID) {
		return errors.New("invalid thread id")
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()

	if err := os.Remove(cs.threadPath(documentID, threadID)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("delete thread: %w", err)
	}
	cs.appendChangeLocked(documentID, spi.CommentChange{
		ThreadID: threadID, Action: "deleted",
		At: cs.now().UTC(),
	})
	return nil
}

// --- OptionalCommentEdit ---

func (cs *CommentStore) UpdateComment(
	_ context.Context,
	documentID, threadID, commentID string,
	req *spi.UpdateCommentRequest,
) (*spi.Comment, error) {
	if err := validateDocID(documentID); err != nil {
		return nil, err
	}
	if !validUUID.MatchString(threadID) || !validUUID.MatchString(commentID) {
		return nil, errors.New("invalid id")
	}
	if req == nil {
		return nil, errors.New("missing request body")
	}
	if err := validateCommentContent(req.Content); err != nil {
		return nil, err
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()

	thread, err := cs.readThreadLocked(documentID, threadID)
	if err != nil {
		return nil, err
	}
	if thread == nil {
		return nil, errors.New("thread not found")
	}

	now := cs.now().UTC()
	for i := range thread.Comments {
		if thread.Comments[i].ID != commentID {
			continue
		}
		thread.Comments[i].Content = req.Content
		thread.Comments[i].Mentions = req.Mentions
		thread.Comments[i].UpdatedAt = &now
		if err := cs.writeThreadLocked(documentID, thread); err != nil {
			return nil, err
		}
		return &thread.Comments[i], nil
	}
	return nil, errors.New("comment not found")
}

func (cs *CommentStore) DeleteComment(
	_ context.Context,
	documentID, threadID, commentID string,
) error {
	if err := validateDocID(documentID); err != nil {
		return err
	}
	if !validUUID.MatchString(threadID) || !validUUID.MatchString(commentID) {
		return errors.New("invalid id")
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()

	thread, err := cs.readThreadLocked(documentID, threadID)
	if err != nil {
		return err
	}
	if thread == nil {
		return errors.New("thread not found")
	}

	now := cs.now().UTC()
	for i := range thread.Comments {
		if thread.Comments[i].ID != commentID {
			continue
		}
		// Soft delete: tombstone so thread ordering is preserved.
		thread.Comments[i].DeletedAt = &now
		thread.Comments[i].Content = ""
		thread.Comments[i].Mentions = nil
		return cs.writeThreadLocked(documentID, thread)
	}
	return errors.New("comment not found")
}

// --- OptionalReactions ---

func (cs *CommentStore) AddReaction(
	_ context.Context,
	documentID, threadID string,
	req *spi.ReactionRequest,
) error {
	if err := validateDocID(documentID); err != nil {
		return err
	}
	if !validUUID.MatchString(threadID) {
		return errors.New("invalid thread id")
	}
	if req == nil {
		return errors.New("missing request body")
	}
	if !cs.reactionAllowed(req.Emoji) {
		return fmt.Errorf("emoji %q not allowed", req.Emoji)
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()

	thread, err := cs.readThreadLocked(documentID, threadID)
	if err != nil {
		return err
	}
	if thread == nil {
		return errors.New("thread not found")
	}

	now := cs.now().UTC()
	if req.CommentID == "" {
		thread.Reactions = addReaction(thread.Reactions, req, now)
	} else {
		for i := range thread.Comments {
			if thread.Comments[i].ID == req.CommentID {
				thread.Comments[i].Reactions = addReaction(thread.Comments[i].Reactions, req, now)
			}
		}
	}
	return cs.writeThreadLocked(documentID, thread)
}

func (cs *CommentStore) RemoveReaction(
	_ context.Context,
	documentID, threadID string,
	req *spi.ReactionRequest,
) error {
	if err := validateDocID(documentID); err != nil {
		return err
	}
	if !validUUID.MatchString(threadID) {
		return errors.New("invalid thread id")
	}
	if req == nil {
		return errors.New("missing request body")
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()

	thread, err := cs.readThreadLocked(documentID, threadID)
	if err != nil {
		return err
	}
	if thread == nil {
		return errors.New("thread not found")
	}
	if req.CommentID == "" {
		thread.Reactions = removeReaction(thread.Reactions, req)
	} else {
		for i := range thread.Comments {
			if thread.Comments[i].ID == req.CommentID {
				thread.Comments[i].Reactions = removeReaction(thread.Comments[i].Reactions, req)
			}
		}
	}
	return cs.writeThreadLocked(documentID, thread)
}

// --- OptionalSuggestions ---

func (cs *CommentStore) DecideSuggestion(
	_ context.Context,
	documentID, threadID string,
	req *spi.SuggestionDecisionRequest,
) (*spi.CommentThread, error) {
	if err := validateDocID(documentID); err != nil {
		return nil, err
	}
	if !validUUID.MatchString(threadID) {
		return nil, errors.New("invalid thread id")
	}
	if req == nil {
		return nil, errors.New("missing request body")
	}
	switch req.Decision {
	case "accepted", "rejected", "not_applicable":
	default:
		return nil, fmt.Errorf("invalid decision: %q", req.Decision)
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()

	thread, err := cs.readThreadLocked(documentID, threadID)
	if err != nil {
		return nil, err
	}
	if thread == nil {
		return nil, errors.New("thread not found")
	}
	if thread.Suggestion == nil {
		return nil, errors.New("thread has no suggestion")
	}

	now := cs.now().UTC()
	thread.Suggestion.Status = req.Decision
	thread.Suggestion.DecidedBy = req.DecidedBy
	thread.Suggestion.DecidedAt = &now
	thread.Suggestion.AppliedVersionID = req.AppliedVersionID
	// Deciding a suggestion always resolves the thread (accepted, rejected,
	// or not_applicable all end the review).
	thread.Status = "resolved"
	thread.ResolvedAt = &now
	thread.ResolvedBy = req.DecidedBy

	if err := cs.writeThreadLocked(documentID, thread); err != nil {
		return nil, err
	}
	cs.appendChangeLocked(documentID, spi.CommentChange{
		ThreadID: threadID, Action: "suggestion_decided",
		By: req.DecidedBy, At: now,
	})
	return thread, nil
}

// --- OptionalMentions ---

func (cs *CommentStore) SearchMentions(
	_ context.Context,
	documentID, query string,
	limit int,
) ([]spi.MentionCandidate, error) {
	if err := validateDocID(documentID); err != nil {
		return nil, err
	}
	if cs.mentions == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = 10
	}
	return cs.mentions.Search(query, limit), nil
}

// --- OptionalCommentPoll ---

func (cs *CommentStore) PollCommentChanges(
	_ context.Context,
	documentID, since string,
) (*spi.CommentPollResponse, error) {
	if err := validateDocID(documentID); err != nil {
		return nil, err
	}
	var sinceTime time.Time
	if since != "" {
		t, err := time.Parse(time.RFC3339Nano, since)
		if err != nil {
			return nil, fmt.Errorf("invalid since timestamp: %w", err)
		}
		sinceTime = t
	}

	cs.mu.Lock()
	defer cs.mu.Unlock()

	changes, err := cs.readChangesSinceLocked(documentID, sinceTime)
	if err != nil {
		return nil, err
	}
	return &spi.CommentPollResponse{
		Changes:    changes,
		ServerTime: cs.now().UTC(),
	}, nil
}

// --- Internal helpers ---

func (cs *CommentStore) readThreadLocked(documentID, threadID string) (*spi.CommentThread, error) {
	data, err := os.ReadFile(cs.threadPath(documentID, threadID))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read thread: %w", err)
	}
	var thread spi.CommentThread
	if err := json.Unmarshal(data, &thread); err != nil {
		return nil, fmt.Errorf("unmarshal thread: %w", err)
	}
	return &thread, nil
}

func (cs *CommentStore) writeThreadLocked(documentID string, thread *spi.CommentThread) error {
	if err := os.MkdirAll(cs.threadsDir(documentID), 0o755); err != nil {
		return fmt.Errorf("mkdir threads: %w", err)
	}
	data, err := json.MarshalIndent(thread, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal thread: %w", err)
	}
	if err := os.WriteFile(cs.threadPath(documentID, thread.ID), data, 0o644); err != nil {
		return fmt.Errorf("write thread: %w", err)
	}
	return nil
}

func (cs *CommentStore) readAllThreadsLocked(documentID string) ([]*spi.CommentThread, error) {
	dir := cs.threadsDir(documentID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read threads dir: %w", err)
	}
	threads := make([]*spi.CommentThread, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		threadID := strings.TrimSuffix(e.Name(), ".json")
		t, err := cs.readThreadLocked(documentID, threadID)
		if err != nil {
			continue
		}
		if t != nil {
			threads = append(threads, t)
		}
	}
	return threads, nil
}

func (cs *CommentStore) appendChangeLocked(documentID string, change spi.CommentChange) {
	path := cs.changeLogPath(documentID)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	data, err := json.Marshal(change)
	if err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(data, '\n'))
}

func (cs *CommentStore) readChangesSinceLocked(documentID string, since time.Time) ([]spi.CommentChange, error) {
	path := cs.changeLogPath(documentID)
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	var changes []spi.CommentChange
	buf, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(string(buf), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var ch spi.CommentChange
		if err := json.Unmarshal([]byte(line), &ch); err != nil {
			continue
		}
		if !since.IsZero() && !ch.At.After(since) {
			continue
		}
		changes = append(changes, ch)
	}
	return changes, nil
}

func (cs *CommentStore) reactionAllowed(emoji string) bool {
	for _, a := range cs.reactions {
		if a == emoji {
			return true
		}
	}
	return false
}

func creatorOf(thread *spi.CommentThread) string {
	if thread.Suggestion != nil && thread.Suggestion.AuthorID != "" {
		return thread.Suggestion.AuthorID
	}
	if len(thread.Comments) > 0 {
		return thread.Comments[0].AuthorID
	}
	return ""
}

func addReaction(list []spi.Reaction, req *spi.ReactionRequest, now time.Time) []spi.Reaction {
	for _, r := range list {
		if r.UserID == req.UserID && r.Emoji == req.Emoji {
			// Idempotent add.
			return list
		}
	}
	return append(list, spi.Reaction{
		UserID:    req.UserID,
		UserName:  req.UserName,
		Emoji:     req.Emoji,
		CreatedAt: now,
	})
}

func removeReaction(list []spi.Reaction, req *spi.ReactionRequest) []spi.Reaction {
	out := list[:0]
	for _, r := range list {
		if r.UserID == req.UserID && r.Emoji == req.Emoji {
			continue
		}
		out = append(out, r)
	}
	return out
}

func validateCommentContent(content string) error {
	if len(content) > maxCommentBytes {
		return fmt.Errorf("comment exceeds max size of %d bytes", maxCommentBytes)
	}
	return nil
}

// Compile-time interface assertions.
var (
	_ spi.CommentsProvider     = (*CommentStore)(nil)
	_ spi.OptionalCommentEdit  = (*CommentStore)(nil)
	_ spi.OptionalReactions    = (*CommentStore)(nil)
	_ spi.OptionalSuggestions  = (*CommentStore)(nil)
	_ spi.OptionalMentions     = (*CommentStore)(nil)
	_ spi.OptionalCommentPoll  = (*CommentStore)(nil)
)
