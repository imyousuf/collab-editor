package storagedemo

import (
	"log/slog"
	"strings"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/env"
	"github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/v2"
)

type Config struct {
	Server  ServerConfig  `koanf:"server"`
	Storage StorageConfig `koanf:"storage"`
	Auth    AuthConfig    `koanf:"auth"`
	Log     LogConfig     `koanf:"log"`
}

type ServerConfig struct {
	Addr string `koanf:"addr"`
}

type StorageConfig struct {
	BaseDir string `koanf:"base_dir"`
}

type AuthConfig struct {
	Token string `koanf:"token"`
}

type LogConfig struct {
	Level  string `koanf:"level"`
	Format string `koanf:"format"`
}

func DefaultConfig() Config {
	return Config{
		Server:  ServerConfig{Addr: ":8081"},
		Storage: StorageConfig{BaseDir: "/data/documents"},
		Auth:    AuthConfig{Token: "dev-token"},
		Log:     LogConfig{Level: "info", Format: "json"},
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

	if err := k.Load(env.Provider("COLLAB_PROVIDER_", ".", func(s string) string {
		return strings.ReplaceAll(
			strings.ToLower(strings.TrimPrefix(s, "COLLAB_PROVIDER_")),
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
