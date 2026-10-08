import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, serviceName } from "./logging.js";

describe("createLogger", () => {
  let exporter: InMemoryLogRecordExporter;
  let provider: LoggerProvider;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exporter = new InMemoryLogRecordExporter();
    provider = new LoggerProvider();
    provider.addLogRecordProcessor(new SimpleLogRecordProcessor(exporter));
    stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stdout.mockRestore();
  });

  it("sends the record over OTLP with the frame as attributes", () => {
    const logger = createLogger("info", provider.getLogger(serviceName));

    logger.info("identity resolved", {
      operation: "message",
      result: "ok",
      request_id: "req-42",
      use_case: "find_meetup",
    });

    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.body).toBe("identity resolved");
    expect(records[0]?.severityNumber).toBe(SeverityNumber.INFO);
    expect(records[0]?.attributes).toEqual({
      service: serviceName,
      operation: "message",
      result: "ok",
      request_id: "req-42",
      use_case: "find_meetup",
    });
    expect(stdout).toHaveBeenCalledTimes(1);
  });

  it("keeps records below the level out of both outputs", () => {
    const logger = createLogger("info", provider.getLogger(serviceName));

    logger.debug("foreign answer ignored", { result: "ok" });

    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("writes only stdout without an OTLP logger", () => {
    const logger = createLogger("info");

    logger.warn("identity unavailable", { result: "error" });

    expect(stdout).toHaveBeenCalledTimes(1);
  });
});
