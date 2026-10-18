package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"testing"

	otellog "go.opentelemetry.io/otel/log"
	sdklog "go.opentelemetry.io/otel/sdk/log"
)

type memoryExporter struct {
	mu      sync.Mutex
	records []sdklog.Record
}

func (e *memoryExporter) Export(_ context.Context, records []sdklog.Record) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, r := range records {
		e.records = append(e.records, r.Clone())
	}
	return nil
}

func (*memoryExporter) Shutdown(context.Context) error   { return nil }
func (*memoryExporter) ForceFlush(context.Context) error { return nil }

func TestLoggerSendsRecordToOTLPWithFields(t *testing.T) {
	t.Parallel()

	exporter := &memoryExporter{}
	provider := sdklog.NewLoggerProvider(sdklog.WithProcessor(sdklog.NewSimpleProcessor(exporter)))
	var stdout bytes.Buffer

	newLogger(&stdout, slog.LevelInfo, provider).Info("rpc completed", "request_id", "req-42", "use_case", "start")

	if len(exporter.records) != 1 {
		t.Fatalf("otlp records: got %d want 1", len(exporter.records))
	}
	rec := exporter.records[0]
	if got := rec.Body().AsString(); got != "rpc completed" {
		t.Fatalf("body: got %q", got)
	}
	attrs := map[string]string{}
	rec.WalkAttributes(func(kv otellog.KeyValue) bool {
		attrs[kv.Key] = kv.Value.AsString()
		return true
	})
	if attrs["request_id"] != "req-42" || attrs["use_case"] != "start" {
		t.Fatalf("attributes: got %v", attrs)
	}

	var line map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &line); err != nil {
		t.Fatalf("stdout is not one JSON record: %v", err)
	}
	if line["request_id"] != "req-42" {
		t.Fatalf("stdout request_id: got %v", line["request_id"])
	}
}

func TestLoggerKeepsDebugOutOfOTLPAtInfo(t *testing.T) {
	t.Parallel()

	exporter := &memoryExporter{}
	provider := sdklog.NewLoggerProvider(sdklog.WithProcessor(sdklog.NewSimpleProcessor(exporter)))
	var stdout bytes.Buffer

	newLogger(&stdout, slog.LevelInfo, provider).Debug("rpc completed")

	if len(exporter.records) != 0 {
		t.Fatalf("otlp records: got %d want 0", len(exporter.records))
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout: got %q want empty", stdout.String())
	}
}

func TestLoggerWithoutProviderWritesOnlyStdout(t *testing.T) {
	t.Parallel()

	var stdout bytes.Buffer
	newLogger(&stdout, slog.LevelInfo, nil).Info("identity listening")

	if stdout.Len() == 0 {
		t.Fatal("stdout: got empty")
	}
}
