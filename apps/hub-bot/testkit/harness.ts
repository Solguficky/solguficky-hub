import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Presentation } from "../src/core/config.js";
import type { LogFields, Logger } from "../src/core/logging.js";
import type { Surface } from "../src/core/surface.js";
import { noopTracing, type Tracing } from "../src/core/tracing.js";
import { createBot as createAuctionBot } from "../src/surfaces/auction/bot.js";
import type { PortsFactory } from "../src/surfaces/auction/clients.js";
import type { Dispatcher } from "../src/surfaces/hub/application/dispatcher.js";
import { createDispatcher } from "../src/surfaces/hub/application/dispatcher.js";
import { inMemberCircle } from "../src/surfaces/hub/application/hub-access.js";
import type {
  ApplicationAdministrator,
  ApplicationModerator,
  CommunityAdministrator,
  IdentityResolver,
  RoleRequester,
  SourceChannelAdministrator,
} from "../src/surfaces/hub/identity/port.js";
import {
  type BotRuntime,
  createBot,
} from "../src/surfaces/hub/presentation/bot.js";
import { inspectCall, reportViolations } from "./screen-lint.js";

// Харнесс обеих поверхностей без Telegram: `botInfo` подставляется, поэтому
// `bot.init()` не ходит в Bot API, а исходящие вызовы записывает трансформер
// grammY. Общий для L0 (`bot.test.ts`, соседи подменены) и L2
// (`tests/contour/bot-wire`, соседи настоящие): уровни различаются тем, что
// передано в порты, а не устройством харнесса. Запись вызовов и линтер экрана у
// поверхностей одни, бот — свой у каждой.

// Один id у обеих поверхностей: модель разговора ставит его в
// `reply_to_message.from`, а бот принимает ответ на вопрос только от себя
// (`ctx.me.id`). Другой id молча выглядел бы как «бот молчит».
export const botInfo: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "stub",
  username: "stub_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export type ApiMethod = Parameters<Transformer>[1];
export type ApiPayload = Parameters<Transformer>[2];

export type RecordedCall = {
  method: ApiMethod;
  payload: ApiPayload;
};

export type LogRecord = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: LogFields;
};

export const auctionBotInfo: UserFromGetMe = {
  ...botInfo,
  username: "stub_auction_bot",
};

// Отправляющие методы получают номер сообщения `100 + порядковый номер вызова`
// — соглашение модели разговора (`conversation.ts`): по нему она склеивает
// правку с отправкой, а `answer <n>` пульта находит вопрос. Правка номер несёт
// сама.
const sendingMethods: ReadonlySet<string> = new Set([
  "sendMessage",
  "sendRichMessage",
  "sendDocument",
  "sendPhoto",
]);

// Блок фото в ответе на rich-сообщение с загрузкой: бот берёт `file_id`
// наибольшего размера в кэш, и без блока писал бы warn на каждой холодной
// карточке (`lot image file_id missing in response`).
const photoBlock = {
  type: "photo",
  photo: [
    { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
    { file_id: "large", file_unique_id: "l", width: 800, height: 800 },
  ],
};

export type Respond = (method: ApiMethod, payload: ApiPayload) => unknown;

// Записывающий трансформер: вызов уходит в `calls`, экран сверяется с
// каталогом поверхности и дизайн-кодом в момент отправки — найденное снимает
// хук набора (`lint-setup.ts`) либо пульт, — а ответ Telegram подставляется.
function recorder(
  surface: Surface,
  calls: RecordedCall[],
  respond?: Respond,
): Transformer {
  return (_prev, method, payload) => {
    calls.push({ method, payload });
    reportViolations(inspectCall(surface, method, payload));
    // Ответ с полем `ok` — готовый ответ Bot API, в том числе отказ: из него
    // grammY сам соберёт GrammyError. Остальное — результат успешного вызова.
    const answer = respond?.(method, payload);
    if (answer instanceof Error) return Promise.reject(answer);
    if (typeof answer === "object" && answer !== null && "ok" in answer) {
      return Promise.resolve(answer as never);
    }
    if (answer !== undefined) {
      return Promise.resolve({ ok: true, result: answer as never });
    }
    const chatId = (payload as { chat_id?: unknown }).chat_id;
    const chat = {
      id: typeof chatId === "number" ? chatId : 42,
      type: "private",
      first_name: "tester",
    };
    // Rich-сообщение и его правка отвечают сообщением: из него бот читает
    // `file_id` загруженного фото. Тип результата зависит от метода, и
    // фикстура его не знает — то же ослабление, что у `true` ниже.
    const rich = (payload as { rich_message?: { media?: unknown[] } })
      .rich_message;
    if (surface === "auction" && rich !== undefined) {
      // Правка отвечает тем же сообщением, отправка — новым номером по
      // соглашению модели разговора.
      const edited = (payload as { message_id?: unknown }).message_id;
      return Promise.resolve({
        ok: true,
        result: {
          message_id: typeof edited === "number" ? edited : 100 + calls.length,
          date: 0,
          chat,
          rich_message: {
            blocks: rich.media === undefined ? [] : [photoBlock],
          },
        } as never,
      });
    }
    if (
      surface === "auction"
        ? sendingMethods.has(method)
        : method === "sendMessage"
    ) {
      return Promise.resolve({
        ok: true,
        result: { message_id: 100 + calls.length, date: 0, chat } as never,
      });
    }
    return Promise.resolve({ ok: true, result: true as never });
  };
}

export function createCapturingLogger(): {
  logger: Logger;
  records: LogRecord[];
} {
  const records: LogRecord[] = [];
  const push =
    (level: LogRecord["level"]): Logger[LogRecord["level"]] =>
    (message, fields) => {
      records.push({ level, message, fields: fields ?? {} });
    };
  return {
    records,
    logger: {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    },
  };
}

/**
 * Что ещё получает бот: экраны аукциона и их память процесса, а также ответ
 * Telegram на вызов, которому мало `true`, — например, правка rich-сообщения
 * с загрузкой фото, из ответа которой бот берёт `file_id`.
 */
export type HarnessOptions = Partial<
  Pick<
    BotRuntime,
    | "auction"
    | "auctionParents"
    | "lotPhotos"
    | "communityTimeZone"
    | "auctionBotUsername"
    | "files"
  >
> & {
  respond?: Respond;
};

/**
 * Вход на `/start` для фейка, у которого его нет: ответ выводится из его же
 * разрешения личности, как ответил бы Identity человеку с такой личностью —
 * заблокированному `blocked`, кругу `member` «уже есть», остальным заявку.
 * Тест, которому важен сам вход, передаёт `requestRole` явно.
 */
export function withEntry<T extends IdentityResolver & Partial<RoleRequester>>(
  identity: T,
): T & RoleRequester {
  if (identity.requestRole !== undefined) {
    // Поле проверено строкой выше; сужение обобщённого `T` компилятор до
    // пересечения не доводит.
    return identity as T & RoleRequester;
  }
  return {
    ...identity,
    async requestRole(input, meta) {
      const resolved = await identity.resolve(
        {
          telegramUserId: input.telegramUserId,
          ...(input.telegramUsername === undefined
            ? {}
            : { telegramUsername: input.telegramUsername }),
        },
        meta,
      );
      if (resolved.kind !== "resolved") return resolved;
      return {
        kind: "answered",
        identityId: resolved.identityId,
        globalRoles: resolved.globalRoles,
        outcome: resolved.blocked
          ? "blocked"
          : inMemberCircle(resolved.globalRoles)
            ? "already-held"
            : "pending",
      };
    },
  };
}

/**
 * `calls` передаётся снаружи, когда рестарт процесса нужно показать в том же
 * чате: новый бот теряет память, а история сообщений у человека остаётся.
 */
export function createHarness(
  identity: IdentityResolver &
    Partial<RoleRequester> &
    Partial<CommunityAdministrator> &
    Partial<ApplicationAdministrator> &
    Partial<SourceChannelAdministrator> &
    Partial<ApplicationModerator>,
  dispatcher: Dispatcher = createDispatcher(),
  calls: RecordedCall[] = [],
  tracing: Tracing = noopTracing(),
  presentation?: "rich" | "plain",
  /** Закреплённый день сообщества: от него зависят заготовки дат. */
  today?: () => { year: number; month: number; day: number },
  options: HarnessOptions = {},
) {
  const { logger, records } = createCapturingLogger();
  const { respond, ...runtime } = options;
  const bot = createBot({
    token: "111:test-token",
    dispatcher,
    identity: withEntry(identity),
    logger,
    tracing,
    ...(presentation === undefined ? {} : { presentation }),
    ...(today === undefined ? {} : { today }),
    ...runtime,
  });
  bot.botInfo = botInfo;
  bot.api.config.use(recorder("hub", calls, respond));
  return { bot, calls, records };
}

/**
 * Харнесс поверхности аукциона. `calls` передаётся снаружи, когда рестарт
 * процесса нужно показать в том же чате: новый бот теряет память о вопросах и
 * кэш фото, а история сообщений у человека остаётся.
 */
export function createAuctionHarness(
  ports: PortsFactory,
  calls: RecordedCall[] = [],
  options: { presentation?: Presentation; timeZone?: string } = {},
) {
  const { logger, records } = createCapturingLogger();
  const bot = createAuctionBot({
    token: "111:test-token",
    environment: "prod",
    tracing: noopTracing(),
    ...(options.presentation === undefined
      ? {}
      : { presentation: options.presentation }),
    ports,
    logger,
    timeZone: options.timeZone ?? "Europe/Moscow",
    botInfo: auctionBotInfo,
  });
  bot.api.config.use(recorder("auction", calls));
  return { bot, calls, records, logger };
}
