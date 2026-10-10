// Package config reads runtime configuration from the environment.
package config

import "os"

// Config holds infrastructure connection strings.
type Config struct {
	DatabaseURL string
	RedisURL    string
	EnginePort  string
}

// Load reads DATABASE_URL, REDIS_URL and ENGINE_PORT,
// falling back to local-dev defaults.
func Load() Config {
	return Config{
		firstNonEmpty(os.Getenv("DATABASE_URL"), "postgres://pulse:pulse@localhost:5434/pulse?sslmode=disable"),
		firstNonEmpty(os.Getenv("REDIS_URL"), "redis://localhost:6381/0"),
		firstNonEmpty(os.Getenv("ENGINE_PORT"), "8081"),
	}
}

func firstNonEmpty(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}
