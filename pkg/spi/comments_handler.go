package spi

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// NewCommentsHTTPHandler returns an http.Handler that routes requests to a
// CommentsProvider. It is plain REST + JSON — unlike Storage's NewHTTPHandler,
// no ProviderProcessor / YDocEngine is involved. A suggestion's YjsPayload
// field flows through opaquely.
//
// Mounts the following endpoints:
//
//	GET    /capabilities
//	GET    /documents/comments?path={id}
//	GET    /documents/comments/{threadId}?path={id}
//	POST   /documents/comments?path={id}
//	POST   /documents/comments/{threadId}/replies?path={id}
//	PATCH  /documents/comments/{threadId}?path={id}
//	DELETE /documents/comments/{threadId}?path={id}
//	PATCH  /documents/comments/{threadId}/comments/{commentId}?path={id}   (if OptionalCommentEdit)
//	DELETE /documents/comments/{threadId}/comments/{commentId}?path={id}   (if OptionalCommentEdit)
//	POST   /documents/comments/{threadId}/reactions?path={id}              (if OptionalReactions)
//	DELETE /documents/comments/{threadId}/reactions?path={id}              (if OptionalReactions)
//	POST   /documents/comments/{threadId}/suggestion/decision?path={id}    (if OptionalSuggestions)
//	GET    /documents/comments/mentions/search?path={id}&q={q}&limit={n}   (if OptionalMentions)
//	GET    /documents/comments/poll?path={id}&since={ts}                   (if OptionalCommentPoll)
func NewCommentsHTTPHandler(p CommentsProvider) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /capabilities", func(w http.ResponseWriter, r *http.Request) {
		caps, err := p.Capabilities(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, caps)
	})

	mux.HandleFunc("GET /documents/comments", func(w http.ResponseWriter, r *http.Request) {
		documentID := r.URL.Query().Get("path")
		if documentID == "" {
			writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
			return
		}
		threads, err := p.ListCommentThreads(r.Context(), documentID)
		if err != nil {
			slog.Error("comments list failed", "doc", documentID, "err", err)
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"threads": threads})
	})

	mux.HandleFunc("POST /documents/comments", func(w http.ResponseWriter, r *http.Request) {
		documentID := r.URL.Query().Get("path")
		if documentID == "" {
			writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
			return
		}
		var req CreateCommentThreadRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
			return
		}
		thread, err := p.CreateCommentThread(r.Context(), documentID, &req)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, thread)
	})

	// Dedicated helpers to pull path segments out of the URL. We avoid
	// http.ServeMux path patterns with placeholders beyond the first
	// component to stay compatible with how the rest of the SDK routes.
	// Routes that include a {threadId} in the path are keyed off the URL
	// suffix and verified by a tiny parser below.

	// Mentions search lives under a fixed suffix so it is matched before
	// the generic {threadId} routes.
	if mp, ok := p.(OptionalMentions); ok {
		mux.HandleFunc("GET /documents/comments/mentions/search", func(w http.ResponseWriter, r *http.Request) {
			documentID := r.URL.Query().Get("path")
			if documentID == "" {
				writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			query := r.URL.Query().Get("q")
			limit := parseIntQuery(r.URL.Query().Get("limit"), 10)
			candidates, err := mp.SearchMentions(r.Context(), documentID, query, limit)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"candidates": candidates})
		})
	}

	if pp, ok := p.(OptionalCommentPoll); ok {
		mux.HandleFunc("GET /documents/comments/poll", func(w http.ResponseWriter, r *http.Request) {
			documentID := r.URL.Query().Get("path")
			if documentID == "" {
				writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			since := r.URL.Query().Get("since")
			resp, err := pp.PollCommentChanges(r.Context(), documentID, since)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, resp)
		})
	}

	editable, editOk := p.(OptionalCommentEdit)
	reactable, reactOk := p.(OptionalReactions)
	suggestable, suggestOk := p.(OptionalSuggestions)

	// Thread-scoped routes. http.ServeMux in Go 1.22+ supports path
	// placeholders, so we mount each concrete path here. The verb+suffix
	// dispatch logic stays simple and linear.
	mux.HandleFunc("GET /documents/comments/{threadId}", func(w http.ResponseWriter, r *http.Request) {
		documentID := r.URL.Query().Get("path")
		if documentID == "" {
			writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
			return
		}
		threadID := r.PathValue("threadId")
		thread, err := p.GetCommentThread(r.Context(), documentID, threadID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if thread == nil {
			writeError(w, http.StatusNotFound, "thread not found")
			return
		}
		writeJSON(w, http.StatusOK, thread)
	})

	mux.HandleFunc("POST /documents/comments/{threadId}/replies", func(w http.ResponseWriter, r *http.Request) {
		documentID := r.URL.Query().Get("path")
		if documentID == "" {
			writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
			return
		}
		threadID := r.PathValue("threadId")
		var req AddReplyRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
			return
		}
		comment, err := p.AddReply(r.Context(), documentID, threadID, &req)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, comment)
	})

	mux.HandleFunc("PATCH /documents/comments/{threadId}", func(w http.ResponseWriter, r *http.Request) {
		documentID := r.URL.Query().Get("path")
		if documentID == "" {
			writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
			return
		}
		threadID := r.PathValue("threadId")
		var req UpdateThreadStatusRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
			return
		}
		thread, err := p.UpdateThreadStatus(r.Context(), documentID, threadID, &req)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, thread)
	})

	mux.HandleFunc("DELETE /documents/comments/{threadId}", func(w http.ResponseWriter, r *http.Request) {
		documentID := r.URL.Query().Get("path")
		if documentID == "" {
			writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
			return
		}
		threadID := r.PathValue("threadId")
		if err := p.DeleteCommentThread(r.Context(), documentID, threadID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	if editOk {
		mux.HandleFunc("PATCH /documents/comments/{threadId}/comments/{commentId}", func(w http.ResponseWriter, r *http.Request) {
			documentID := r.URL.Query().Get("path")
			if documentID == "" {
				writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			threadID := r.PathValue("threadId")
			commentID := r.PathValue("commentId")
			var req UpdateCommentRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
				return
			}
			comment, err := editable.UpdateComment(r.Context(), documentID, threadID, commentID, &req)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, comment)
		})

		mux.HandleFunc("DELETE /documents/comments/{threadId}/comments/{commentId}", func(w http.ResponseWriter, r *http.Request) {
			documentID := r.URL.Query().Get("path")
			if documentID == "" {
				writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			threadID := r.PathValue("threadId")
			commentID := r.PathValue("commentId")
			if err := editable.DeleteComment(r.Context(), documentID, threadID, commentID); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
	}

	if reactOk {
		mux.HandleFunc("POST /documents/comments/{threadId}/reactions", func(w http.ResponseWriter, r *http.Request) {
			documentID := r.URL.Query().Get("path")
			if documentID == "" {
				writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			threadID := r.PathValue("threadId")
			var req ReactionRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
				return
			}
			if err := reactable.AddReaction(r.Context(), documentID, threadID, &req); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})

		mux.HandleFunc("DELETE /documents/comments/{threadId}/reactions", func(w http.ResponseWriter, r *http.Request) {
			documentID := r.URL.Query().Get("path")
			if documentID == "" {
				writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			threadID := r.PathValue("threadId")
			var req ReactionRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
				return
			}
			if err := reactable.RemoveReaction(r.Context(), documentID, threadID, &req); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
	}

	if suggestOk {
		mux.HandleFunc("POST /documents/comments/{threadId}/suggestion/decision", func(w http.ResponseWriter, r *http.Request) {
			documentID := r.URL.Query().Get("path")
			if documentID == "" {
				writeError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			threadID := r.PathValue("threadId")
			var req SuggestionDecisionRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
				return
			}
			thread, err := suggestable.DecideSuggestion(r.Context(), documentID, threadID, &req)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, thread)
		})
	}

	return mux
}

// parseIntQuery is a tiny helper for optional integer query parameters.
func parseIntQuery(s string, def int) int {
	if s == "" {
		return def
	}
	n := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	if n == 0 {
		return def
	}
	return n
}
