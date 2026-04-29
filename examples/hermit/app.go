package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx context.Context
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

type FileResult struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Content  string `json:"content"`
	MimeType string `json:"mimeType"`
}

var fileFilters = []runtime.FileFilter{
	{DisplayName: "Text & Markdown", Pattern: "*.md;*.markdown;*.txt;*.html;*.htm"},
	{DisplayName: "Markdown", Pattern: "*.md;*.markdown"},
	{DisplayName: "HTML", Pattern: "*.html;*.htm"},
	{DisplayName: "Plain text", Pattern: "*.txt"},
	{DisplayName: "All files", Pattern: "*.*"},
}

// OpenFile shows a file picker, reads the chosen file, and returns its
// contents. An empty Path on the result means the user cancelled.
func (a *App) OpenFile() (*FileResult, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   "Open file",
		Filters: fileFilters,
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return &FileResult{}, nil
	}
	return readFile(path)
}

// LoadFile reads a known path. Used for "open recent" and reopening the
// last-edited file at startup.
func (a *App) LoadFile(path string) (*FileResult, error) {
	if path == "" {
		return nil, errors.New("path is empty")
	}
	return readFile(path)
}

// SaveFile writes content to an existing path. Errors if path is empty —
// the caller should fall back to SaveFileAs in that case.
func (a *App) SaveFile(path, content string) error {
	if path == "" {
		return errors.New("path is empty; use SaveFileAs")
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

// SaveFileAs prompts for a path then writes content. An empty returned
// Path means the user cancelled the dialog.
func (a *App) SaveFileAs(suggestedName, content string) (*FileResult, error) {
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Save as",
		DefaultFilename: suggestedName,
		Filters:         fileFilters,
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return &FileResult{}, nil
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return nil, err
	}
	return &FileResult{
		Path:     path,
		Name:     filepath.Base(path),
		Content:  content,
		MimeType: mimeForPath(path),
	}, nil
}

func readFile(path string) (*FileResult, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return &FileResult{
		Path:     path,
		Name:     filepath.Base(path),
		Content:  string(data),
		MimeType: mimeForPath(path),
	}, nil
}

func mimeForPath(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".md", ".markdown":
		return "text/markdown"
	case ".html", ".htm":
		return "text/html"
	default:
		return "text/plain"
	}
}
