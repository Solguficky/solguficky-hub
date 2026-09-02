package testdb

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/url"
	"os"
	"regexp"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func Open(t *testing.T) *sql.DB {
	t.Helper()
	dsn := DSN(t)
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open isolated: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.PingContext(t.Context()); err != nil {
		t.Fatalf("ping isolated: %v", err)
	}
	return db
}

func DSN(t *testing.T) string {
	t.Helper()

	adminDSN := postgresDSN(t)
	name := uniqueDBName(t)

	admin, err := sql.Open("pgx", adminDSN)
	if err != nil {
		t.Fatalf("open admin: %v", err)
	}
	if _, err := admin.ExecContext(t.Context(), "CREATE DATABASE "+name); err != nil {
		_ = admin.Close()
		t.Fatalf("create database %s: %v", name, err)
	}
	if err := admin.Close(); err != nil {
		t.Fatalf("close admin: %v", err)
	}

	t.Cleanup(func() {
		admin, err := sql.Open("pgx", adminDSN)
		if err != nil {
			t.Logf("cleanup open admin: %v", err)
			return
		}
		_, err = admin.ExecContext(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
		if err != nil {
			t.Logf("cleanup drop %s: %v", name, err)
		}
		_ = admin.Close()
	})

	dsn, err := withDatabase(adminDSN, name)
	if err != nil {
		t.Fatal(err)
	}
	return dsn
}

func postgresDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("IDENTITY_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable" //nolint:gosec // G101: local test default, not a secret
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		skipOrFatal(t, err)
	}
	defer func() { _ = db.Close() }()
	if err := db.PingContext(t.Context()); err != nil {
		skipOrFatal(t, err)
	}
	return dsn
}

func skipOrFatal(t *testing.T, err error) {
	t.Helper()
	if os.Getenv("IDENTITY_DATABASE_URL") != "" || os.Getenv("GITHUB_ACTIONS") != "" {
		t.Fatalf("postgres: %v", err)
	}
	t.Skipf("postgres not available: %v", err)
}

func uniqueDBName(t *testing.T) string {
	t.Helper()
	sum := sha256.Sum256([]byte(t.Name() + time.Now().String()))
	name := "idtest_" + hex.EncodeToString(sum[:10])
	if !regexp.MustCompile(`^[a-z][a-z0-9_]*$`).MatchString(name) {
		t.Fatalf("generated database name %q is not safe", name)
	}
	return name
}

func withDatabase(dsn, name string) (string, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return "", err
	}
	u.Path = "/" + name
	return u.String(), nil
}
