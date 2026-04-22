package relay

import (
	"log/slog"
	"time"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/env"
	"github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/v2"
)

type Config struct {
	Server   ServerConfig   `koanf:"server"`
	GRPC     GRPCConfig     `koanf:"grpc"`
	Storage  StorageConfig  `koanf:"storage"`
	Comments CommentsConfig `koanf:"comments"`
	Room     RoomConfig     `koanf:"room"`
	Redis    RedisConfig    `koanf:"redis"`
	Metrics  MetricsConfig  `koanf:"metrics"`
	Log      LogConfig      `koanf:"log"`
}

// CommentsConfig configures the optional Comments Provider the relay
// proxies to. Omitting ProviderURL disables all /api/documents/comments/*
// proxy routes and surfaces "comments not available" to the frontend.
type CommentsConfig struct {
	ProviderURL string        `koanf:"provider_url"`
	AuthToken   string        `koanf:"auth_token"`
	Timeout     time.Duration `koanf:"timeout"`
}

type GRPCConfig struct {
	Enabled bool   `koanf:"enabled"`
	Addr    string `koanf:"addr"`
}

type RedisConfig struct {
	Enabled      bool          `koanf:"enabled"`
	URL          string        `koanf:"url"`
	Password     string        `koanf:"password"`
	DB           int           `koanf:"db"`
	PoolSize     int           `koanf:"pool_size"`
	FlushLockTTL time.Duration `koanf:"flush_lock_ttl"`
}

type ServerConfig struct {
	Addr            string        `koanf:"addr"`
	ReadTimeout     time.Duration `koanf:"read_timeout"`
	WriteTimeout    time.Duration `koanf:"write_timeout"`
	ShutdownTimeout time.Duration `koanf:"shutdown_timeout"`
}

type StorageConfig struct {
	ProviderURL  string        `koanf:"provider_url"`
	AuthToken    string        `koanf:"auth_token"`
	LoadTimeout  time.Duration `koanf:"load_timeout"`
	StoreTimeout time.Duration `koanf:"store_timeout"`
	Retry        RetryConfig   `koanf:"retry"`
	HealthCheck  HealthConfig  `koanf:"health_check"`
}

type RetryConfig struct {
	MaxAttempts    int           `koanf:"max_attempts"`
	InitialBackoff time.Duration `koanf:"initial_backoff"`
}

type HealthConfig struct {
	Interval  time.Duration `koanf:"interval"`
	Threshold int           `koanf:"threshold"`
}

type RoomConfig struct {
	FlushDebounce   time.Duration `koanf:"flush_debounce"`
	FlushMaxBytes   int           `koanf:"flush_max_bytes"`
	IdleTimeout     time.Duration `koanf:"idle_timeout"`
	MaxPeersPerRoom int           `koanf:"max_peers_per_room"`
}

type MetricsConfig struct {
	Enabled bool   `koanf:"enabled"`
	Addr    string `koanf:"addr"`
}

type LogConfig struct {
	Level  string `koanf:"level"`
	Format string `koanf:"format"`
}

func DefaultConfig() Config {
	return Config{
		Server: ServerConfig{
			Addr:            ":8080",
			ReadTimeout:     5 * time.Second,
			WriteTimeout:    10 * time.Second,
			ShutdownTimeout: 30 * time.Second,
		},
		Storage: StorageConfig{
			ProviderURL:  "http://localhost:8081",
			AuthToken:    "dev-token",
			LoadTimeout:  10 * time.Second,
			StoreTimeout: 5 * time.Second,
			Retry: RetryConfig{
				MaxAttempts:    3,
				InitialBackoff: 100 * time.Millisecond,
			},
			HealthCheck: HealthConfig{
				Interval:  10 * time.Second,
				Threshold: 3,
			},
		},
		GRPC: GRPCConfig{
			Enabled: false,
			Addr:    ":50051",
		},
		Redis: RedisConfig{
			Enabled:      false,
			URL:          "redis://localhost:6379",
			DB:           0,
			PoolSize:     10,
			FlushLockTTL: 4 * time.Second,
		},
		Room: RoomConfig{
			FlushDebounce:   2 * time.Second,
			FlushMaxBytes:   65536,
			IdleTimeout:     60 * time.Second,
			MaxPeersPerRoom: 50,
		},
		Metrics: MetricsConfig{
			Enabled: true,
			Addr:    ":9090",
		},
		Log: LogConfig{
			Level:  "info",
			Format: "json",
		},
	}
}

func LoadConfig(path string) (Config, error) {
	k := koanf.New(".")
	cfg := DefaultConfig()

	if path != "" {
		if err := k.Load(file.Provider(path), yaml.Parser()); err != nil {
			slog.Warn("config file not found, using defaults", "path", path, "err", err)
		}
	}

	// Load specific env vars that map to config fields
	envMappings := map[string]string{
		"COLLAB_STORAGE_PROVIDER_URL":  "storage.provider_url",
		"COLLAB_STORAGE_AUTH_TOKEN":    "storage.auth_token",
		"COLLAB_COMMENTS_PROVIDER_URL": "comments.provider_url",
		"COLLAB_COMMENTS_AUTH_TOKEN":   "comments.auth_token",
		"COLLAB_SERVER_ADDR":          "server.addr",
		"COLLAB_METRICS_ADDR":         "metrics.addr",
		"COLLAB_LOG_LEVEL":            "log.level",
		"COLLAB_GRPC_ENABLED":         "grpc.enabled",
		"COLLAB_GRPC_ADDR":            "grpc.addr",
		"COLLAB_REDIS_ENABLED":        "redis.enabled",
		"COLLAB_REDIS_URL":            "redis.url",
	}
	if err := k.Load(env.ProviderWithValue("COLLAB_", ".", func(key, value string) (string, any) {
		if mapped, ok := envMappings[key]; ok {
			return mapped, value
		}
		return "", nil
	}), nil); err != nil {
		slog.Warn("failed to load env vars", "err", err)
	}

	if err := k.Unmarshal("", &cfg); err != nil {
		return cfg, err
	}

	return cfg, nil
}
