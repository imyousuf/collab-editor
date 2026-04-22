package main

import (
	"context"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/imyousuf/collab-editor/internal/storagedemo"
)

func main() {
	configPath := flag.String("config", "", "path to config file")
	flag.Parse()

	cfg, err := storagedemo.LoadConfig(*configPath)
	if err != nil {
		slog.Error("failed to load config", "err", err)
		os.Exit(1)
	}

	var handler slog.Handler
	if cfg.Log.Format == "json" {
		handler = slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parseLevel(cfg.Log.Level)})
	} else {
		handler = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: parseLevel(cfg.Log.Level)})
	}
	slog.SetDefault(slog.New(handler))

	store, err := storagedemo.NewFileStore(cfg.Storage.BaseDir)
	if err != nil {
		slog.Error("failed to create file store", "err", err)
		os.Exit(1)
	}

	mentionDir := storagedemo.NewMentionDirectory(storagedemo.ToMentionCandidates(cfg.Comments.Users))
	commentStore, err := storagedemo.NewCommentStore(cfg.Storage.BaseDir, mentionDir)
	if err != nil {
		slog.Error("failed to create comment store", "err", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Addr:         cfg.Server.Addr,
		Handler:      storagedemo.NewServer(store, commentStore, cfg.Auth.Token),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("storage provider starting", "addr", cfg.Server.Addr, "base_dir", cfg.Storage.BaseDir)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server failed", "err", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("shutting down storage provider")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("shutdown error", "err", err)
	}
}

func parseLevel(s string) slog.Level {
	switch s {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
