package spi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// --- Test doubles ---

// commentsCoreProvider implements only the base CommentsProvider — none of
// the Optional* interfaces. Used to verify conditional route wiring.
type commentsCoreProvider struct {
	capsResp       *CommentsCapabilities
	listResp       []CommentThreadListEntry
	getResp        *CommentThread
	createResp     *CommentThread
	replyResp      *Comment
	statusResp     *CommentThread
	deleteErr      error
	lastCreateReq  *CreateCommentThreadRequest
	lastReplyReq   *AddReplyRequest
	lastStatusReq  *UpdateThreadStatusRequest
	lastDeletedID  string
}

func (p *commentsCoreProvider) Capabilities(_ context.Context) (*CommentsCapabilities, error) {
	return p.capsResp, nil
}
func (p *commentsCoreProvider) ListCommentThreads(_ context.Context, _ string) ([]CommentThreadListEntry, error) {
	return p.listResp, nil
}
func (p *commentsCoreProvider) GetCommentThread(_ context.Context, _, _ string) (*CommentThread, error) {
	return p.getResp, nil
}
func (p *commentsCoreProvider) CreateCommentThread(_ context.Context, _ string, req *CreateCommentThreadRequest) (*CommentThread, error) {
	p.lastCreateReq = req
	return p.createResp, nil
}
func (p *commentsCoreProvider) AddReply(_ context.Context, _, _ string, req *AddReplyRequest) (*Comment, error) {
	p.lastReplyReq = req
	return p.replyResp, nil
}
func (p *commentsCoreProvider) UpdateThreadStatus(_ context.Context, _, _ string, req *UpdateThreadStatusRequest) (*CommentThread, error) {
	p.lastStatusReq = req
	return p.statusResp, nil
}
func (p *commentsCoreProvider) DeleteCommentThread(_ context.Context, _, threadID string) error {
	p.lastDeletedID = threadID
	return p.deleteErr
}

// fullProvider embeds the core and adds every Optional* interface.
type fullProvider struct {
	commentsCoreProvider
	updateCommentCalled bool
	deleteCommentCalled bool
	addReactionCalled   bool
	removeReactionCalled bool
	decideCalled        bool
	searchCalled        bool
	pollCalled          bool
}

func (p *fullProvider) UpdateComment(_ context.Context, _, _, _ string, _ *UpdateCommentRequest) (*Comment, error) {
	p.updateCommentCalled = true
	return &Comment{ID: "c1", Content: "updated"}, nil
}
func (p *fullProvider) DeleteComment(_ context.Context, _, _, _ string) error {
	p.deleteCommentCalled = true
	return nil
}
func (p *fullProvider) AddReaction(_ context.Context, _, _ string, _ *ReactionRequest) error {
	p.addReactionCalled = true
	return nil
}
func (p *fullProvider) RemoveReaction(_ context.Context, _, _ string, _ *ReactionRequest) error {
	p.removeReactionCalled = true
	return nil
}
func (p *fullProvider) DecideSuggestion(_ context.Context, _, _ string, _ *SuggestionDecisionRequest) (*CommentThread, error) {
	p.decideCalled = true
	return &CommentThread{ID: "t1", Status: "resolved"}, nil
}
func (p *fullProvider) SearchMentions(_ context.Context, _, _ string, _ int) ([]MentionCandidate, error) {
	p.searchCalled = true
	return []MentionCandidate{{UserID: "u1", DisplayName: "Alice"}}, nil
}
func (p *fullProvider) PollCommentChanges(_ context.Context, _, _ string) (*CommentPollResponse, error) {
	p.pollCalled = true
	return &CommentPollResponse{ServerTime: time.Now(), Changes: []CommentChange{{ThreadID: "t1", Action: "resolved"}}}, nil
}

// --- Tests ---

func TestCommentsHandler_Capabilities(t *testing.T) {
	p := &commentsCoreProvider{capsResp: &CommentsCapabilities{
		CommentEdit: false,
		Reactions:   nil, // explicitly disabled
		Mentions:    false,
		Suggestions: false,
	}}
	h := NewCommentsHTTPHandler(p)

	req := httptest.NewRequest("GET", "/capabilities", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d", w.Code)
	}
	var caps CommentsCapabilities
	if err := json.NewDecoder(w.Body).Decode(&caps); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if caps.CommentEdit || caps.Mentions || caps.Suggestions {
		t.Errorf("expected all optional features off: %+v", caps)
	}
	if len(caps.Reactions) != 0 {
		t.Errorf("expected no reactions: %+v", caps.Reactions)
	}
}

func TestCommentsHandler_ListThreads(t *testing.T) {
	p := &commentsCoreProvider{
		listResp: []CommentThreadListEntry{
			{ID: "t1", Status: "open", CommentCount: 2},
			{ID: "t2", Status: "resolved", CommentCount: 5, HasSuggestion: true, SuggestionStatus: "accepted"},
		},
	}
	h := NewCommentsHTTPHandler(p)

	req := httptest.NewRequest("GET", "/documents/comments?path=doc.md", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d", w.Code)
	}
	var body struct {
		Threads []CommentThreadListEntry `json:"threads"`
	}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Threads) != 2 {
		t.Fatalf("threads: got %d", len(body.Threads))
	}
	if !body.Threads[1].HasSuggestion || body.Threads[1].SuggestionStatus != "accepted" {
		t.Errorf("suggestion fields not preserved: %+v", body.Threads[1])
	}
}

func TestCommentsHandler_ListThreads_MissingPath(t *testing.T) {
	h := NewCommentsHTTPHandler(&commentsCoreProvider{})

	req := httptest.NewRequest("GET", "/documents/comments", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status: got %d want 400", w.Code)
	}
}

func TestCommentsHandler_CreateThread_WithSuggestion(t *testing.T) {
	p := &commentsCoreProvider{
		createResp: &CommentThread{ID: "t1", Status: "open"},
	}
	h := NewCommentsHTTPHandler(p)

	body := CreateCommentThreadRequest{
		Anchor: CommentAnchor{Start: 5, End: 10, QuotedText: "hello"},
		Suggestion: &Suggestion{
			YjsPayload: "AAEC", // opaque base64 — provider must not interpret
			HumanReadable: SuggestionView{
				Summary:    `Change "hello" to "hi"`,
				BeforeText: "hello",
				AfterText:  "hi",
			},
			AuthorID:   "u1",
			AuthorName: "Alice",
			Status:     "pending",
		},
	}
	buf, _ := json.Marshal(body)

	req := httptest.NewRequest("POST", "/documents/comments?path=doc.md", bytes.NewReader(buf))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("status: got %d", w.Code)
	}
	if p.lastCreateReq == nil || p.lastCreateReq.Suggestion == nil {
		t.Fatalf("create req not captured: %+v", p.lastCreateReq)
	}
	// The provider must receive the opaque payload unchanged.
	if p.lastCreateReq.Suggestion.YjsPayload != "AAEC" {
		t.Errorf("yjs_payload mutated: %q", p.lastCreateReq.Suggestion.YjsPayload)
	}
}

func TestCommentsHandler_CreateThread_ClientProvidedIDs(t *testing.T) {
	// Frontend owns the canonical thread + comment IDs (Y.Map keys and
	// RelativePosition anchors are pinned to them). The handler must
	// forward req.ID and req.Comment.ID to the provider verbatim.
	p := &commentsCoreProvider{
		createResp: &CommentThread{ID: "tid-from-client"},
	}
	h := NewCommentsHTTPHandler(p)

	body := CreateCommentThreadRequest{
		ID:     "tid-from-client",
		Anchor: CommentAnchor{Start: 0, End: 3, QuotedText: "abc"},
		Comment: &NewComment{
			ID:         "cid-from-client",
			AuthorID:   "u1",
			AuthorName: "Alice",
			Content:    "hello",
		},
	}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/documents/comments?path=doc.md", bytes.NewReader(buf))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("status: got %d, body %s", w.Code, w.Body.String())
	}
	if p.lastCreateReq == nil {
		t.Fatalf("create req not captured")
	}
	if p.lastCreateReq.ID != "tid-from-client" {
		t.Errorf("thread id dropped: got %q", p.lastCreateReq.ID)
	}
	if p.lastCreateReq.Comment == nil || p.lastCreateReq.Comment.ID != "cid-from-client" {
		t.Errorf("comment id dropped: %+v", p.lastCreateReq.Comment)
	}
}

// errorProvider simulates a provider that rejects duplicate IDs.
type errorProvider struct {
	commentsCoreProvider
	createErr error
}

func (p *errorProvider) CreateCommentThread(_ context.Context, _ string, req *CreateCommentThreadRequest) (*CommentThread, error) {
	p.lastCreateReq = req
	if p.createErr != nil {
		return nil, p.createErr
	}
	return p.createResp, nil
}

func TestCommentsHandler_CreateThread_ConflictMapsTo409(t *testing.T) {
	p := &errorProvider{createErr: ErrCommentThreadExists}
	h := NewCommentsHTTPHandler(p)

	body := CreateCommentThreadRequest{
		ID:     "duplicate-id",
		Anchor: CommentAnchor{Start: 0, End: 3, QuotedText: "abc"},
	}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/documents/comments?path=doc.md", bytes.NewReader(buf))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409 for ErrCommentThreadExists, got %d", w.Code)
	}
}

func TestCommentsHandler_CreateThread_MissingIDReturns400(t *testing.T) {
	// Client IDs are mandatory: the Y.Map key IS the canonical thread
	// id, so omitting it is a client bug the server must surface.
	p := &errorProvider{createErr: ErrCommentIDRequired}
	h := NewCommentsHTTPHandler(p)

	body := CreateCommentThreadRequest{
		Anchor: CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
	}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/documents/comments?path=doc.md", bytes.NewReader(buf))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for ErrCommentIDRequired, got %d", w.Code)
	}
}

func TestCommentsHandler_AddReply_ClientProvidedID(t *testing.T) {
	p := &commentsCoreProvider{replyResp: &Comment{ID: "cid-from-client"}}
	h := NewCommentsHTTPHandler(p)

	body := AddReplyRequest{
		ID:         "cid-from-client",
		AuthorID:   "u1",
		AuthorName: "Alice",
		Content:    "reply",
	}
	buf, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/documents/comments/t1/replies?path=doc.md", bytes.NewReader(buf))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("status: got %d, body %s", w.Code, w.Body.String())
	}
	if p.lastReplyReq == nil || p.lastReplyReq.ID != "cid-from-client" {
		t.Errorf("reply id dropped: %+v", p.lastReplyReq)
	}
}

func TestCommentsHandler_GetThread(t *testing.T) {
	now := time.Now()
	p := &commentsCoreProvider{
		getResp: &CommentThread{
			ID: "t1", Status: "open", CreatedAt: now,
			Anchor:   CommentAnchor{Start: 0, End: 5, QuotedText: "hello"},
			Comments: []Comment{{ID: "c1", Content: "first"}},
		},
	}
	h := NewCommentsHTTPHandler(p)

	req := httptest.NewRequest("GET", "/documents/comments/t1?path=doc.md", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d", w.Code)
	}
	var thread CommentThread
	if err := json.NewDecoder(w.Body).Decode(&thread); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if thread.ID != "t1" || len(thread.Comments) != 1 {
		t.Errorf("thread mismatch: %+v", thread)
	}
}

func TestCommentsHandler_GetThread_NotFound(t *testing.T) {
	h := NewCommentsHTTPHandler(&commentsCoreProvider{getResp: nil})

	req := httptest.NewRequest("GET", "/documents/comments/missing?path=doc.md", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status: got %d want 404", w.Code)
	}
}

func TestCommentsHandler_AddReply(t *testing.T) {
	p := &commentsCoreProvider{replyResp: &Comment{ID: "c2"}}
	h := NewCommentsHTTPHandler(p)

	body := AddReplyRequest{AuthorID: "u1", AuthorName: "Alice", Content: "yes"}
	buf, _ := json.Marshal(body)

	req := httptest.NewRequest("POST", "/documents/comments/t1/replies?path=doc.md", bytes.NewReader(buf))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("status: got %d", w.Code)
	}
	if p.lastReplyReq == nil || p.lastReplyReq.Content != "yes" {
		t.Errorf("reply req not captured: %+v", p.lastReplyReq)
	}
}

func TestCommentsHandler_UpdateThreadStatus(t *testing.T) {
	p := &commentsCoreProvider{statusResp: &CommentThread{ID: "t1", Status: "resolved"}}
	h := NewCommentsHTTPHandler(p)

	body := UpdateThreadStatusRequest{Status: "resolved", ResolvedBy: "u1"}
	buf, _ := json.Marshal(body)

	req := httptest.NewRequest("PATCH", "/documents/comments/t1?path=doc.md", bytes.NewReader(buf))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: got %d", w.Code)
	}
	if p.lastStatusReq == nil || p.lastStatusReq.Status != "resolved" {
		t.Errorf("status req not captured: %+v", p.lastStatusReq)
	}
}

func TestCommentsHandler_DeleteThread(t *testing.T) {
	p := &commentsCoreProvider{}
	h := NewCommentsHTTPHandler(p)

	req := httptest.NewRequest("DELETE", "/documents/comments/t9?path=doc.md", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("status: got %d want 204", w.Code)
	}
	if p.lastDeletedID != "t9" {
		t.Errorf("delete id: got %q want t9", p.lastDeletedID)
	}
}

// --- Conditional route gating ---

func TestCommentsHandler_OptionalRoutesNotRegistered_WhenUnimplemented(t *testing.T) {
	h := NewCommentsHTTPHandler(&commentsCoreProvider{})

	// Reactions, suggestions, mentions, poll, and per-comment edit/delete
	// should all 404 when the provider doesn't implement them.
	tests := []struct {
		name   string
		method string
		url    string
	}{
		{"add_reaction", "POST", "/documents/comments/t1/reactions?path=doc.md"},
		{"remove_reaction", "DELETE", "/documents/comments/t1/reactions?path=doc.md"},
		{"decide_suggestion", "POST", "/documents/comments/t1/suggestion/decision?path=doc.md"},
		{"search_mentions", "GET", "/documents/comments/mentions/search?path=doc.md&q=ali"},
		{"poll_changes", "GET", "/documents/comments/poll?path=doc.md&since=2020-01-01T00:00:00Z"},
		{"update_comment", "PATCH", "/documents/comments/t1/comments/c1?path=doc.md"},
		{"delete_comment", "DELETE", "/documents/comments/t1/comments/c1?path=doc.md"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var body []byte
			if tc.method == "POST" || tc.method == "PATCH" {
				body = []byte("{}")
			}
			req := httptest.NewRequest(tc.method, tc.url, bytes.NewReader(body))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != http.StatusNotFound && w.Code != http.StatusMethodNotAllowed {
				t.Errorf("%s: expected 404/405, got %d", tc.name, w.Code)
			}
		})
	}
}

func TestCommentsHandler_OptionalRoutesRegistered_WhenImplemented(t *testing.T) {
	p := &fullProvider{}
	h := NewCommentsHTTPHandler(p)

	// Reactions
	reactBody, _ := json.Marshal(ReactionRequest{UserID: "u1", UserName: "Alice", Emoji: "thumbsup"})
	req := httptest.NewRequest("POST", "/documents/comments/t1/reactions?path=doc.md", bytes.NewReader(reactBody))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Errorf("add reaction: got %d", w.Code)
	}
	if !p.addReactionCalled {
		t.Errorf("AddReaction not called")
	}

	req = httptest.NewRequest("DELETE", "/documents/comments/t1/reactions?path=doc.md", bytes.NewReader(reactBody))
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Errorf("remove reaction: got %d", w.Code)
	}
	if !p.removeReactionCalled {
		t.Errorf("RemoveReaction not called")
	}

	// Suggestion decision
	decideBody, _ := json.Marshal(SuggestionDecisionRequest{Decision: "accepted", DecidedBy: "u2"})
	req = httptest.NewRequest("POST", "/documents/comments/t1/suggestion/decision?path=doc.md", bytes.NewReader(decideBody))
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("decide: got %d", w.Code)
	}
	if !p.decideCalled {
		t.Errorf("DecideSuggestion not called")
	}

	// Mentions search
	req = httptest.NewRequest("GET", "/documents/comments/mentions/search?path=doc.md&q=ali&limit=5", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("search: got %d", w.Code)
	}
	if !p.searchCalled {
		t.Errorf("SearchMentions not called")
	}
	var searchBody struct {
		Candidates []MentionCandidate `json:"candidates"`
	}
	if err := json.NewDecoder(w.Body).Decode(&searchBody); err != nil {
		t.Fatalf("decode search: %v", err)
	}
	if len(searchBody.Candidates) != 1 || searchBody.Candidates[0].UserID != "u1" {
		t.Errorf("search result: %+v", searchBody.Candidates)
	}

	// Poll
	req = httptest.NewRequest("GET", "/documents/comments/poll?path=doc.md&since=2020-01-01T00:00:00Z", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("poll: got %d", w.Code)
	}
	if !p.pollCalled {
		t.Errorf("PollCommentChanges not called")
	}

	// Per-comment edit/delete
	editBody, _ := json.Marshal(UpdateCommentRequest{Content: "new"})
	req = httptest.NewRequest("PATCH", "/documents/comments/t1/comments/c1?path=doc.md", bytes.NewReader(editBody))
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("edit: got %d", w.Code)
	}
	if !p.updateCommentCalled {
		t.Errorf("UpdateComment not called")
	}

	req = httptest.NewRequest("DELETE", "/documents/comments/t1/comments/c1?path=doc.md", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusNoContent {
		t.Errorf("delete comment: got %d", w.Code)
	}
	if !p.deleteCommentCalled {
		t.Errorf("DeleteComment not called")
	}
}

func TestCommentsHandler_YjsPayloadIsOpaque(t *testing.T) {
	// Sanity: creating a thread with a suggestion, then retrieving it
	// via a stubbed GetCommentThread, must roundtrip the yjs_payload
	// bit-for-bit. The handler must not touch it.
	wantPayload := "BQABAQECAwQFBgcI"
	p := &commentsCoreProvider{
		createResp: &CommentThread{
			ID:         "t1",
			Status:     "open",
			Suggestion: &Suggestion{YjsPayload: wantPayload, Status: "pending"},
		},
		getResp: &CommentThread{
			ID:         "t1",
			Status:     "open",
			Suggestion: &Suggestion{YjsPayload: wantPayload, Status: "pending"},
		},
	}
	h := NewCommentsHTTPHandler(p)

	// create
	createBody, _ := json.Marshal(CreateCommentThreadRequest{
		Anchor:     CommentAnchor{Start: 0, End: 1, QuotedText: "a"},
		Suggestion: &Suggestion{YjsPayload: wantPayload, Status: "pending"},
	})
	req := httptest.NewRequest("POST", "/documents/comments?path=doc.md", bytes.NewReader(createBody))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("create status: %d", w.Code)
	}
	var created CommentThread
	if err := json.NewDecoder(w.Body).Decode(&created); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if created.Suggestion == nil || created.Suggestion.YjsPayload != wantPayload {
		t.Errorf("create roundtrip mangled payload: %q", created.Suggestion.YjsPayload)
	}

	// get
	req = httptest.NewRequest("GET", "/documents/comments/t1?path=doc.md", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var got CommentThread
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatalf("decode get: %v", err)
	}
	if got.Suggestion == nil || got.Suggestion.YjsPayload != wantPayload {
		t.Errorf("get roundtrip mangled payload: %q", got.Suggestion.YjsPayload)
	}
}
