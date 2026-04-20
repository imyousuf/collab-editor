package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/imyousuf/collab-editor/pkg/spi"
)

// Client is the HTTP client for the storage provider SPI.
type Client struct {
	baseURL    string
	httpClient *http.Client
	authToken  string
}

type ClientConfig struct {
	BaseURL      string
	AuthToken    string
	LoadTimeout  time.Duration
	StoreTimeout time.Duration
}

func NewClient(cfg ClientConfig) *Client {
	return &Client{
		baseURL:   cfg.BaseURL,
		authToken: cfg.AuthToken,
		httpClient: &http.Client{
			Timeout: cfg.StoreTimeout,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 20,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

func (c *Client) Load(ctx context.Context, documentID string, stateVector string) (*spi.LoadResponse, error) {
	body := spi.LoadRequest{StateVector: stateVector}

	resp, err := c.doJSON(ctx, http.MethodPost,
		"/documents/load?path="+url.QueryEscape(documentID),
		body,
	)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusNoContent:
		return &spi.LoadResponse{}, nil
	case http.StatusOK:
		var result spi.LoadResponse
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return nil, fmt.Errorf("decoding load response: %w", err)
		}
		return &result, nil
	case http.StatusForbidden:
		return nil, spi.ErrForbidden
	default:
		return nil, fmt.Errorf("unexpected status %d from provider", resp.StatusCode)
	}
}

func (c *Client) Store(ctx context.Context, documentID string, updates []spi.UpdatePayload) (*spi.StoreResponse, error) {
	body := spi.StoreRequest{Updates: updates}

	resp, err := c.doJSON(ctx, http.MethodPost,
		"/documents/updates?path="+url.QueryEscape(documentID),
		body,
	)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusAccepted, http.StatusMultiStatus:
		var result spi.StoreResponse
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return nil, fmt.Errorf("decoding store response: %w", err)
		}
		return &result, nil
	default:
		return nil, fmt.Errorf("unexpected status %d from provider on store", resp.StatusCode)
	}
}

func (c *Client) Delete(ctx context.Context, documentID string) error {
	resp, err := c.doJSON(ctx, http.MethodDelete,
		"/documents?path="+url.QueryEscape(documentID),
		nil,
	)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("unexpected status %d from provider", resp.StatusCode)
	}
	return nil
}

func (c *Client) Compact(ctx context.Context, documentID string, req *spi.CompactRequest) (*spi.CompactResponse, error) {
	resp, err := c.doJSON(ctx, http.MethodPost,
		"/documents/compact?path="+url.QueryEscape(documentID),
		req,
	)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result spi.CompactResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decoding compact response: %w", err)
	}
	return &result, nil
}

func (c *Client) Health(ctx context.Context) (*spi.HealthResponse, error) {
	resp, err := c.doJSON(ctx, http.MethodGet, "/health", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result spi.HealthResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decoding health response: %w", err)
	}
	return &result, nil
}

// ListDocuments fetches the document list from the provider.
func (c *Client) ListDocuments(ctx context.Context) ([]spi.DocumentListEntry, error) {
	resp, err := c.doJSON(ctx, http.MethodGet, "/documents", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result struct {
		Documents []spi.DocumentListEntry `json:"documents"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decoding document list: %w", err)
	}
	return result.Documents, nil
}

// --- Version History ---

// ListVersions fetches version list from the provider.
func (c *Client) ListVersions(ctx context.Context, documentID string) ([]spi.VersionListEntry, error) {
	resp, err := c.doJSON(ctx, http.MethodGet,
		"/documents/versions?path="+url.QueryEscape(documentID), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result struct {
		Versions []spi.VersionListEntry `json:"versions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decoding versions list: %w", err)
	}
	return result.Versions, nil
}

// CreateVersion creates a new version on the provider.
func (c *Client) CreateVersion(ctx context.Context, documentID string, req *spi.CreateVersionRequest) (*spi.VersionListEntry, error) {
	resp, err := c.doJSON(ctx, http.MethodPost,
		"/documents/versions?path="+url.QueryEscape(documentID), req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("unexpected status %d from provider on create version", resp.StatusCode)
	}

	var result spi.VersionListEntry
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decoding create version response: %w", err)
	}
	return &result, nil
}

// GetVersion fetches a full version (with content and blame) from the provider.
func (c *Client) GetVersion(ctx context.Context, documentID string, versionID string) (*spi.VersionEntry, error) {
	resp, err := c.doJSON(ctx, http.MethodGet,
		"/documents/versions/detail?path="+url.QueryEscape(documentID)+"&version="+url.QueryEscape(versionID), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}

	var result spi.VersionEntry
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decoding version detail: %w", err)
	}
	return &result, nil
}

// --- Client Mappings ---

// GetClientMappings fetches client-ID-to-user mappings from the provider.
func (c *Client) GetClientMappings(ctx context.Context, documentID string) ([]spi.ClientUserMapping, error) {
	resp, err := c.doJSON(ctx, http.MethodGet,
		"/documents/clients?path="+url.QueryEscape(documentID), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result struct {
		Mappings []spi.ClientUserMapping `json:"mappings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decoding client mappings: %w", err)
	}
	return result.Mappings, nil
}

// StoreClientMappings stores client-ID-to-user mappings on the provider.
func (c *Client) StoreClientMappings(ctx context.Context, documentID string, mappings []spi.ClientUserMapping) error {
	body := struct {
		Mappings []spi.ClientUserMapping `json:"mappings"`
	}{Mappings: mappings}

	resp, err := c.doJSON(ctx, http.MethodPost,
		"/documents/clients?path="+url.QueryEscape(documentID), body)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

func (c *Client) doJSON(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return nil, err
		}
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, &buf)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	if c.authToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.authToken)
	}

	return c.httpClient.Do(req)
}
