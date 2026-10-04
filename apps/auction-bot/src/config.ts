import { type FaqContent, readFaqContent } from "./faq.js";

export type TelegramEnvironment = "prod" | "test";

export type Config = {
  token: string;
  serviceToken: string;
  environment: TelegramEnvironment;
  identityUrl: string;
  auctionUrl: string;
  // Шина: адресные факты Notifications, которые бот доставляет (PER-328).
  natsUrl: string;
  logLevel: string;
  faq: FaqContent;
  // Пояс, в котором человек читает дедлайн лота.
  communityTimeZone: string;
  // Аукцион, ленту которого открывает пункт меню «Аукционы». Нет — пункт
  // отвечает, что каталог ещё не открыт.
  auctionId?: string;
};

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

// Конфигурация процесса из переменных, которые раздаёт AppHost. Отказ называет
// только имя переменной: значения токенов в запись не попадают.
//
// Своя переменная токена и ни одной чужой: `HUB_BOT_TOKEN` бот аукциона не
// читает даже запасным вариантом (ADR-044, «Конфигурация и Aspire»).
export function readConfig(
  env: Readonly<Record<string, string | undefined>>,
): ConfigResult {
  // Пустое значение равно отсутствующему: иначе `""` прошло бы мимо умолчания.
  const read = (name: string): string | undefined => env[name] || undefined;
  const token = read("AUCTION_BOT_TOKEN");
  if (token === undefined || token.trim() === "") {
    return { ok: false, error: "AUCTION_BOT_TOKEN is not set" };
  }
  // Токен с переводом строки из user-secrets прошёл бы гейт AppHost, а Bot API
  // ответил бы 404 без внятной причины.
  if (token !== token.trim()) {
    return { ok: false, error: "AUCTION_BOT_TOKEN has surrounding whitespace" };
  }
  // Токен вызывающего (ADR-056) проверяется на старте: без него каждый вызов
  // Identity и Auction получил бы UNAUTHENTICATED уже на первом человеке.
  // Пробелы по краям Headers срезает молча, и токен ушёл бы искажённым.
  const serviceToken = read("AUCTION_BOT_SERVICE_TOKEN");
  if (serviceToken === undefined || serviceToken.trim() === "") {
    return { ok: false, error: "AUCTION_BOT_SERVICE_TOKEN is not set" };
  }
  if (serviceToken !== serviceToken.trim()) {
    return {
      ok: false,
      error: "AUCTION_BOT_SERVICE_TOKEN has surrounding whitespace",
    };
  }
  const environment = parseEnvironment(read("AUCTION_BOT_ENVIRONMENT"));
  if (environment === undefined) {
    return { ok: false, error: "AUCTION_BOT_ENVIRONMENT must be prod or test" };
  }
  const faq = readFaqContent(env);
  if (!faq.ok) return faq;
  // Неизвестное имя — отказ, а не откат к UTC: опечатка сдвинула бы каждый
  // показанный дедлайн на разницу поясов.
  const communityTimeZone = parseTimeZone(
    read("AUCTION_BOT_COMMUNITY_TIME_ZONE"),
  );
  if (communityTimeZone === undefined) {
    return {
      ok: false,
      error: "AUCTION_BOT_COMMUNITY_TIME_ZONE must be an IANA time zone name",
    };
  }
  const auctionId = read("AUCTION_BOT_AUCTION_ID");
  // Только каноническая форма: из неё кодировщик кнопки собирает токен, и
  // ошибка всплыла бы на первом нажатии, а не на старте процесса.
  if (auctionId !== undefined && !CANONICAL_UUID.test(auctionId)) {
    return {
      ok: false,
      error: "AUCTION_BOT_AUCTION_ID must be a canonical lowercase UUID",
    };
  }
  return {
    ok: true,
    config: {
      token,
      serviceToken,
      environment,
      identityUrl: read("IDENTITY_GRPC_URL") ?? "http://127.0.0.1:50051",
      auctionUrl: read("AUCTION_GRPC_URL") ?? "http://127.0.0.1:8081",
      natsUrl: read("AUCTION_BOT_NATS_URL") ?? "nats://127.0.0.1:4222",
      logLevel: read("AUCTION_BOT_LOG_LEVEL") ?? "info",
      faq: faq.content,
      communityTimeZone,
      ...(auctionId === undefined ? {} : { auctionId }),
    },
  };
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
