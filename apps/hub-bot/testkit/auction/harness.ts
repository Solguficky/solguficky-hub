import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Presentation } from "../../src/core/config.js";
import type { LogFields, Logger } from "../../src/core/logging.js";
import { noopTracing } from "../../src/core/tracing.js";
import { createBot } from "../../src/surfaces/auction/bot.js";
import type { PortsFactory } from "../../src/surfaces/auction/clients.js";
import { inspectCall, reportViolations } from "./screen-lint.js";

// Харнесс бота аукциона без Telegram: `botInfo` подставляется, поэтому
// `bot.init()` не ходит в Bot API, а исходящие вызовы записывает трансформер
// grammY. Собран по образцу `bot.test.ts` и `access-matrix.test.ts` ради
// провода L2 (`contour.ts`): там порты настоящие, а Telegram — по-прежнему
// запись. Код бота хаба сюда не импортируется (ADR-044); форму записи
// `RecordedCall` модель разговора kit хаба читает структурно.

export const botInfo: UserFromGetMe = {
  // Тот же id, что у харнесса хаба: модель разговора ставит его в
  // `reply_to_message.from`, а бот принимает ответ на вопрос только от себя
  // (`ctx.me.id`). Другой id здесь молча выглядел бы как «бот молчит».
  id: 1,
  is_bot: true,
  first_name: "stub",
  username: "stub_auction_bot",
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

// Отправляющие методы получают номер сообщения `100 + порядковый номер вызова`
// — соглашение модели разговора kit хаба (`conversation.ts`): по нему она
// склеивает правку с отправкой, а `answer <n>` пульта находит вопрос. Правка
// номер несёт сама.
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
 * `calls` передаётся снаружи, когда рестарт процесса нужно показать в том же
 * чате: новый бот теряет память о вопросах и кэш фото, а история сообщений
 * у человека остаётся.
 */
export function createHarness(
  ports: PortsFactory,
  calls: RecordedCall[] = [],
  options: { presentation?: Presentation; timeZone?: string } = {},
) {
  const { logger, records } = createCapturingLogger();
  const bot = createBot({
    token: "111:test-token",
    environment: "prod",
    tracing: noopTracing(),
    ...(options.presentation === undefined
      ? {}
      : { presentation: options.presentation }),
    ports,
    logger,
    timeZone: options.timeZone ?? "Europe/Moscow",
    botInfo,
  });
  const recorder: Transformer = (_prev, method, payload) => {
    calls.push({ method, payload });
    // Каждый экран сверяется с каталогом и дизайн-кодом в момент отправки;
    // найденное снимает хук набора (`lint-setup.ts`) либо пульт.
    reportViolations(inspectCall(method, payload));
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
    if (rich !== undefined) {
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
    if (sendingMethods.has(method)) {
      return Promise.resolve({
        ok: true,
        result: { message_id: 100 + calls.length, date: 0, chat } as never,
      });
    }
    return Promise.resolve({ ok: true, result: true as never });
  };
  bot.api.config.use(recorder);
  return { bot, calls, records, logger };
}
