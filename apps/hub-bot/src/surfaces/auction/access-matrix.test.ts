import type { Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { inspectCall, reportViolations } from "../../../testkit/screen-lint.js";
import {
  type AccessAnswer,
  type AccessMatrixInput,
  describeAccessMatrix,
} from "../../auction-ui/contract/index.js";
import type { Logger } from "../../core/logging.js";
import { noopTracing } from "../../core/tracing.js";
import { createBot } from "./bot.js";
import { deniedTexts } from "./entry-screen.js";

// Матрица доступа аукционного дерева над ботом поверхности аукциона целиком
// (ADR-064, п. 19; ADR-060): update проходит тот же `createBot`, что и в
// проде, а Identity и Auction подменены шпионами матрицы. Ответ читается с
// экрана, который получил человек. FAQ — оболочка бота: в матрице он пройден,
// чтобы допущенный дошёл до экрана.

const botInfo: UserFromGetMe = {
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

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function updateOf({ from, firstName, action }: AccessMatrixInput): Update {
  const sender = {
    id: from.telegramUserId,
    is_bot: false,
    first_name: firstName,
    ...(from.telegramUsername === undefined
      ? {}
      : { username: from.telegramUsername }),
  };
  const chat = {
    id: from.telegramUserId,
    type: "private" as const,
    first_name: firstName,
  };
  if (action.kind === "callback") {
    return {
      update_id: 1,
      callback_query: {
        id: "press",
        chat_instance: "chat",
        from: sender,
        data: action.data,
        message: { message_id: 9, date: 0, chat, text: "Лоты" },
      },
    };
  }
  const text =
    action.sourceCode === undefined
      ? "/start"
      : `/start s_${action.sourceCode}`;
  return {
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat,
      from: sender,
      text,
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    },
  };
}

const refusals: ReadonlyArray<[string, AccessAnswer]> = [
  [deniedTexts["not-admitted"], "pending"],
  [deniedTexts.declined, "declined"],
  [deniedTexts.blocked, "blocked"],
];

describeAccessMatrix("auction bot", "auction", (ports) => async (input) => {
  const bot = createBot({
    token: "111:test-token",
    environment: "prod",
    tracing: noopTracing(),
    // Обычная карточка: её текст лежит в поле `text`, и ответ читается с него.
    presentation: "plain",
    ports: () => ({
      ...ports,
      faq: { acknowledged: async () => true, acknowledge: async () => {} },
      // Списков матрица не открывает: лента без активных возвращает в
      // прошедшие, и доступ от этого не зависит.
      catalog: {
        listAuctions: async () => ({ auctions: [], nextPageToken: "" }),
      },
      // Байты фото доступу не нужны: карточка уходит без изображения.
      image: {
        getLotImage: () => Promise.reject(new Error("no image here")),
      },
    }),
    logger: silent,
    timeZone: "Europe/Moscow",
    botInfo,
  });
  const shown: string[] = [];
  // Результат зависит от метода, фикстура его не знает: единственное
  // ослабление типа в тесте.
  const recorder: Transformer = (_prev, method, payload) => {
    reportViolations(inspectCall("auction", method, payload));
    if ("text" in payload && typeof payload.text === "string") {
      shown.push(payload.text);
    }
    return Promise.resolve({ ok: true, result: true as never });
  };
  bot.api.config.use(recorder);
  await bot.handleUpdate(updateOf(input));

  const [text] = shown;
  if (text === undefined) throw new Error("the person got no answer");
  for (const [refusal, answer] of refusals) {
    if (text === refusal) return answer;
  }
  return text.includes("сейчас недоступен") ? "unavailable" : "admitted";
});
