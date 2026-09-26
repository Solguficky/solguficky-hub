import type { Message, Update } from "grammy/types";
import { tokenToUuid } from "../src/presentation/meetup-deep-link.js";
import { botInfo, type RecordedCall } from "./harness.js";

// Разговор человека с ботом словами сценария: «написал», «нажал кнопку»,
// «видит на экране». Структуры Telegram — update, callback_data, ForceReply —
// собираются здесь, поэтому сценарий уровня L2 их не знает вовсе
// (telegram-bot.md, «Угловые случаи», пункт 10).

type Screen = {
  messageId: number;
  text: string;
  buttons: readonly { text: string; data: string }[];
  asksForReply: boolean;
};

export type Person = {
  /** Пишет боту. Висит вопрос формы — это ответ на него, как в клиенте Telegram. */
  says(text: string): Promise<void>;
  /** Нажимает кнопку с этой подписью на последнем экране, где она есть. */
  presses(label: string): Promise<void>;
  /** Текст последнего экрана: нового сообщения или правки. */
  sees(): string;
};

export function startConversation(
  bot: { handleUpdate(update: Update): Promise<unknown> },
  calls: readonly RecordedCall[],
  telegramUserId: bigint,
): Person {
  const userId = Number(telegramUserId);
  const chat = { id: userId, type: "private" as const, first_name: "tester" };
  const from = { id: userId, is_bot: false, first_name: "tester" };
  let updateId = 0;
  let messageId = 0;

  const screens = (): Screen[] =>
    calls.flatMap((call, index) => {
      const screen = readScreen(call, index);
      return screen === undefined ? [] : [screen];
    });

  const lastScreen = (): Screen => {
    const all = screens();
    const last = all.at(-1);
    if (last === undefined) {
      throw new Error("бот ещё ничего не показал");
    }
    return last;
  };

  return {
    async says(text) {
      const last = screens().at(-1);
      messageId += 1;
      const message: Message.TextMessage = {
        message_id: messageId,
        date: 0,
        chat,
        from,
        text,
        ...(last?.asksForReply === true
          ? {
              reply_to_message: {
                message_id: last.messageId,
                date: 0,
                chat,
                from: { id: botInfo.id, is_bot: true, first_name: "stub" },
                text: last.text,
                // ReplyMessage в grammY пересекает Message с обязательным
                // `undefined`-полем, и под exactOptionalPropertyTypes такой тип
                // не населён.
              } as never,
            }
          : {}),
      };
      updateId += 1;
      await bot.handleUpdate({ update_id: updateId, message } as Update);
    },
    async presses(label) {
      const screen = screens()
        .reverse()
        .find((candidate) =>
          candidate.buttons.some((button) => button.text === label),
        );
      const button = screen?.buttons.find(
        (candidate) => candidate.text === label,
      );
      if (screen === undefined || button === undefined) {
        throw new Error(
          `кнопки «${label}» нет; последний экран: ${JSON.stringify(lastScreen())}`,
        );
      }
      updateId += 1;
      await bot.handleUpdate({
        update_id: updateId,
        callback_query: {
          id: `callback-${updateId}`,
          chat_instance: `chat-${userId}`,
          from,
          data: button.data,
          message: { message_id: screen.messageId, date: 0, chat },
        },
      });
    },
    sees() {
      return lastScreen().text;
    },
  };
}

/** Сходка, которую бот назвал в ссылке для чата: `https://t.me/<бот>?start=m_<токен>`. */
export function meetupIdFromStartLink(text: string): string {
  const token = /\?start=m_([A-Za-z0-9_-]+)/.exec(text)?.[1];
  if (token === undefined) {
    throw new Error(`в тексте нет ссылки на сходку: ${text}`);
  }
  return tokenToUuid(token);
}

function readScreen(call: RecordedCall, index: number): Screen | undefined {
  if (call.method !== "sendMessage" && call.method !== "editMessageText") {
    return undefined;
  }
  const payload = call.payload as {
    text?: unknown;
    message_id?: unknown;
    reply_markup?: {
      force_reply?: boolean;
      inline_keyboard?: { text: string; callback_data?: string }[][];
    };
  };
  if (typeof payload.text !== "string") {
    return undefined;
  }
  // Номер сообщения повторяет запись харнесса: отправленное сообщение
  // получает `100 + порядковый номер вызова`, правка несёт свой.
  const messageId =
    call.method === "sendMessage"
      ? 100 + index + 1
      : typeof payload.message_id === "number"
        ? payload.message_id
        : 0;
  const buttons = (payload.reply_markup?.inline_keyboard ?? [])
    .flat()
    .flatMap((button) =>
      button.callback_data === undefined
        ? []
        : [{ text: button.text, data: button.callback_data }],
    );
  return {
    messageId,
    text: payload.text,
    buttons,
    asksForReply: payload.reply_markup?.force_reply === true,
  };
}
