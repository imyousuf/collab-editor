package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

type recordedRequest struct {
	method string
	path   string
	query  string
	body   []byte
	auth   string
}

// recorderHandler returns an httptest.Server that records each request and
// replies with the supplied response body + status.
func recorderHandler(t *testing.T, recorder *[]recordedRequest, responses map[string]response) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		*recorder = append(*recorder, recordedRequest{
			method: r.Method,
			path:   r.URL.Path,
			query:  r.URL.RawQuery,
			body:   body,
			auth:   r.Header.Get("Authorization"),
		})
		key := r.Method + " " + r.URL.Path
		resp, ok := responses[key]
		if !ok {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if resp.contentType != "" {
			w.Header().Set("Content-Type", resp.contentType)
		}
		w.WriteHeader(resp.status)
		if resp.body != nil {
			_, _ = w.Write(resp.body)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

type response struct {
	status      int
	body        []byte
	contentType string
}

func jsonBody(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestCommentsClient_Capabilities(t *testing.T) {
	var recorded []recordedRequest
	caps := spi.CommentsCapabilities{
		CommentEdit: true, Reactions: []string{"heart"},
		Suggestions: true, MaxCommentSize: 10240,
	}
	srv := recorderHandler(t, &recorded, map[string]response{
		"GET /capabilities": {status: 200, body: jsonBody(t, caps), contentType: "application/json"},
	})
	c := NewCommentsClient(CommentsClientConfig{BaseURL: srv.URL, AuthToken: "t0k", Timeout: time.Second})

	got, err := c.Capabilities(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !got.CommentEdit || !got.Suggestions || len(got.Reactions) != 1 {
		t.Errorf("capabilities mismatch: %+v", got)
	}
	// Auth header propagated.
	if recorded[0].auth != "Bearer t0k" {
		t.Errorf("missing auth header: %q", recorded[0].auth)
	}
}

func TestCommentsClient_CRUD(t *testing.T) {
	var recorded []recordedRequest
	thread := spi.CommentThread{ID: "t1", Status: "open"}
	srv := recorderHandler(t, &recorded, map[string]response{
		"POST /documents/comments":       {status: 201, body: jsonBody(t, thread), contentType: "application/json"},
		"GET /documents/comments":        {status: 200, body: jsonBody(t, map[string]any{"threads": []spi.CommentThreadListEntry{{ID: "t1", Status: "open"}}}), contentType: "application/json"},
		"GET /documents/comments/t1":     {status: 200, body: jsonBody(t, thread), contentType: "application/json"},
		"PATCH /documents/comments/t1":   {status: 200, body: jsonBody(t, thread), contentType: "application/json"},
		"DELETE /documents/comments/t1":  {status: 204},
		"POST /documents/comments/t1/replies": {status: 201, body: jsonBody(t, spi.Comment{ID: "c1", Content: "hi"}), contentType: "application/json"},
	})
	c := NewCommentsClient(CommentsClientConfig{BaseURL: srv.URL})

	created, err := c.CreateCommentThread(context.Background(), "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.ID != "t1" {
		t.Errorf("create: got %+v", created)
	}

	threads, err := c.ListCommentThreads(context.Background(), "doc.md")
	if err != nil || len(threads) != 1 {
		t.Errorf("list failed: %v %+v", err, threads)
	}

	got, err := c.GetCommentThread(context.Background(), "doc.md", "t1")
	if err != nil || got.ID != "t1" {
		t.Errorf("get failed: %v %+v", err, got)
	}

	reply, err := c.AddReply(context.Background(), "doc.md", "t1", &spi.AddReplyRequest{
		AuthorID: "u1", AuthorName: "Alice", Content: "hi",
	})
	if err != nil || reply.Content != "hi" {
		t.Errorf("reply failed: %v %+v", err, reply)
	}

	updated, err := c.UpdateThreadStatus(context.Background(), "doc.md", "t1",
		&spi.UpdateThreadStatusRequest{Status: "resolved", ResolvedBy: "u1"})
	if err != nil || updated.ID != "t1" {
		t.Errorf("update failed: %v %+v", err, updated)
	}

	if err := c.DeleteCommentThread(context.Background(), "doc.md", "t1"); err != nil {
		t.Fatalf("delete failed: %v", err)
	}

	// Confirm path+query contain doc id on every route.
	for _, rec := range recorded {
		if rec.path != "/capabilities" && !strings.Contains(rec.query, "path=doc.md") {
			t.Errorf("missing path query on %s %s", rec.method, rec.path)
		}
	}
}

func TestCommentsClient_YjsPayloadNotMutated(t *testing.T) {
	var recorded []recordedRequest
	want := "BQABAgMEBQY="
	// Echo the suggestion back unchanged.
	srv := recorderHandler(t, &recorded, map[string]response{
		"POST /documents/comments": {
			status: 201,
			body: jsonBody(t, spi.CommentThread{
				ID:         "t1",
				Suggestion: &spi.Suggestion{YjsPayload: want, Status: "pending"},
			}),
			contentType: "application/json",
		},
	})
	c := NewCommentsClient(CommentsClientConfig{BaseURL: srv.URL})
	created, err := c.CreateCommentThread(context.Background(), "doc.md", &spi.CreateCommentThreadRequest{
		Anchor: spi.CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
		Suggestion: &spi.Suggestion{
			YjsPayload: want, Status: "pending",
			AuthorID: "u1", AuthorName: "Alice",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Suggestion == nil || created.Suggestion.YjsPayload != want {
		t.Errorf("suggestion roundtrip mangled: %+v", created.Suggestion)
	}
	// Sent body must also contain the original payload.
	if !bytes.Contains(recorded[0].body, []byte(want)) {
		t.Errorf("sent body missing yjs_payload")
	}
}

func TestCommentsClient_ReactionsAndSuggestions(t *testing.T) {
	var recorded []recordedRequest
	srv := recorderHandler(t, &recorded, map[string]response{
		"POST /documents/comments/t1/reactions":            {status: 204},
		"DELETE /documents/comments/t1/reactions":          {status: 204},
		"POST /documents/comments/t1/suggestion/decision":  {status: 200, body: jsonBody(t, spi.CommentThread{ID: "t1", Status: "resolved"}), contentType: "application/json"},
	})
	c := NewCommentsClient(CommentsClientConfig{BaseURL: srv.URL})

	if err := c.AddReaction(context.Background(), "doc.md", "t1",
		&spi.ReactionRequest{UserID: "u1", UserName: "Alice", Emoji: "heart"}); err != nil {
		t.Fatal(err)
	}
	if err := c.RemoveReaction(context.Background(), "doc.md", "t1",
		&spi.ReactionRequest{UserID: "u1", UserName: "Alice", Emoji: "heart"}); err != nil {
		t.Fatal(err)
	}
	thread, err := c.DecideSuggestion(context.Background(), "doc.md", "t1",
		&spi.SuggestionDecisionRequest{Decision: "accepted", DecidedBy: "u2"})
	if err != nil || thread.Status != "resolved" {
		t.Errorf("decide: %+v err=%v", thread, err)
	}

	// DELETE should carry the body.
	var removeReq recordedRequest
	for _, r := range recorded {
		if r.method == "DELETE" && strings.Contains(r.path, "reactions") {
			removeReq = r
		}
	}
	if !bytes.Contains(removeReq.body, []byte(`"heart"`)) {
		t.Errorf("remove reaction body missing payload: %s", removeReq.body)
	}
}

func TestCommentsClient_SearchMentionsAndPoll(t *testing.T) {
	var recorded []recordedRequest
	srv := recorderHandler(t, &recorded, map[string]response{
		"GET /documents/comments/mentions/search": {
			status:      200,
			body:        jsonBody(t, map[string]any{"candidates": []spi.MentionCandidate{{UserID: "u1", DisplayName: "Alice"}}}),
			contentType: "application/json",
		},
		"GET /documents/comments/poll": {
			status: 200,
			body: jsonBody(t, spi.CommentPollResponse{
				Changes: []spi.CommentChange{{ThreadID: "t1", Action: "resolved"}},
			}),
			contentType: "application/json",
		},
	})
	c := NewCommentsClient(CommentsClientConfig{BaseURL: srv.URL})

	matches, err := c.SearchMentions(context.Background(), "doc.md", "ali", 5)
	if err != nil || len(matches) != 1 {
		t.Errorf("mentions: err=%v matches=%+v", err, matches)
	}
	if !strings.Contains(recorded[0].query, "q=ali") || !strings.Contains(recorded[0].query, "limit=5") {
		t.Errorf("mentions query: %q", recorded[0].query)
	}

	resp, err := c.PollCommentChanges(context.Background(), "doc.md", "2026-01-01T00:00:00Z")
	if err != nil || len(resp.Changes) != 1 {
		t.Errorf("poll: err=%v resp=%+v", err, resp)
	}
}

func TestCommentsClient_GetNotFound(t *testing.T) {
	var recorded []recordedRequest
	srv := recorderHandler(t, &recorded, map[string]response{
		"GET /documents/comments/t1": {status: 404, body: []byte(`{"error":"not found"}`)},
	})
	c := NewCommentsClient(CommentsClientConfig{BaseURL: srv.URL})

	thread, err := c.GetCommentThread(context.Background(), "doc.md", "t1")
	if err != nil {
		t.Fatal(err)
	}
	if thread != nil {
		t.Errorf("expected nil thread on 404")
	}
}
