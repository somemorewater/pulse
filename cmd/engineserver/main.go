// Command engineserver runs the internal Go HTTP service for the Node gateway.
//
// Internal only: bind to localhost in deployment. Endpoints:
//
//	GET  /health
//	POST /internal/matches
//	POST /internal/events
//	POST /internal/fairness/verify
//	POST /internal/matches/{id}/reveal
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"pulse/internal/config"
	infraredis "pulse/internal/infrastructure/redis"
	"pulse/internal/persistence/postgres"
	enginetransport "pulse/internal/transport/http"
)

func main() {
	cfg := config.Load()

	pg, err := postgres.Open(cfg.DatabaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "postgres:", err)
		os.Exit(1)
	}
	defer pg.Close()

	rd, err := infraredis.New(cfg.RedisURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "redis:", err)
		os.Exit(1)
	}
	defer rd.Close()

	mux := http.NewServeMux()
	enginetransport.New(pg, rd, 0.05).Routes(mux)

	srv := &http.Server{
		Addr:              ":" + cfg.EnginePort,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		fmt.Println("engine listening on :" + cfg.EnginePort)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Fprintln(os.Stderr, "listen:", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
