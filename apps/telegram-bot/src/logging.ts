export const serviceName = "telegram-bot";

import type {
  AnyValueMap,
  Logger as OtlpLogger,
} from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { FailureCategory } from "./failures.js";

export type LogFields = {
  service?: string;
  level?: string;
  msg?: string;
  use_case?: string;
  operation?: string;
  result?: string;
  duration_us?: number;
  request_id?: string;
  identity_id?: string;
  error_category?: FailureCategory;
  error?: string;
  stack?: string;
  grpc_code?: string;
  reply_error?: string;
  meetup_id?: string;
  signal?: string;
  timeout?: number;
  telegram_environment?: string;
};

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

// Запись всегда уходит JSON-строкой в stdout, а при переданном otlp — ещё и
// по OTLP: Structured logs dashboard читает только его. Порог уровня общий для
// обоих выходов.
export function createLogger(level: string, otlp?: OtlpLogger): Logger {
  const min = parseLevel(level);
  return {
    debug(message, fields) {
      write("debug", 20, min, message, fields, otlp);
    },
    info(message, fields) {
      write("info", 30, min, message, fields, otlp);
    },
    warn(message, fields) {
      write("warn", 40, min, message, fields, otlp);
    },
    error(message, fields) {
      write("error", 50, min, message, fields, otlp);
    },
  };
}

function parseLevel(raw: string): number {
  switch (raw) {
    case "debug":
      return 20;
    case "info":
      return 30;
    case "warn":
      return 40;
    case "error":
      return 50;
    default:
      return 30;
  }
}

function write(
  level: string,
  value: number,
  min: number,
  message: string,
  fields: LogFields | undefined,
  otlp: OtlpLogger | undefined,
): void {
  if (value < min) {
    return;
  }
  const record: LogFields = {
    service: serviceName,
    level,
    msg: message,
    ...fields,
  };
  process.stdout.write(`${JSON.stringify(record)}\n`);
  otlp?.emit({
    severityNumber: severity(value),
    severityText: level,
    body: message,
    attributes: attributes(record),
  });
}

function severity(value: number): SeverityNumber {
  switch (value) {
    case 20:
      return SeverityNumber.DEBUG;
    case 40:
      return SeverityNumber.WARN;
    case 50:
      return SeverityNumber.ERROR;
    default:
      return SeverityNumber.INFO;
  }
}

// Уровень и текст у OTLP-записи — свои поля, поэтому в атрибуты уходят только
// каркас и поля сверх него. Поле, которого нет, не пишется и здесь.
function attributes(record: LogFields): AnyValueMap {
  const { level: _level, msg: _msg, ...fields } = record;
  const result: AnyValueMap = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
