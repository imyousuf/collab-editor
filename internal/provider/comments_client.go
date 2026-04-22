package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

// CommentsClient is the HTTP client the relay uses to talk to the
// Comments Provider. It is intentionally independent from Client (the
// Storage Provider) — they may live at different URLs with different
// auth tokens.
type CommentsClient struct {
	baseURL    string
	httpClient *http.Client
	authToken  string
}

// CommentsClientConfig configures a CommentsClient.
type CommentsClientConfig struct {
	BaseURL   string
	AuthToken string
	Timeout   time.Duration
}

func NewCommentsClient(cfg CommentsClientConfig) *CommentsClient {
	timeout := cfg.Timeout
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	return &CommentsClient{
		baseURL:   cfg.BaseURL,
		authToken: cfg.AuthToken,
		httpClient: &http.Client{
			Timeout: timeout,
			Transport: &http.Transport{
				MaxIdleConns:        50,
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

// Capabilities fetches the feature matrix from the Comments Provider.
func (c *CommentsClient) Capabilities(ctx context.Context) (*spi.CommentsCapabilities, error) {
	resp, err := c.doJSON(ctx, http.MethodGet, "/capabilities", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var caps spi.CommentsCapabilities
	if err := json.NewDecoder(resp.Body).Decode(&caps); err != nil {
		return nil, fmt.Errorf("decode capabilities: %w", err)
	}
	return &caps, nil
}

func (c *CommentsClient) ListCommentThreads(ctx context.Context, documentID string) ([]spi.CommentThreadListEntry, error) {
	resp, err := c.doJSON(ctx, http.MethodGet,
		"/documents/comments?path="+url.QueryEscape(documentID), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var body struct {
		Threads []spi.CommentThreadListEntry `json:"threads"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode threads list: %w", err)
	}
	return body.Threads, nil
}

func (c *CommentsClient) GetCommentThread(ctx context.Context, documentID, threadID string) (*spi.CommentThread, error) {
	resp, err := c.doJSON(ctx, http.MethodGet,
		fmt.Sprintf("/documents/comments/%s?path=%s", url.PathEscape(threadID), url.QueryEscape(documentID)),
		nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	var thread spi.CommentThread
	if err := json.NewDecoder(resp.Body).Decode(&thread); err != nil {
		return nil, fmt.Errorf("decode thread: %w", err)
	}
	return &thread, nil
}

func (c *CommentsClient) CreateCommentThread(ctx context.Context, documentID string, req *spi.CreateCommentThreadRequest) (*spi.CommentThread, error) {
	resp, err := c.doJSON(ctx, http.MethodPost,
		"/documents/comments?path="+url.QueryEscape(documentID), req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return nil, unexpectedStatus(resp, "create thread")
	}
	var thread spi.CommentThread
	if err := json.NewDecoder(resp.Body).Decode(&thread); err != nil {
		return nil, fmt.Errorf("decode created thread: %w", err)
	}
	return &thread, nil
}

func (c *CommentsClient) AddReply(ctx context.Context, documentID, threadID string, req *spi.AddReplyRequest) (*spi.Comment, error) {
	resp, err := c.doJSON(ctx, http.MethodPost,
		fmt.Sprintf("/documents/comments/%s/replies?path=%s", url.PathEscape(threadID), url.QueryEscape(documentID)),
		req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return nil, unexpectedStatus(resp, "add reply")
	}
	var comment spi.Comment
	if err := json.NewDecoder(resp.Body).Decode(&comment); err != nil {
		return nil, fmt.Errorf("decode reply: %w", err)
	}
	return &comment, nil
}

func (c *CommentsClient) UpdateThreadStatus(ctx context.Context, documentID, threadID string, req *spi.UpdateThreadStatusRequest) (*spi.CommentThread, error) {
	resp, err := c.doJSON(ctx, http.MethodPatch,
		fmt.Sprintf("/documents/comments/%s?path=%s", url.PathEscape(threadID), url.QueryEscape(documentID)),
		req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var thread spi.CommentThread
	if err := json.NewDecoder(resp.Body).Decode(&thread); err != nil {
		return nil, fmt.Errorf("decode thread status: %w", err)
	}
	return &thread, nil
}

func (c *CommentsClient) DeleteCommentThread(ctx context.Context, documentID, threadID string) error {
	resp, err := c.doJSON(ctx, http.MethodDelete,
		fmt.Sprintf("/documents/comments/%s?path=%s", url.PathEscape(threadID), url.QueryEscape(documentID)),
		nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return errors.New("unexpected delete status: " + strconv.Itoa(resp.StatusCode))
	}
	return nil
}

func (c *CommentsClient) UpdateComment(ctx context.Context, documentID, threadID, commentID string, req *spi.UpdateCommentRequest) (*spi.Comment, error) {
	resp, err := c.doJSON(ctx, http.MethodPatch,
		fmt.Sprintf("/documents/comments/%s/comments/%s?path=%s",
			url.PathEscape(threadID), url.PathEscape(commentID), url.QueryEscape(documentID)),
		req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var comment spi.Comment
	if err := json.NewDecoder(resp.Body).Decode(&comment); err != nil {
		return nil, fmt.Errorf("decode updated comment: %w", err)
	}
	return &comment, nil
}

func (c *CommentsClient) DeleteComment(ctx context.Context, documentID, threadID, commentID string) error {
	resp, err := c.doJSON(ctx, http.MethodDelete,
		fmt.Sprintf("/documents/comments/%s/comments/%s?path=%s",
			url.PathEscape(threadID), url.PathEscape(commentID), url.QueryEscape(documentID)),
		nil)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

func (c *CommentsClient) AddReaction(ctx context.Context, documentID, threadID string, req *spi.ReactionRequest) error {
	resp, err := c.doJSON(ctx, http.MethodPost,
		fmt.Sprintf("/documents/comments/%s/reactions?path=%s", url.PathEscape(threadID), url.QueryEscape(documentID)),
		req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

func (c *CommentsClient) RemoveReaction(ctx context.Context, documentID, threadID string, req *spi.ReactionRequest) error {
	resp, err := c.doJSONWithBody(ctx, http.MethodDelete,
		fmt.Sprintf("/documents/comments/%s/reactions?path=%s", url.PathEscape(threadID), url.QueryEscape(documentID)),
		req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

func (c *CommentsClient) DecideSuggestion(ctx context.Context, documentID, threadID string, req *spi.SuggestionDecisionRequest) (*spi.CommentThread, error) {
	resp, err := c.doJSON(ctx, http.MethodPost,
		fmt.Sprintf("/documents/comments/%s/suggestion/decision?path=%s",
			url.PathEscape(threadID), url.QueryEscape(documentID)),
		req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var thread spi.CommentThread
	if err := json.NewDecoder(resp.Body).Decode(&thread); err != nil {
		return nil, fmt.Errorf("decode decide response: %w", err)
	}
	return &thread, nil
}

func (c *CommentsClient) SearchMentions(ctx context.Context, documentID, query string, limit int) ([]spi.MentionCandidate, error) {
	if limit <= 0 {
		limit = 10
	}
	resp, err := c.doJSON(ctx, http.MethodGet,
		fmt.Sprintf("/documents/comments/mentions/search?path=%s&q=%s&limit=%d",
			url.QueryEscape(documentID), url.QueryEscape(query), limit),
		nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var body struct {
		Candidates []spi.MentionCandidate `json:"candidates"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode mentions search: %w", err)
	}
	return body.Candidates, nil
}

func (c *CommentsClient) PollCommentChanges(ctx context.Context, documentID, since string) (*spi.CommentPollResponse, error) {
	resp, err := c.doJSON(ctx, http.MethodGet,
		fmt.Sprintf("/documents/comments/poll?path=%s&since=%s",
			url.QueryEscape(documentID), url.QueryEscape(since)),
		nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var r spi.CommentPollResponse
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, fmt.Errorf("decode poll: %w", err)
	}
	return &r, nil
}

// --- Internals ---

func (c *CommentsClient) doJSON(ctx context.Context, method, path string, body any) (*http.Response, error) {
	return c.doJSONWithBody(ctx, method, path, body)
}

func (c *CommentsClient) doJSONWithBody(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		var buf bytes.Buffer
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return nil, err
		}
		reader = &buf
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.authToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.authToken)
	}
	return c.httpClient.Do(req)
}

func unexpectedStatus(resp *http.Response, op string) error {
	return fmt.Errorf("unexpected status %d from comments provider on %s", resp.StatusCode, op)
}
