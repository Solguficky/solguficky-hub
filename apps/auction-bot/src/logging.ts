// Имя сервиса в записях и, когда появится telemetry, — имя ресурса: свои у
// каждого бота (ADR-044, «Процессы и раскладка»).
export const serviceName = "auction-bot";

export type ErrorCategory =
  | "authorization"
  | "invariant"
  | "dependency_unavailable"
  | "timeout"
  | "unexpected";

// Поля каркаса logging.md, которые бот сейчас пишет, и `screen` — какой экран
// оболочки получил человек. Telegram user id и ник сюда не входят: после
// разрешения личности пишется `identity_id`.
//
// `use_case` бот пока не пишет: в словаре продуктовых сценариев аукционных
// имён ещё нет, а сценарий вне утверждённого среза не именуется.
export type LogFields = {
  operation?: string;
  result?: "ok" | "error";
  duration_us?: number;
  request_id?: string;
  identity_id?: string;
  error_category?: ErrorCategory;
  error?: string;
  grpc_code?: string;
  screen?: string;
  signal?: string;
  timeout?: number;
  telegram_environment?: string;
};

export type Logger = {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

const levels = { info: 30, warn: 40, error: 50 } as const;
type Level = keyof typeof levels;

// Запись уходит JSON-строкой в stdout: Aspire показывает её в консольном логе
// ресурса. OTLP-экспорта у бота аукциона пока нет.
export function createLogger(
  level: string,
  out: (line: string) => void = (line) => {
    process.stdout.write(line);
  },
): Logger {
  const min = levels[parseLevel(level)];
  const write = (lvl: Level, message: string, fields?: LogFields) => {
    if (levels[lvl] < min) return;
    out(
      `${JSON.stringify({ service: serviceName, level: lvl, msg: message, ...fields })}\n`,
    );
  };
  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

function parseLevel(raw: string): Level {
  return raw === "warn" || raw === "error" ? raw : "info";
}
