package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/imyousuf/collab-editor/internal/provider"
	"github.com/imyousuf/collab-editor/pkg/spi"
)

// registerCommentsProxy wires /api/documents/comments/* onto the given chi
// router. When ``client`` is nil the routes reply with 503 so the frontend
// can tell "configured but failing" from "not configured".
func registerCommentsProxy(r chi.Router, client *provider.CommentsClient) {
	r.Route("/documents/comments", func(r chi.Router) {
		// Mentions search lives at /documents/comments/mentions/search, so
		// it must be registered before {threadId} routes to avoid capturing
		// "mentions" as a thread id.
		r.Get("/mentions/search", func(w http.ResponseWriter, req *http.Request) {
			if client == nil {
				writeProxyError(w, http.StatusServiceUnavailable, "comments not configured")
				return
			}
			path := req.URL.Query().Get("path")
			if path == "" {
				writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			query := req.URL.Query().Get("q")
			limit, _ := strconv.Atoi(req.URL.Query().Get("limit"))
			candidates, err := client.SearchMentions(req.Context(), path, query, limit)
			if err != nil {
				writeProxyError(w, http.StatusBadGateway, err.Error())
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"candidates": candidates})
		})

		r.Get("/poll", func(w http.ResponseWriter, req *http.Request) {
			if client == nil {
				writeProxyError(w, http.StatusServiceUnavailable, "comments not configured")
				return
			}
			path := req.URL.Query().Get("path")
			if path == "" {
				writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			since := req.URL.Query().Get("since")
			resp, err := client.PollCommentChanges(req.Context(), path, since)
			if err != nil {
				writeProxyError(w, http.StatusBadGateway, err.Error())
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(resp)
		})

		r.Get("/", func(w http.ResponseWriter, req *http.Request) {
			if client == nil {
				writeProxyError(w, http.StatusServiceUnavailable, "comments not configured")
				return
			}
			path := req.URL.Query().Get("path")
			if path == "" {
				writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			threads, err := client.ListCommentThreads(req.Context(), path)
			if err != nil {
				writeProxyError(w, http.StatusBadGateway, err.Error())
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"threads": threads})
		})

		r.Post("/", func(w http.ResponseWriter, req *http.Request) {
			if client == nil {
				writeProxyError(w, http.StatusServiceUnavailable, "comments not configured")
				return
			}
			path := req.URL.Query().Get("path")
			if path == "" {
				writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
				return
			}
			var body spi.CreateCommentThreadRequest
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				writeProxyError(w, http.StatusBadRequest, "invalid request body")
				return
			}
			thread, err := client.CreateCommentThread(req.Context(), path, &body)
			if err != nil {
				writeProxyError(w, http.StatusBadGateway, err.Error())
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(thread)
		})

		r.Route("/{threadID}", func(r chi.Router) {
			r.Get("/", func(w http.ResponseWriter, req *http.Request) {
				if client == nil {
					writeProxyError(w, http.StatusServiceUnavailable, "comments not configured")
					return
				}
				path := req.URL.Query().Get("path")
				if path == "" {
					writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
					return
				}
				thread, err := client.GetCommentThread(req.Context(), path, chi.URLParam(req, "threadID"))
				if err != nil {
					writeProxyError(w, http.StatusBadGateway, err.Error())
					return
				}
				if thread == nil {
					writeProxyError(w, http.StatusNotFound, "thread not found")
					return
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(thread)
			})

			r.Post("/replies", func(w http.ResponseWriter, req *http.Request) {
				if client == nil {
					writeProxyError(w, http.StatusServiceUnavailable, "comments not configured")
					return
				}
				path := req.URL.Query().Get("path")
				if path == "" {
					writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
					return
				}
				var body spi.AddReplyRequest
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					writeProxyError(w, http.StatusBadRequest, "invalid request body")
					return
				}
				comment, err := client.AddReply(req.Context(), path, chi.URLParam(req, "threadID"), &body)
				if err != nil {
					writeProxyError(w, http.StatusBadGateway, err.Error())
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(comment)
			})

			r.Patch("/", func(w http.ResponseWriter, req *http.Request) {
				if client == nil {
					writeProxyError(w, http.StatusServiceUnavailable, "comments not configured")
					return
				}
				path := req.URL.Query().Get("path")
				if path == "" {
					writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
					return
				}
				var body spi.UpdateThreadStatusRequest
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					writeProxyError(w, http.StatusBadRequest, "invalid request body")
					return
				}
				thread, err := client.UpdateThreadStatus(req.Context(), path, chi.URLParam(req, "threadID"), &body)
				if err != nil {
					writeProxyError(w, http.StatusBadGateway, err.Error())
					return
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(thread)
			})

			r.Delete("/", func(w http.ResponseWriter, req *http.Request) {
				if client == nil {
					writeProxyError(w, http.StatusServiceUnavailable, "comments not configured")
					return
				}
				path := req.URL.Query().Get("path")
				if path == "" {
					writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
					return
				}
				if err := client.DeleteCommentThread(req.Context(), path, chi.URLParam(req, "threadID")); err != nil {
					writeProxyError(w, http.StatusBadGateway, err.Error())
					return
				}
				w.WriteHeader(http.StatusNoContent)
			})

			r.Patch("/comments/{commentID}", func(w http.ResponseWriter, req *http.Request) {
				if client == nil {
					writeProxyError(w, http.StatusServiceUnavailable, "comments not configured")
					return
				}
				path := req.URL.Query().Get("path")
				if path == "" {
					writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
					return
				}
				var body spi.UpdateCommentRequest
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					writeProxyError(w, http.StatusBadRequest, "invalid request body")
					return
				}
				comment, err := client.UpdateComment(
					req.Context(), path,
					chi.URLParam(req, "threadID"),
					chi.URLParam(req, "commentID"),
					&body,
				)
				if err != nil {
					writeProxyError(w, http.StatusBadGateway, err.Error())
					return
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(comment)
			})

			r.Delete("/comments/{commentID}", func(w http.ResponseWriter, req *http.Request) {
				if client == nil {
					writeProxyError(w, http.StatusServiceUnavailable, "comments not configured")
					return
				}
				path := req.URL.Query().Get("path")
				if path == "" {
					writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
					return
				}
				if err := client.DeleteComment(
					req.Context(), path,
					chi.URLParam(req, "threadID"),
					chi.URLParam(req, "commentID"),
				); err != nil {
					writeProxyError(w, http.StatusBadGateway, err.Error())
					return
				}
				w.WriteHeader(http.StatusNoContent)
			})

			r.Post("/reactions", func(w http.ResponseWriter, req *http.Request) {
				if client == nil {
					writeProxyError(w, http.StatusServiceUnavailable, "comments not configured")
					return
				}
				path := req.URL.Query().Get("path")
				if path == "" {
					writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
					return
				}
				var body spi.ReactionRequest
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					writeProxyError(w, http.StatusBadRequest, "invalid request body")
					return
				}
				if err := client.AddReaction(req.Context(), path, chi.URLParam(req, "threadID"), &body); err != nil {
					writeProxyError(w, http.StatusBadGateway, err.Error())
					return
				}
				w.WriteHeader(http.StatusNoContent)
			})

			r.Delete("/reactions", func(w http.ResponseWriter, req *http.Request) {
				if client == nil {
					writeProxyError(w, http.StatusServiceUnavailable, "comments not configured")
					return
				}
				path := req.URL.Query().Get("path")
				if path == "" {
					writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
					return
				}
				var body spi.ReactionRequest
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					writeProxyError(w, http.StatusBadRequest, "invalid request body")
					return
				}
				if err := client.RemoveReaction(req.Context(), path, chi.URLParam(req, "threadID"), &body); err != nil {
					writeProxyError(w, http.StatusBadGateway, err.Error())
					return
				}
				w.WriteHeader(http.StatusNoContent)
			})

			r.Post("/suggestion/decision", func(w http.ResponseWriter, req *http.Request) {
				if client == nil {
					writeProxyError(w, http.StatusServiceUnavailable, "comments not configured")
					return
				}
				path := req.URL.Query().Get("path")
				if path == "" {
					writeProxyError(w, http.StatusBadRequest, "missing 'path' query parameter")
					return
				}
				var body spi.SuggestionDecisionRequest
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					writeProxyError(w, http.StatusBadRequest, "invalid request body")
					return
				}
				thread, err := client.DecideSuggestion(req.Context(), path, chi.URLParam(req, "threadID"), &body)
				if err != nil {
					writeProxyError(w, http.StatusBadGateway, err.Error())
					return
				}
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode(thread)
			})
		})
	})
}
