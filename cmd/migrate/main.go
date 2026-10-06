// Command migrate applies db/migrations/*.sql in lexical order.
// Tracks applied versions in schema_migrations. Safe to re-run.
//
//	Usage: DATABASE_URL=... go run ./cmd/migrate
package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"pulse/internal/config"
	"pulse/internal/persistence/postgres"
)

func main() {
	cfg := config.Load()
	override := os.Getenv("DATABASE_URL")
	if override != "" {
		cfg.DatabaseURL = override
	}
	migrationsDir := os.Getenv("MIGRATIONS_DIR")
	if migrationsDir == "" {
		migrationsDir = "db/migrations"
	}

	db, err := sql.Open("postgres", cfg.DatabaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open:", err)
		os.Exit(1)
	}
	defer db.Close()

	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read migrations:", err)
		os.Exit(1)
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".sql" {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	read := func(path string) ([]byte, error) { return os.ReadFile(path) }

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := postgres.EnsureMigrated(ctx, db, migrationsDir, files, read); err != nil {
		fmt.Fprintln(os.Stderr, "migrate:", err)
		os.Exit(1)
	}
	fmt.Printf("migrations applied: %d file(s) from %s\n", len(files), migrationsDir)
}
