import { z } from "zod";
import type { FulfillmentMethod } from "./ports.js";
import {
  type PredictionNomination,
  type PredictionRound,
  predictionNominationCode,
  predictionNominationFromCode,
  predictionRoundCode,
  predictionRoundFromCode,
  predictionSpec,
} from "./prediction-spec.js";

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
// - `explain` — «Как это работает» под вопросом лимита (PER-517): тот же
//   вопрос заново, с пояснением автоставки.
// - `username` — выбрать ник своим именем в аукционе. Команда, ради которой
//   выбирается имя, едет в кнопке, чтобы после выбора вернуться к ней.
//
// - `fb` — «Поставить N» карточки финала (PER-336): лот, сумма и страница.
//   Подтверждения нет (ADR-049): сумма — ожидаемая цена, и устаревшая кнопка
//   получает отказ с новой ценой, а не чужую ставку. `op_id` рождается на
//   нажатии: два нажатия — два намерения, и второе Auction отклонит.
//
// Кнопка лота после принятой команды несёт третий аргумент — версию лота из
// ответа Auction в base36 (PER-470): карточка дочитывает лот до неё, потому что
// чтение отстаёт от команды. У остальных кнопок лота хвоста нет.
export type AuctionCommand = "bid" | "proxy";

// Команда, отложенная до выбора имени: её вид и сумма.
// `final` — ставка, начатая кнопкой «Поставить» карточки финала (PER-713):
// после выбора имени она уходит сразу, без подтверждения. Ставка онлайн-недели
// ждёт своего «Да», даже если лот за это время вышел в финал.
export type PendingCommand = {
  command: AuctionCommand;
  amount: number;
  final?: true;
};

export type AuctionQuestion = "bid" | "proxy" | "alias";

export type AuctionIntent =
  // Корень аукциона (PER-605): стадия, сроки и входы в лоты и розыгрыш.
  | { kind: "root"; auctionId: string }
  | { kind: "feed"; auctionId: string; page: number }
  // Раздел ленты (PER-719): номер раздела выбрал пульт, лоты — в порядке
  // администратора, листание — по ним. Раздела нет — открывается лента.
  | { kind: "section"; auctionId: string; sectionId: number; page: number }
  | { kind: "lot"; lotId: string; page: number; atLeastVersion?: number }
  // Экран сета (ADR-073, п. 7): открывается с карточки лота сета, поэтому
  // несёт его — сет читается из снимка лота. `page` — страница ленты, с
  // которой открыли карточку: ею возвращается и карточка лота сета.
  | { kind: "set"; lotId: string; page: number }
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
  | { kind: "username"; lotId: string; page: number; pending: PendingCommand }
  | { kind: "final-bid"; lotId: string; amount: number; page: number }
  | { kind: "explain"; lotId: string; page: number }
  // Избранное (PER-495): отметка и снятие с карточки возвращают на ту же
  // карточку, поэтому несут страницу ленты, как кнопка лота.
  | { kind: "follow"; lotId: string; page: number }
  | { kind: "unfollow"; lotId: string; page: number }
  // Список избранного. `auctionId` — лента, из корня которой список открыт:
  // туда ведёт возврат. Нет — список открыт из меню оболочки.
  | { kind: "favorites"; page: number; auctionId?: string }
  // Розыгрыш среди участников (ADR-066): экран, регистрация и её отмена, а
  // для регистрации без имени — выбор имени, как у ставки: ник, вопрос
  // псевдонима и его шаг с адресатом. `op_id` команды рождается на нажатии:
  // повторная регистрация возвращает ту же, второго билета не бывает.
  | { kind: "prediction-results"; auctionId: string }
  // Хроники дня (PER-725): номинации последних суток из корня аукциона.
  | { kind: "day-chronicle"; auctionId: string }
  // Промо-видео аукциона (PER-774): пост чата медиа ботов новым сообщением.
  | { kind: "promo"; auctionId: string }
  | { kind: "raffle"; auctionId: string }
  | { kind: "raffle-register"; auctionId: string }
  | { kind: "raffle-cancel"; auctionId: string }
  // Как проверить честность (PER-618): отпечаток, раунд маяка, раскрытие и
  // пересчёт — отдельным экраном за кнопкой розыгрыша.
  | { kind: "raffle-proof"; auctionId: string }
  | { kind: "raffle-username"; auctionId: string }
  | { kind: "raffle-ask-alias"; auctionId: string }
  | { kind: "raffle-question"; auctionId: string; addressee: number }
  // Прогнозы (ADR-067): экран, выбор номинации, страница лотов, ответ и очистка.
  | {
      kind: "prediction";
      auctionId: string;
      round: PredictionRound;
    }
  | {
      kind: "prediction-edit";
      auctionId: string;
      round: PredictionRound;
      nomination: PredictionNomination;
    }
  | {
      kind: "prediction-lots";
      auctionId: string;
      round: PredictionRound;
      nomination: PredictionNomination;
      page: number;
    }
  | {
      kind: "prediction-lot";
      auctionId: string;
      round: PredictionRound;
      nomination: PredictionNomination;
      lotId: string;
    }
  | {
      kind: "prediction-clear";
      auctionId: string;
      round: PredictionRound;
      nomination: PredictionNomination;
    }
  | {
      kind: "prediction-username";
      auctionId: string;
      round: PredictionRound;
      nomination: PredictionNomination;
    }
  | {
      kind: "prediction-ask-alias";
      auctionId: string;
      round: PredictionRound;
      nomination: PredictionNomination;
    }
  | {
      kind: "prediction-number-question";
      auctionId: string;
      round: PredictionRound;
      nomination: PredictionNomination;
      addressee: number;
    }
  | {
      kind: "prediction-alias-question";
      auctionId: string;
      round: PredictionRound;
      nomination: PredictionNomination;
      addressee: number;
    }
  // Имя в аукционе из настроек (PER-595): экран имени, ник, вопрос псевдонима
  // и его шаг с адресатом. Аукцион — идущий: его находит оболочка.
  | { kind: "name"; auctionId: string }
  | { kind: "name-username"; auctionId: string }
  | { kind: "name-ask-alias"; auctionId: string }
  | { kind: "name-question"; auctionId: string; addressee: number }
  // Счета победителя (PER-322): список аукциона из его корня, счёт и выбор
  // способа получения. Счёт несёт свой лот: по нему экран находит аукцион и
  // название, а кнопку счёта в напоминании строит канал, который аукциона не
  // знает. `op_id` выбора рождается на нажатии: выбор — замена, и повтор того
  // же способа ничего не портит.
  | { kind: "invoices"; auctionId: string }
  | { kind: "invoice"; lotId: string; invoiceId: string }
  | {
      kind: "fulfillment";
      lotId: string;
      invoiceId: string;
      method: FulfillmentMethod;
    };

// Действия с одним токеном аукциона и шаг вопроса с адресатом — у розыгрыша и
// у имени из настроек.
const AUCTION_ACTION = {
  "prediction-results": "pi",
  "day-chronicle": "dc",
  promo: "pv",
  raffle: "rf",
  "raffle-register": "rr",
  "raffle-cancel": "rc",
  "raffle-proof": "rp",
  "raffle-username": "ru",
  "raffle-ask-alias": "ra",
  name: "nm",
  "name-username": "nn",
  "name-ask-alias": "na",
  invoices: "iv",
} as const;

type AuctionActionKind = keyof typeof AUCTION_ACTION;

// Способ получения одной буквой: у способа одно написание, как у токена.
const FULFILLMENT_CODE: Record<FulfillmentMethod, string> = {
  pickup: "p",
  delivery: "d",
  digital: "g",
};

function fulfillmentOf(
  code: string | undefined,
): FulfillmentMethod | undefined {
  return (Object.keys(FULFILLMENT_CODE) as FulfillmentMethod[]).find(
    (method) => FULFILLMENT_CODE[method] === code,
  );
}

const AUCTION_QUESTION = {
  rq: "raffle-question",
  nq: "name-question",
} as const;

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

// Версия лота — положительное целое в пределах безопасного в base36 без
// ведущих нулей: у версии одно написание.
const VERSION_ARGUMENT = /^[1-9a-z][0-9a-z]{0,10}$/;

function versionArgument(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError(`lot version out of range: ${version}`);
  }
  return version.toString(36);
}

function versionOf(raw: string): number | undefined {
  if (!VERSION_ARGUMENT.test(raw)) return undefined;
  const value = parseInt(raw, 36);
  return Number.isSafeInteger(value) ? value : undefined;
}

const COMMAND_CODE: Record<AuctionCommand, string> = { bid: "b", proxy: "x" };

function commandOf(code: string | undefined): AuctionCommand | undefined {
  if (code === "b") return "bid";
  if (code === "x") return "proxy";
  return undefined;
}

// Отложенная команда одним аргументом: код команды и сумма — `bxlc`. Ставка
// финала (PER-713) — свой код `f`: та же ставка, но без подтверждения.
const FINAL_BID_CODE = "f";

function pendingArgument(pending: PendingCommand): string {
  const code =
    pending.final === true ? FINAL_BID_CODE : COMMAND_CODE[pending.command];
  return `${code}${amountArgument(pending.amount)}`;
}

function pendingOf(raw: string | undefined): PendingCommand | undefined {
  if (raw === undefined) return undefined;
  const code = raw.slice(0, 1);
  const amount = amountOf(raw.slice(1));
  if (amount === undefined) return undefined;
  if (code === FINAL_BID_CODE) return { command: "bid", amount, final: true };
  const command = commandOf(code);
  return command === undefined ? undefined : { command, amount };
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
    case "root":
      return `${prefix}:rt:${uuidToToken(intent.auctionId)}`;
    case "feed":
      return `${prefix}:feed:${uuidToToken(intent.auctionId)}:${pageArgument(intent.page)}`;
    case "section":
      return `${prefix}:sec:${uuidToToken(intent.auctionId)}:${sectionArgument(intent.sectionId)}:${pageArgument(intent.page)}`;
    case "lot":
      return [
        `${prefix}:lot`,
        uuidToToken(intent.lotId),
        pageArgument(intent.page),
        ...(intent.atLeastVersion === undefined
          ? []
          : [versionArgument(intent.atLeastVersion)]),
      ].join(":");
    case "set":
      return `${prefix}:st:${uuidToToken(intent.lotId)}:${pageArgument(intent.page)}`;
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
    case "final-bid":
      return `${prefix}:fb:${uuidToToken(intent.lotId)}:${amountArgument(intent.amount)}:${pageArgument(intent.page)}`;
    case "explain":
      return `${prefix}:xe:${uuidToToken(intent.lotId)}:${pageArgument(intent.page)}`;
    case "follow":
      return `${prefix}:fo:${uuidToToken(intent.lotId)}:${pageArgument(intent.page)}`;
    case "unfollow":
      return `${prefix}:uf:${uuidToToken(intent.lotId)}:${pageArgument(intent.page)}`;
    // Страница стоит первой: у списка из меню аукциона хвоста нет.
    case "favorites":
      return [
        `${prefix}:fav`,
        pageArgument(intent.page),
        ...(intent.auctionId === undefined
          ? []
          : [uuidToToken(intent.auctionId)]),
      ].join(":");
    case "prediction-results":
    case "day-chronicle":
    case "promo":
    case "raffle":
    case "raffle-register":
    case "raffle-cancel":
    case "raffle-proof":
    case "raffle-username":
    case "raffle-ask-alias":
    case "name":
    case "name-username":
    case "name-ask-alias":
    case "invoices":
      return `${prefix}:${AUCTION_ACTION[intent.kind]}:${uuidToToken(intent.auctionId)}`;
    case "invoice":
      return `${prefix}:ia:${uuidToToken(intent.lotId)}:${uuidToToken(intent.invoiceId)}`;
    case "fulfillment":
      return `${prefix}:im:${uuidToToken(intent.lotId)}:${uuidToToken(intent.invoiceId)}:${FULFILLMENT_CODE[intent.method]}`;
    case "raffle-question":
      return `${prefix}:rq:${uuidToToken(intent.auctionId)}:${addresseeArgument(intent.addressee)}`;
    case "prediction":
      return `${prefix}:pr:${uuidToToken(intent.auctionId)}:${predictionRoundCode(intent.round)}`;
    case "prediction-edit":
      return `${prefix}:pe:${uuidToToken(intent.auctionId)}:${predictionRoundCode(intent.round)}:${predictionNominationCode(intent.nomination)}`;
    case "prediction-lots":
      return `${prefix}:ps:${uuidToToken(intent.auctionId)}:${predictionRoundCode(intent.round)}:${predictionNominationCode(intent.nomination)}:${pageArgument(intent.page)}`;
    case "prediction-lot":
      return `${prefix}:pl:${uuidToToken(intent.auctionId)}:${predictionRoundCode(intent.round)}:${predictionNominationCode(intent.nomination)}:${uuidToToken(intent.lotId)}`;
    case "prediction-clear":
      return `${prefix}:pc:${uuidToToken(intent.auctionId)}:${predictionRoundCode(intent.round)}:${predictionNominationCode(intent.nomination)}`;
    case "prediction-username":
      return `${prefix}:pu:${uuidToToken(intent.auctionId)}:${predictionRoundCode(intent.round)}:${predictionNominationCode(intent.nomination)}`;
    case "prediction-ask-alias":
      return `${prefix}:pa:${uuidToToken(intent.auctionId)}:${predictionRoundCode(intent.round)}:${predictionNominationCode(intent.nomination)}`;
    case "prediction-number-question":
      return `${prefix}:pn:${uuidToToken(intent.auctionId)}:${predictionRoundCode(intent.round)}:${predictionNominationCode(intent.nomination)}:${addresseeArgument(intent.addressee)}`;
    case "prediction-alias-question":
      return `${prefix}:pq:${uuidToToken(intent.auctionId)}:${predictionRoundCode(intent.round)}:${predictionNominationCode(intent.nomination)}:${addresseeArgument(intent.addressee)}`;
    case "name-question":
      return `${prefix}:nq:${uuidToToken(intent.auctionId)}:${addresseeArgument(intent.addressee)}`;
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
  if (action === "fav") return favoritesAction(args);
  if (action === "rt") return rootAction(args);
  if (action === "sec") return sectionAction(args);
  if (action === "ia" || action === "im") return invoiceAction(action, args);
  const prediction = predictionAction(action, args);
  if (prediction !== undefined) return prediction;
  const byAuction = auctionAction(action, args);
  if (byAuction !== undefined) return byAuction;
  // Аргументов у действия ровно столько, сколько пишет его кодировщик: лишний
  // аргумент — не та строка, а не страница, которую можно молча отбросить.
  const [token, rawPage, ...rest] = args;
  const extra = action === "hist" ? 1 : 0;
  // Лот — с версией или без: хвост версии необязателен.
  const allowed = action === "lot" && rest.length === 1 ? 1 : extra;
  if (token === undefined || rest.length !== allowed) {
    return refuse("malformed");
  }
  const id = tokenToUuid(token);
  // Кнопка лота без страницы — форма PER-305: она ведёт на ту же карточку, а
  // возврат — на первую страницу ленты.
  const page = action === "lot" && rawPage === undefined ? 0 : pageOf(rawPage);
  if (id === undefined || page === undefined) return refuse("malformed");
  switch (action) {
    case "feed":
      return { ok: true, intent: { kind: "feed", auctionId: id, page } };
    case "lot": {
      if (rest[0] === undefined) {
        return { ok: true, intent: { kind: "lot", lotId: id, page } };
      }
      const atLeastVersion = versionOf(rest[0]);
      if (atLeastVersion === undefined) return refuse("malformed");
      return {
        ok: true,
        intent: { kind: "lot", lotId: id, page, atLeastVersion },
      };
    }
    case "fo":
      return { ok: true, intent: { kind: "follow", lotId: id, page } };
    case "st":
      return { ok: true, intent: { kind: "set", lotId: id, page } };
    case "uf":
      return { ok: true, intent: { kind: "unfollow", lotId: id, page } };
    case "xe":
      return { ok: true, intent: { kind: "explain", lotId: id, page } };
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
  return (
    parsed.ok &&
    (parsed.intent.kind === "question" ||
      parsed.intent.kind === "raffle-question" ||
      parsed.intent.kind === "name-question" ||
      parsed.intent.kind === "prediction-number-question" ||
      parsed.intent.kind === "prediction-alias-question")
  );
}

// Кнопка под вопросом, которая задаёт его заново: нажатый вопрос удаляется,
// как по «Отмене», а новый приходит следом (PER-517). Шагом вопроса она не
// является: ответ ищет шаг по `isAuctionQuestion`.
export function replacesAuctionQuestion(raw: unknown): boolean {
  const parsed = parseAuctionCallback(raw);
  return parsed.ok && parsed.intent.kind === "explain";
}

function accept(intent: AuctionIntent): ParsedAuctionCallback {
  return { ok: true, intent };
}

// Прогнозы несут короткий раунд и номер номинации, чтобы выбор лота укладывался
// в лимит Telegram вместе с двумя UUID-токенами.
function predictionAction(
  action: string,
  args: readonly string[],
): ParsedAuctionCallback | undefined {
  const known = ["pr", "pe", "ps", "pl", "pc", "pu", "pa", "pn", "pq"];
  if (!(known as readonly string[]).includes(action)) return undefined;

  const [token, rawRound, rawNomination, tail] = args;
  const auctionId = token === undefined ? undefined : tokenToUuid(token);
  if (auctionId === undefined) return refuse("malformed");
  const round = predictionRoundFromCode(rawRound);
  if (round === undefined) return refuse("malformed");
  if (action === "pr") {
    return args.length === 2
      ? accept({ kind: "prediction", auctionId, round })
      : refuse("malformed");
  }

  const nomination = predictionNominationFromCode(rawNomination);
  if (nomination === undefined || predictionSpec(nomination).round !== round) {
    return refuse("malformed");
  }
  const context = { auctionId, round, nomination };

  if (
    action === "pe" ||
    action === "pc" ||
    action === "pu" ||
    action === "pa"
  ) {
    const kind = {
      pe: "prediction-edit",
      pc: "prediction-clear",
      pu: "prediction-username",
      pa: "prediction-ask-alias",
    } as const;
    return args.length === 3
      ? accept({ kind: kind[action], ...context })
      : refuse("malformed");
  }
  if (action === "ps") {
    const page = pageOf(tail);
    return predictionSpec(nomination).answer === "lot" &&
      args.length === 4 &&
      page !== undefined
      ? accept({ kind: "prediction-lots", ...context, page })
      : refuse("malformed");
  }
  if (action === "pl") {
    const lotId = tail === undefined ? undefined : tokenToUuid(tail);
    return predictionSpec(nomination).answer === "lot" &&
      args.length === 4 &&
      lotId !== undefined
      ? accept({ kind: "prediction-lot", ...context, lotId })
      : refuse("malformed");
  }
  const addressee = addresseeOf(tail);
  if (args.length !== 4 || addressee === undefined) return refuse("malformed");
  if (action === "pn") {
    return predictionSpec(nomination).answer !== "lot"
      ? accept({ kind: "prediction-number-question", ...context, addressee })
      : refuse("malformed");
  }
  return accept({ kind: "prediction-alias-question", ...context, addressee });
}

// Действия розыгрыша и имени из настроек: токен аукциона и, у шага вопроса,
// адресат. `undefined` — действие не отсюда.
function auctionAction(
  action: string,
  args: readonly string[],
): ParsedAuctionCallback | undefined {
  const kind = (Object.keys(AUCTION_ACTION) as AuctionActionKind[]).find(
    (each) => AUCTION_ACTION[each] === action,
  );
  const question =
    action === "rq" || action === "nq" ? AUCTION_QUESTION[action] : undefined;
  if (kind === undefined && question === undefined) return undefined;
  const [token, rawAddressee, ...rest] = args;
  const auctionId = token === undefined ? undefined : tokenToUuid(token);
  if (auctionId === undefined || rest.length !== 0) return refuse("malformed");
  if (kind !== undefined) {
    return rawAddressee === undefined
      ? accept({ kind, auctionId })
      : refuse("malformed");
  }
  const addressee = addresseeOf(rawAddressee);
  return addressee === undefined || question === undefined
    ? refuse("malformed")
    : accept({ kind: question, auctionId, addressee });
}

// Номер раздела ленты (PER-719) — положительное целое без ведущих нулей до
// семи цифр: его выбирает пульт минутой создания раздела, и в 64 байта он
// помещается с запасом.
const SECTION = /^[1-9]\d{0,6}$/;

function sectionArgument(sectionId: number): string {
  if (!Number.isInteger(sectionId) || sectionId < 1 || sectionId > 9_999_999) {
    throw new RangeError(`feed section out of range: ${sectionId}`);
  }
  return String(sectionId);
}

// Раздел ленты: токен аукциона, номер раздела и страница.
function sectionAction(args: readonly string[]): ParsedAuctionCallback {
  const [token, rawSection, rawPage, ...rest] = args;
  const auctionId = token === undefined ? undefined : tokenToUuid(token);
  const page = pageOf(rawPage);
  if (
    auctionId === undefined ||
    rawSection === undefined ||
    !SECTION.test(rawSection) ||
    page === undefined ||
    rest.length !== 0
  ) {
    return refuse("malformed");
  }
  return accept({
    kind: "section",
    auctionId,
    sectionId: Number(rawSection),
    page,
  });
}

// Счёт победителя: токены лота и счёта и, у выбора способа, его буква.
function invoiceAction(
  action: "ia" | "im",
  args: readonly string[],
): ParsedAuctionCallback {
  const [lotToken, invoiceToken, rawMethod, ...rest] = args;
  const lotId = lotToken === undefined ? undefined : tokenToUuid(lotToken);
  const invoiceId =
    invoiceToken === undefined ? undefined : tokenToUuid(invoiceToken);
  if (lotId === undefined || invoiceId === undefined || rest.length !== 0) {
    return refuse("malformed");
  }
  if (action === "ia") {
    return rawMethod === undefined
      ? accept({ kind: "invoice", lotId, invoiceId })
      : refuse("malformed");
  }
  const method = fulfillmentOf(rawMethod);
  return method === undefined
    ? refuse("malformed")
    : accept({ kind: "fulfillment", lotId, invoiceId, method });
}

// Корень аукциона: ровно один токен аукциона.
function rootAction(args: readonly string[]): ParsedAuctionCallback {
  const [token, ...rest] = args;
  const auctionId = token === undefined ? undefined : tokenToUuid(token);
  return auctionId === undefined || rest.length !== 0
    ? refuse("malformed")
    : accept({ kind: "root", auctionId });
}

// Список избранного: страница и, у списка из ленты, токен её аукциона.
function favoritesAction(args: readonly string[]): ParsedAuctionCallback {
  const [rawPage, rawAuction, ...rest] = args;
  const page = pageOf(rawPage);
  const auctionId =
    rawAuction === undefined ? undefined : tokenToUuid(rawAuction);
  if (
    page === undefined ||
    rest.length !== 0 ||
    (rawAuction !== undefined && auctionId === undefined)
  ) {
    return refuse("malformed");
  }
  return accept({
    kind: "favorites",
    page,
    ...(auctionId === undefined ? {} : { auctionId }),
  });
}

// Действия листа ставки. `undefined` — действие не отсюда: его разбирают
// ветки ленты, лота и хронологии.
function commandAction(
  action: string,
  args: readonly string[],
): ParsedAuctionCallback | undefined {
  const [first, ...more] = args;
  const lotId = first === undefined ? undefined : tokenToUuid(first);
  if (action === "fb") {
    const [rawAmount, rawPage, ...rest] = more;
    const amount = amountOf(rawAmount);
    const page = pageOf(rawPage);
    if (
      lotId === undefined ||
      amount === undefined ||
      page === undefined ||
      rest.length !== 0
    ) {
      return refuse("malformed");
    }
    return accept({ kind: "final-bid", lotId, amount, page });
  }
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
