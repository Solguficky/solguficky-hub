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
//
// Лист ставки (PER-317) добавляет команды участника. Сумма в них — минимальные
// единицы валюты лота в base36: валюту знает лот, а пять знаков base36 рядом с
// токенами лота и `op_id` оставляют место странице ленты. Потолок суммы —
// `MAX_COMMAND_AMOUNT`, около 604 тысяч рублей.
//
// - `confirm` — экран подтверждения; у кнопки «по шагу» сумма — порог, который
//   человек видел на карточке.
// - `commit` — «Да» подтверждения. `op_id` родился, когда подтверждение
//   показали, и едет в кнопке: повторное нажатие той же «Да» несёт тот же ключ,
//   и Auction второй ставки не создаёт.
// - `ask` — кнопка, задающая вопрос; `question` — шаг вопроса в его «Отмене»:
//   он же возвращается в `reply_to_message` ответа (дизайн-код, «Вопросы») и
//   несёт Telegram id того, кому вопрос задан.
// - `username` — выбрать ник своим именем в аукционе. Команда, ради которой
//   выбирается имя, едет в кнопке, чтобы после выбора вернуться к ней.
export type AuctionCommand = "bid" | "proxy";

// Команда, отложенная до выбора имени: её вид и сумма.
export type PendingCommand = { command: AuctionCommand; amount: number };

export type AuctionQuestion = "bid" | "proxy" | "alias";

export type AuctionIntent =
  | { kind: "feed"; auctionId: string; page: number }
  | { kind: "lot"; lotId: string; page: number }
  | { kind: "history"; lotId: string; page: number; historyPage: number }
  | {
      kind: "confirm";
      command: AuctionCommand;
      lotId: string;
      amount: number;
      page: number;
    }
  | {
      kind: "commit";
      command: AuctionCommand;
      lotId: string;
      opId: string;
      amount: number;
      page: number;
    }
  | {
      kind: "ask";
      question: AuctionQuestion;
      lotId: string;
      page: number;
      pending?: PendingCommand;
    }
  | {
      kind: "question";
      question: AuctionQuestion;
      lotId: string;
      page: number;
      addressee: number;
      pending?: PendingCommand;
    }
  | { kind: "username"; lotId: string; page: number; pending: PendingCommand };

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

// До пяти знаков base36 без ведущих нулей: у суммы одно написание, как у
// токена.
const AMOUNT = /^[1-9a-z][0-9a-z]{0,4}$/;
export const MAX_COMMAND_AMOUNT = 36 ** 5 - 1;

function amountArgument(amount: number): string {
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_COMMAND_AMOUNT) {
    throw new RangeError(`command amount out of range: ${amount}`);
  }
  return amount.toString(36);
}

function amountOf(raw: string | undefined): number | undefined {
  return raw !== undefined && AMOUNT.test(raw) ? parseInt(raw, 36) : undefined;
}

const COMMAND_CODE: Record<AuctionCommand, string> = { bid: "b", proxy: "x" };

function commandOf(code: string | undefined): AuctionCommand | undefined {
  if (code === "b") return "bid";
  if (code === "x") return "proxy";
  return undefined;
}

// Отложенная команда одним аргументом: код команды и сумма — `bxlc`.
function pendingArgument(pending: PendingCommand): string {
  return `${COMMAND_CODE[pending.command]}${amountArgument(pending.amount)}`;
}

function pendingOf(raw: string | undefined): PendingCommand | undefined {
  if (raw === undefined) return undefined;
  const command = commandOf(raw.slice(0, 1));
  const amount = amountOf(raw.slice(1));
  return command === undefined || amount === undefined
    ? undefined
    : { command, amount };
}

const QUESTION_CODE: Record<AuctionQuestion, string> = {
  bid: "b",
  proxy: "x",
  alias: "a",
};

function questionOf(code: string): AuctionQuestion | undefined {
  if (code === "b") return "bid";
  if (code === "x") return "proxy";
  if (code === "a") return "alias";
  return undefined;
}

// Telegram id — положительное целое без ведущих нулей в пределах 52 бит.
const ADDRESSEE = /^[1-9]\d{0,15}$/;

function addresseeArgument(addressee: number): string {
  if (!Number.isSafeInteger(addressee) || addressee < 1) {
    throw new RangeError(`question addressee out of range: ${addressee}`);
  }
  return String(addressee);
}

function addresseeOf(raw: string | undefined): number | undefined {
  if (raw === undefined || !ADDRESSEE.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
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
    case "confirm":
      return `${prefix}:c${COMMAND_CODE[intent.command]}:${uuidToToken(intent.lotId)}:${amountArgument(intent.amount)}:${pageArgument(intent.page)}`;
    case "commit":
      return `${prefix}:${COMMAND_CODE[intent.command]}:${uuidToToken(intent.lotId)}:${uuidToToken(intent.opId)}:${amountArgument(intent.amount)}:${pageArgument(intent.page)}`;
    case "ask":
      return [
        `${prefix}:a${QUESTION_CODE[intent.question]}`,
        uuidToToken(intent.lotId),
        pageArgument(intent.page),
        ...(intent.pending === undefined
          ? []
          : [pendingArgument(intent.pending)]),
      ].join(":");
    case "question":
      return [
        `${prefix}:q${QUESTION_CODE[intent.question]}`,
        uuidToToken(intent.lotId),
        pageArgument(intent.page),
        addresseeArgument(intent.addressee),
        ...(intent.pending === undefined
          ? []
          : [pendingArgument(intent.pending)]),
      ].join(":");
    case "username":
      return `${prefix}:nu:${uuidToToken(intent.lotId)}:${pageArgument(intent.page)}:${pendingArgument(intent.pending)}`;
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
  if (action === undefined) return refuse("malformed");
  const command = commandAction(action, args);
  if (command !== undefined) return command;
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

// Вопрос отличается от прочих кнопок тем, что приходит назад в ответе, а его
// «Отмена» удаляет сообщение вопроса. Приложению этого признака хватает, чтобы
// доставить нажатие по правилу вопросов, не разбирая строку само.
export function isAuctionQuestion(raw: unknown): boolean {
  const parsed = parseAuctionCallback(raw);
  return parsed.ok && parsed.intent.kind === "question";
}

function accept(intent: AuctionIntent): ParsedAuctionCallback {
  return { ok: true, intent };
}

// Действия листа ставки. `undefined` — действие не отсюда: его разбирают
// ветки ленты, лота и хронологии.
function commandAction(
  action: string,
  args: readonly string[],
): ParsedAuctionCallback | undefined {
  const [first, ...more] = args;
  const lotId = first === undefined ? undefined : tokenToUuid(first);
  if (action === "cb" || action === "cx") {
    const [rawAmount, rawPage, ...rest] = more;
    const command = commandOf(action.slice(1));
    const amount = amountOf(rawAmount);
    const page = pageOf(rawPage);
    if (
      lotId === undefined ||
      command === undefined ||
      amount === undefined ||
      page === undefined ||
      rest.length !== 0
    ) {
      return refuse("malformed");
    }
    return accept({ kind: "confirm", command, lotId, amount, page });
  }
  if (action === "b" || action === "x") {
    const [rawOp, rawAmount, rawPage, ...rest] = more;
    const command = commandOf(action);
    const opId = rawOp === undefined ? undefined : tokenToUuid(rawOp);
    const amount = amountOf(rawAmount);
    const page = pageOf(rawPage);
    if (
      lotId === undefined ||
      command === undefined ||
      opId === undefined ||
      amount === undefined ||
      page === undefined ||
      rest.length !== 0
    ) {
      return refuse("malformed");
    }
    return accept({ kind: "commit", command, lotId, opId, amount, page });
  }
  if (/^[aq][bxa]$/.test(action)) {
    const asking = action.startsWith("a");
    const question = questionOf(action.slice(1));
    const [rawPage, ...tail] = more;
    const rawAddressee = asking ? undefined : tail[0];
    const [rawPending, ...rest] = asking ? tail : tail.slice(1);
    const page = pageOf(rawPage);
    const addressee = addresseeOf(rawAddressee);
    const pending = pendingOf(rawPending);
    if (
      lotId === undefined ||
      question === undefined ||
      page === undefined ||
      (!asking && addressee === undefined) ||
      rest.length !== 0 ||
      (rawPending !== undefined && pending === undefined) ||
      // Псевдоним спрашивают ради отложенной команды, а ставка и лимит её не
      // несут: сумму спрашивает сам вопрос.
      (question === "alias") !== (pending !== undefined)
    ) {
      return refuse("malformed");
    }
    const withPending = pending === undefined ? {} : { pending };
    return asking
      ? accept({ kind: "ask", question, lotId, page, ...withPending })
      : accept({
          kind: "question",
          question,
          lotId,
          page,
          addressee: addressee as number,
          ...withPending,
        });
  }
  if (action === "nu") {
    const [rawPage, rawPending, ...rest] = more;
    const page = pageOf(rawPage);
    const pending = pendingOf(rawPending);
    if (
      lotId === undefined ||
      page === undefined ||
      pending === undefined ||
      rest.length !== 0
    ) {
      return refuse("malformed");
    }
    return accept({ kind: "username", lotId, page, pending });
  }
  return undefined;
}
