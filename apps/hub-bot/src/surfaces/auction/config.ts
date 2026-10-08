import { type FaqContent, readFaqContent } from "./faq.js";

export type TelegramEnvironment = "prod" | "test";

// Форма карточки лота (ADR-034, дополнение): `rich` — rich-сообщение с фото,
// `plain` — обычное сообщение с HTML, операторский откат без перевыпуска.
export type Presentation = "rich" | "plain";

export type Config = {
  token: string;
  serviceToken: string;
  environment: TelegramEnvironment;
  presentation: Presentation;
  identityUrl: string;
  auctionUrl: string;
  // Шина: адресные факты Notifications, которые бот доставляет (PER-328).
  natsUrl: string;
  logLevel: string;
  faq: FaqContent;
  // Пояс, в котором человек читает дедлайн лота.
  communityTimeZone: string;
};

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

// Конфигурация процесса из переменных, которые раздаёт AppHost. Отказ называет
// только имя переменной: значения токенов в запись не попадают.
//
// Переменные общие у двух поверхностей (`BOT_*`, ADR-064, п. 18), а значения у
// процессов свои: токен поверхности аукциона раздаёт AppHost, и он же до старта
// отказывает, если токен повторяет токен хаба.
export function readConfig(
  env: Readonly<Record<string, string | undefined>>,
): ConfigResult {
  // Пустое значение равно отсутствующему: иначе `""` прошло бы мимо умолчания.
  const read = (name: string): string | undefined => env[name] || undefined;
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
  // Identity и Auction получил бы UNAUTHENTICATED уже на первом человеке.
  // Пробелы по краям Headers срезает молча, и токен ушёл бы искажённым.
  const serviceToken = read("BOT_SERVICE_TOKEN");
  if (serviceToken === undefined || serviceToken.trim() === "") {
    return { ok: false, error: "BOT_SERVICE_TOKEN is not set" };
  }
  if (serviceToken !== serviceToken.trim()) {
    return {
      ok: false,
      error: "BOT_SERVICE_TOKEN has surrounding whitespace",
    };
  }
  const environment = parseEnvironment(read("BOT_ENVIRONMENT"));
  if (environment === undefined) {
    return { ok: false, error: "BOT_ENVIRONMENT must be prod or test" };
  }
  const presentation = read("BOT_PRESENTATION") ?? "rich";
  if (presentation !== "rich" && presentation !== "plain") {
    return {
      ok: false,
      error: "BOT_PRESENTATION must be rich or plain",
    };
  }
  const faq = readFaqContent(env);
  if (!faq.ok) return faq;
  // Неизвестное имя — отказ, а не откат к UTC: опечатка сдвинула бы каждый
  // показанный дедлайн на разницу поясов.
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
      token,
      serviceToken,
      environment,
      presentation,
      identityUrl: read("IDENTITY_GRPC_URL") ?? "http://127.0.0.1:50051",
      auctionUrl: read("AUCTION_GRPC_URL") ?? "http://127.0.0.1:8081",
      natsUrl: read("BOT_NATS_URL") ?? "nats://127.0.0.1:4222",
      logLevel: read("BOT_LOG_LEVEL") ?? "info",
      faq: faq.content,
      communityTimeZone,
    },
  };
}

function parseTimeZone(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return undefined;
  }
}

function parseEnvironment(
  raw: string | undefined,
): TelegramEnvironment | undefined {
  if (raw === undefined || raw === "") return "prod";
  return raw === "prod" || raw === "test" ? raw : undefined;
}
