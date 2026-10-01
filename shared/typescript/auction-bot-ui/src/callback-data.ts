import { z } from "zod";

// `callback_data` аукциона: `v1:auc:<действие>[:<аргумент>]…` по формату бота
// хаба (docs/services/telegram-bot.md, «Формат `callback_data`»). Домен `auc`
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

export type AuctionIntent = { kind: "lot"; lotId: string };

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

export function encodeAuctionCallback(intent: AuctionIntent): string {
  switch (intent.kind) {
    case "lot":
      return `${VERSION}:${AUCTION_CALLBACK_DOMAIN}:lot:${uuidToToken(intent.lotId)}`;
    default: {
      const _exhaustive: never = intent.kind;
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
  if (action === "lot" && args.length === 1) {
    const lotId = tokenToUuid(args[0] ?? "");
    return lotId === undefined
      ? refuse("malformed")
      : { ok: true, intent: { kind: "lot", lotId } };
  }
  return refuse("malformed");
}
