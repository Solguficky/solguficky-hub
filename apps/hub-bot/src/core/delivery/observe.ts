import { type Counter, type MeterProvider, metrics } from "@opentelemetry/api";

// Категории отказа из стандарта логов (logging.md). Пакет называет их сам, а
// бот принимает: имена одни у обоих ботов, и счётчик сбоев складывается.
export type FailureCategory =
  | "authorization"
  | "invariant"
  | "dependency_unavailable"
  | "timeout"
  | "visibility"
  | "unexpected";

// Поля записи, которые пишет механика доставки. Логгер бота принимает больше
// полей, поэтому его тип подходит сюда как есть.
export type DeliveryLogFields = {
  operation?: string;
  result?: "ok" | "error";
  duration_us?: number;
  request_id?: string;
  identity_id?: string;
  error_category?: FailureCategory;
  error?: string;
  stack?: string;
  reply_error?: string;
  notification_id?: string;
  notification_type?: string;
  attempt?: number;
  retry_delay_ms?: number;
};

export type DeliveryLogger = {
  debug(message: string, fields?: DeliveryLogFields): void;
  info(message: string, fields?: DeliveryLogFields): void;
  warn(message: string, fields?: DeliveryLogFields): void;
  error(message: string, fields?: DeliveryLogFields): void;
};

export type CountFailure = (category: FailureCategory) => void;

// Исход одного сообщения шины: ключ — значение атрибута `outcome` счётчика
// доставок бота.
export type RecordOutcome = (outcome: string) => void;

// Счётчик доставок по исходам. У metrics API нет прокси-провайдера: счётчик,
// созданный раньше startMetrics бота, навсегда остался бы no-op, поэтому он
// привязывается к текущему глобальному провайдеру и пересоздаётся при смене.
// Имя у каждого бота своё (`hub_bot.notification.deliveries`): дашборды
// различают каналы по нему, а не по атрибуту.
export function deliveryOutcomes(options: {
  counter: string;
  service: string;
}): RecordOutcome {
  let bound: { provider: MeterProvider; counter: Counter } | undefined;
  return (outcome) => {
    const provider = metrics.getMeterProvider();
    if (bound?.provider !== provider) {
      bound = {
        provider,
        counter: provider
          .getMeter("solguficky.notifications")
          .createCounter(options.counter, {
            description:
              "Notifications handled by the Telegram channel, grouped by outcome",
          }),
      };
    }
    bound.counter.add(1, { service: options.service, outcome });
  };
}
