import { type ServiceName, serviceNames } from "./service.js";
import type { Surface } from "./surface.js";

export type Env = Readonly<Record<string, string | undefined>>;

export type TelegramEnvironment = "prod" | "test";

export const defaultTelegramEnvironment: TelegramEnvironment = "prod";

// Форма карточки лота (ADR-034, дополнение): `rich` — rich-сообщение с фото,
// `plain` — обычное сообщение с HTML, операторский откат без перевыпуска.
export type Presentation = "rich" | "plain";

export type Loaded<T> = { ok: true; config: T } | { ok: false; error: string };

// Конфигурация процесса, общая у двух поверхностей: переменные `BOT_*` одни,
// а значения AppHost раздаёт каждому узлу свои (ADR-064, п. 18) и до старта
// отказывает, если токен бота аукциона повторяет токен хаба. Своё у
// поверхности — адреса её соседей и её тексты — читает она сама.
export type ProcessConfig = {
  surface: Surface;
  service: ServiceName;
  token: string;
  serviceToken: string;
  environment: TelegramEnvironment;
  presentation: Presentation;
  // Пояс сообщества: в нём человек читает даты сходок и дедлайн лота.
  communityTimeZone: string;
  identityUrl: string;
  // Шина: адресные факты Notifications, которые бот доставляет.
  natsUrl: string;
  logLevel: string;
};

// Пустое значение равно отсутствующему: иначе `""` прошло бы мимо умолчания,
// а пустой адрес ушёл бы в клиент.
export function reader(env: Env): (name: string) => string | undefined {
  return (name) => env[name] || undefined;
}

// Отказ называет только имя переменной: значения токенов в запись не попадают.
export function readProcessConfig(
  env: Env,
  surface: Surface,
): Loaded<ProcessConfig> {
  const read = reader(env);
  const token = read("BOT_TOKEN");
  if (token === undefined || token.trim() === "") {
    return { ok: false, error: "BOT_TOKEN is not set" };
  }
  // Токен с переводом строки из user-secrets прошёл бы гейт AppHost, а Bot API
  // ответил бы 404 без внятной причины.
  if (token !== token.trim()) {
    return { ok: false, error: "BOT_TOKEN has surrounding whitespace" };
  }
  // Токен вызывающего (ADR-056) проверяется на старте: без него каждый вызов
  // сервиса получил бы UNAUTHENTICATED уже на первом человеке. Пробелы по
  // краям Headers срезает молча, и токен ушёл бы искажённым.
  const serviceToken = read("BOT_SERVICE_TOKEN");
  if (serviceToken === undefined || serviceToken.trim() === "") {
    return { ok: false, error: "BOT_SERVICE_TOKEN is not set" };
  }
  if (serviceToken !== serviceToken.trim()) {
    return { ok: false, error: "BOT_SERVICE_TOKEN has surrounding whitespace" };
  }
  const environment = parseTelegramEnvironment(read("BOT_ENVIRONMENT"));
  if (environment === undefined) {
    return { ok: false, error: "BOT_ENVIRONMENT must be prod or test" };
  }
  const presentation = read("BOT_PRESENTATION") ?? "rich";
  if (presentation !== "rich" && presentation !== "plain") {
    return { ok: false, error: "BOT_PRESENTATION must be rich or plain" };
  }
  // Неизвестное имя — отказ, а не откат к UTC: опечатка сдвинула бы каждую
  // показанную дату на разницу поясов.
  const communityTimeZone = parseTimeZone(read("BOT_COMMUNITY_TIME_ZONE"));
  if (communityTimeZone === undefined) {
    return {
      ok: false,
      error: "BOT_COMMUNITY_TIME_ZONE must be an IANA time zone name",
    };
  }
  return {
    ok: true,
    config: {
      surface,
      service: serviceNames[surface],
      token,
      serviceToken,
      environment,
      presentation,
      communityTimeZone,
      identityUrl: read("IDENTITY_GRPC_URL") ?? "http://127.0.0.1:50051",
      natsUrl: read("BOT_NATS_URL") ?? "nats://127.0.0.1:4222",
      logLevel: read("BOT_LOG_LEVEL") ?? "info",
    },
  };
}

/**
 * Разбирает значение `BOT_ENVIRONMENT`. Отсутствие переменной — это
 * продакшн; любое неизвестное значение — `undefined`, а не молчаливый откат к
 * умолчанию: опечатка в переменной должна останавливать процесс, а не уводить
 * его в другую среду.
 */
export function parseTelegramEnvironment(
  raw: string | undefined,
): TelegramEnvironment | undefined {
  if (raw === undefined || raw === "") {
    return defaultTelegramEnvironment;
  }
  return raw === "prod" || raw === "test" ? raw : undefined;
}

/// Имя пояса IANA, которое понимает `Intl`, или `undefined`. Неизвестное имя —
/// отказ, а не откат к UTC: опечатка в конфигурации должна останавливать
/// процесс, а не сдвигать показанное время на разницу поясов.
export function parseTimeZone(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return undefined;
  }
}
