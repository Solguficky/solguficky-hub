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
  // Какой экран получил человек: запись каталога экранов поверхности.
  screen?: string;
  error?: string;
  stack?: string;
  grpc_code?: string;
  reply_error?: string;
  // Telegram отверг карточку с постерами, и она ушла без них (PER-443).
  posters_error?: string;
  meetup_id?: string;
  // Вид сообщения, которое не стало материалом сходки: `forward:<тип>`, вид
  // медиа, `text` или `other`, у пересланного медиа через запятую
  // (`forward:user,video`), без содержимого (PER-762).
  message_kind?: string;
  signal?: string;
  timeout?: number;
  telegram_environment?: string;
  // Версия образа из данных сборки — коммит или `local` — и дата его коммита
  // (PER-736).
  version?: string;
  build_date?: string;
  // Задано ли имя бота аукциона для ссылок каналов прихода (PER-441).
  auction_bot_links?: boolean;
  // Сколько записей «Что нового» своей поверхности нашёл процесс в образе
  // (ADR-069, п. 1).
  release_notes?: number;
  notification_id?: string;
  notification_type?: string;
  attempt?: number;
  retry_delay_ms?: number;
  // Чем кончилась реплика переписки бота поддержки: скопирована, отказ и
  // его вид (ADR-068).
  outcome?: string;
  // Пост чата медиа ботов, который не показался (PER-776): по номеру его
  // находят в канале.
  media_post_id?: number;
};

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

export type LoggerOptions = {
  // Имя сервиса поверхности (`service.ts`): поле `service` каждой записи.
  service: string;
  // Есть — запись уходит ещё и по OTLP.
  otlp?: OtlpLogger;
  // Строка JSON с переводом строки; по умолчанию — stdout процесса.
  out?: (line: string) => void;
};

// Запись всегда уходит JSON-строкой в stdout, а при переданном otlp — ещё и
// по OTLP: Structured logs dashboard читает только его. Порог уровня общий для
// обоих выходов.
export function createLogger(level: string, options: LoggerOptions): Logger {
  const min = parseLevel(level);
  const sink: Sink = {
    service: options.service,
    otlp: options.otlp,
    out:
      options.out ??
      ((line) => {
        process.stdout.write(line);
      }),
  };
  return {
    debug(message, fields) {
      write("debug", 20, min, message, fields, sink);
    },
    info(message, fields) {
      write("info", 30, min, message, fields, sink);
    },
    warn(message, fields) {
      write("warn", 40, min, message, fields, sink);
    },
    error(message, fields) {
      write("error", 50, min, message, fields, sink);
    },
  };
}

type Sink = {
  service: string;
  otlp: OtlpLogger | undefined;
  out: (line: string) => void;
};

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
  sink: Sink,
): void {
  if (value < min) {
    return;
  }
  const record: LogFields = {
    service: sink.service,
    level,
    msg: message,
    ...fields,
  };
  sink.out(`${JSON.stringify(record)}\n`);
  sink.otlp?.emit({
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
