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
		fmt.Sprintf("/documents/%s/load", url.PathEscape(documentID)),
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
		fmt.Sprintf("/documents/%s/updates", url.PathEscape(documentID)),
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
		fmt.Sprintf("/documents/%s", url.PathEscape(documentID)),
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
		fmt.Sprintf("/documents/%s/compact", url.PathEscape(documentID)),
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
