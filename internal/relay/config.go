package relay

import (
	"log/slog"
	"strings"
	"time"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/env"
	"github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/v2"
)

type Config struct {
	Server  ServerConfig  `koanf:"server"`
	Storage StorageConfig `koanf:"storage"`
	Room    RoomConfig    `koanf:"room"`
	Metrics MetricsConfig `koanf:"metrics"`
	Log     LogConfig     `koanf:"log"`
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

	if err := k.Load(env.Provider("COLLAB_", ".", func(s string) string {
		return strings.ReplaceAll(
			strings.ToLower(strings.TrimPrefix(s, "COLLAB_")),
			"_", ".",
		)
	}), nil); err != nil {
		slog.Warn("failed to load env vars", "err", err)
	}

	if err := k.Unmarshal("", &cfg); err != nil {
		return cfg, err
	}

	return cfg, nil
}
