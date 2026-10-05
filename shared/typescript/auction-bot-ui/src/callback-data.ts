import { z } from "zod";

// `callback_data` аукциона: `v1:auc:<действие>[:<аргумент>]…` по формату бота
// хаба (docs/services/hub-bot.md, «Формат `callback_data`»). Домен `auc`
// у хаба не занят, поэтому кнопки аукциона живут в его сообщениях рядом с
// кнопками сходок и не перехватываются ни одним из двух разборов.
//
// Строка — недоверенный вход: клиент может прислать любую для видимого ему
// сообщения. Прав в ней нет, право проверяет Auction при каждом нажатии.

export const AUCTION_CALLBACK_DOMAIN = "auc";

const VERSION = "v1";

// Лимит Telegram — 64 байта, а не символа: многобайтная строка из 64 символов
// Bot API не примет, значит и прийти от него она не может.
const MAX_BYTES = 64;

// Номер страницы ленты едет в обеих кнопках: карточка помнит, на какую
// страницу вернуться. Состояния экрана у бота нет (ADR-030), поэтому всё, что
// нужно следующему нажатию, лежит в самой строке.
//
// Хронология несёт обе страницы: свою и ту страницу ленты, на которую ведёт
// возврат с карточки. Страница хронологии за её пределом открывает последнюю,
// поэтому кнопка «Ставки» на карточке просит `MAX_FEED_PAGE` — свежие ставки.
export type AuctionIntent =
  | { kind: "feed"; auctionId: string; page: number }
  | { kind: "lot"; lotId: string; page: number }
  | { kind: "history"; lotId: string; page: number; historyPage: number };

// Страница — десятичное число без ведущих нулей: у одной кнопки одно
// написание, как у токена. Тысяча страниц по восемь лотов — с запасом выше
// любой ленты сходки.
const PAGE = /^(0|[1-9]\d{0,2})$/;
export const MAX_FEED_PAGE = 999;

export type AuctionCallbackErrorReason =
  // Кнопка другого домена: у хаба это его собственная кнопка, а не дефект.
  | "foreign"
  // Версия не та, что пишет этот пакет: экран устарел, человек получает
  // актуальную перерисовку.
  | "outdated"
  // Домен аукциона, но строку не собрал ни один кодировщик пакета.
  | "malformed";

export class AuctionCallbackError extends Error {
  override readonly name = "AuctionCallbackError";

  constructor(readonly reason: AuctionCallbackErrorReason) {
    super(`auction callback_data rejected: ${reason}`);
  }
}

export type ParsedAuctionCallback =
  | { ok: true; intent: AuctionIntent }
  | { ok: false; error: AuctionCallbackError };

// UUIDv7 едет в кнопке base64url-токеном из 22 символов, как у хаба: 16 байт
// вместо 36 символов оставляют место аргументам пагинации.
const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const UuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

function uuidToToken(id: string): string {
  return Buffer.from(UuidSchema.parse(id).replaceAll("-", ""), "hex").toString(
    "base64url",
  );
}

// У последнего символа токена значимы два бита из шести, поэтому одним байтам
// соответствуют четыре строки. Принимается только каноническая — та, что
// пишет `uuidToToken`: иначе одна кнопка имела бы несколько написаний.
function tokenToUuid(token: string): string | undefined {
  if (!TokenSchema.safeParse(token).success) return undefined;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.toString("base64url") !== token) return undefined;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pageArgument(page: number): string {
  if (!Number.isInteger(page) || page < 0 || page > MAX_FEED_PAGE) {
    throw new RangeError(`feed page out of range: ${page}`);
  }
  return String(page);
}

function pageOf(raw: string | undefined): number | undefined {
  return raw !== undefined && PAGE.test(raw) ? Number(raw) : undefined;
}

export function encodeAuctionCallback(intent: AuctionIntent): string {
  const prefix = `${VERSION}:${AUCTION_CALLBACK_DOMAIN}`;
  switch (intent.kind) {
    case "feed":
      return `${prefix}:feed:${uuidToToken(intent.auctionId)}:${pageArgument(intent.page)}`;
    case "lot":
      return `${prefix}:lot:${uuidToToken(intent.lotId)}:${pageArgument(intent.page)}`;
    case "history":
      return `${prefix}:hist:${uuidToToken(intent.lotId)}:${pageArgument(intent.page)}:${pageArgument(intent.historyPage)}`;
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

function refuse(reason: AuctionCallbackErrorReason): ParsedAuctionCallback {
  return { ok: false, error: new AuctionCallbackError(reason) };
}

export function parseAuctionCallback(raw: unknown): ParsedAuctionCallback {
  if (typeof raw !== "string" || raw.length === 0) return refuse("malformed");
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) return refuse("malformed");
  const parts = raw.split(":");
  const [version, domain, action, ...args] = parts;
  if (!/^v\d+$/.test(version ?? "") || domain === undefined || domain === "") {
    return refuse("malformed");
  }
  // Домен разбирается раньше номера версии: чужая кнопка остаётся чужой при
  // любой версии. Иначе хаб, поднявший свои кнопки до v2, получал бы их от
  // пакета обратно как устаревшие аукционные.
  if (domain !== AUCTION_CALLBACK_DOMAIN) return refuse("foreign");
  // Своя строка другой версии: этот пакет её не понимает, экран устарел.
  if (version !== VERSION) return refuse("outdated");
  // Аргументов у действия ровно столько, сколько пишет его кодировщик: лишний
  // аргумент — не та строка, а не страница, которую можно молча отбросить.
  const [token, rawPage, ...rest] = args;
  const extra = action === "hist" ? 1 : 0;
  if (token === undefined || rest.length !== extra) return refuse("malformed");
  const id = tokenToUuid(token);
  // Кнопка лота без страницы — форма PER-305: она ведёт на ту же карточку, а
  // возврат — на первую страницу ленты.
  const page = action === "lot" && rawPage === undefined ? 0 : pageOf(rawPage);
  if (id === undefined || page === undefined) return refuse("malformed");
  switch (action) {
    case "feed":
      return { ok: true, intent: { kind: "feed", auctionId: id, page } };
    case "lot":
      return { ok: true, intent: { kind: "lot", lotId: id, page } };
    case "hist": {
      const historyPage = pageOf(rest[0]);
      if (historyPage === undefined) return refuse("malformed");
      return {
        ok: true,
        intent: { kind: "history", lotId: id, page, historyPage },
      };
    }
    default:
      return refuse("malformed");
  }
}
