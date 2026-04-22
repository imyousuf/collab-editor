package storagedemo

import (
	"log/slog"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/env"
	"github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/v2"
)

type Config struct {
	Server   ServerConfig   `koanf:"server"`
	Storage  StorageConfig  `koanf:"storage"`
	Auth     AuthConfig     `koanf:"auth"`
	Log      LogConfig      `koanf:"log"`
	Comments CommentsConfig `koanf:"comments"`
}

// CommentsConfig configures the demo Comments provider — specifically the
// in-memory mention directory seeded at startup.
type CommentsConfig struct {
	Users []UserDirectoryEntry `koanf:"users"`
}

// UserDirectoryEntry is a single seeded user for @-mention autocomplete.
type UserDirectoryEntry struct {
	UserID      string `koanf:"user_id"`
	DisplayName string `koanf:"display_name"`
	AvatarURL   string `koanf:"avatar_url"`
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

	envMappings := map[string]string{
		"COLLAB_PROVIDER_AUTH_TOKEN":    "auth.token",
		"COLLAB_PROVIDER_STORAGE_BASE_DIR": "storage.base_dir",
		"COLLAB_PROVIDER_SERVER_ADDR":  "server.addr",
	}
	if err := k.Load(env.ProviderWithValue("COLLAB_PROVIDER_", ".", func(key, value string) (string, interface{}) {
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
