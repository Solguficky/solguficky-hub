import type { Message, MessageEntity, Update } from "grammy/types";
import {
  tokenToUuid,
  uuidToToken,
} from "../src/presentation/meetup-deep-link.js";
import { botInfo, type RecordedCall } from "./harness.js";

// Разговор человека с ботом словами сценария: «написал», «нажал кнопку»,
// «видит на экране». Структуры Telegram — update, callback_data, ForceReply —
// собираются здесь, поэтому сценарий уровня L2 их не знает вовсе
// (telegram-bot.md, «Угловые случаи», пункт 10).

type Button = { text: string; data: string };

type Screen = {
  messageId: number;
  text: string;
  entities: readonly MessageEntity[];
  buttons: readonly Button[];
  asksForReply: boolean;
};

export type Person = {
  /** Пишет боту. Висит вопрос формы — это ответ на него, как в клиенте Telegram. */
  says(text: string): Promise<void>;
  /**
   * Отвечает на `number`-й по счёту вопрос бота в этом чате, а не на
   * последний: так в клиенте выбирают «Ответить» на старом сообщении.
   */
  answers(number: number, text: string): Promise<void>;
  /** Нажимает кнопку с этой подписью на последнем изменённом экране, где она сейчас есть. */
  presses(label: string): Promise<void>;
  /** Два нажатия одной кнопки, быстрее, чем бот успевает ответить на первое. */
  pressesTwice(label: string): Promise<void>;
  /** Нажимает кнопку экрана, отрисованного прошлым релизом бота. */
  pressesFromOlderRelease(label: string): Promise<void>;
  /** Открывает ссылку на сходку из чата сообщества. */
  opensLink(meetupId: string): Promise<void>;
  /** Текст последнего экрана: нового сообщения или правки. */
  sees(): string;
  /** Подписи кнопок последнего экрана. */
  buttons(): string[];
  /** Сколько сообщений бота в чате: правка экрана их не прибавляет. */
  messages(): number;
};

export function startConversation(
  bot: { handleUpdate(update: Update): Promise<unknown> },
  calls: readonly RecordedCall[],
  telegramUserId: bigint,
  options: { username?: string } = {},
): Person {
  const userId = Number(telegramUserId);
  const chat = { id: userId, type: "private" as const, first_name: "tester" };
  const from = {
    id: userId,
    is_bot: false,
    first_name: "tester",
    ...(options.username === undefined ? {} : { username: options.username }),
  };
  let updateId = 0;
  let messageId = 0;

  const screens = (): Screen[] => readScreens(calls, userId);

  const lastScreen = (): Screen => {
    const all = screens();
    const last = all.at(-1);
    if (last === undefined) {
      throw new Error("бот ещё ничего не показал");
    }
    return last;
  };

  const write = async (text: string, replyTo?: Screen): Promise<void> => {
    messageId += 1;
    const message: Message.TextMessage = {
      message_id: messageId,
      date: 0,
      chat,
      from,
      text,
      ...(replyTo === undefined
        ? {}
        : {
            reply_to_message: {
              message_id: replyTo.messageId,
              date: 0,
              chat,
              from: { id: botInfo.id, is_bot: true, first_name: "stub" },
              text: replyTo.text,
              // Telegram возвращает сущности вопроса в ответе: по ним бот
              // после рестарта восстанавливает шаг точечной правки.
              entities: [...replyTo.entities],
              // ReplyMessage в grammY пересекает Message с обязательным
              // `undefined`-полем, и под exactOptionalPropertyTypes такой тип
              // не населён.
            } as never,
          }),
    };
    updateId += 1;
    await bot.handleUpdate({ update_id: updateId, message } as Update);
  };

  const findButton = (label: string): { screen: Screen; button: Button } => {
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
    return { screen, button };
  };

  const press = (screen: Screen, data: string): Promise<unknown> => {
    updateId += 1;
    return bot.handleUpdate({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        chat_instance: `chat-${userId}`,
        from,
        data,
        message: { message_id: screen.messageId, date: 0, chat },
      },
    });
  };

  return {
    async says(text) {
      const last = screens().at(-1);
      await write(text, last?.asksForReply === true ? last : undefined);
    },
    async answers(number, text) {
      // Вопрос с ForceReply бот не правит, поэтому его номер сообщения растёт
      // в порядке, в котором вопросы задавались.
      const questions = screens()
        .filter((screen) => screen.asksForReply)
        .sort((left, right) => left.messageId - right.messageId);
      const question = questions[number - 1];
      if (question === undefined) {
        throw new Error(
          `вопроса №${number} нет: бот задал ${questions.length}`,
        );
      }
      await write(text, question);
    },
    async presses(label) {
      const { screen, button } = findButton(label);
      await press(screen, button.data);
    },
    async pressesTwice(label) {
      const { screen, button } = findButton(label);
      await Promise.all([
        press(screen, button.data),
        press(screen, button.data),
      ]);
    },
    async pressesFromOlderRelease(label) {
      const { screen, button } = findButton(label);
      // Версия — первый сегмент данных кнопки; релиз, которого этот бот не
      // знает, отличается только ею.
      const [, ...rest] = button.data.split(":");
      await press(screen, ["v0", ...rest].join(":"));
    },
    async opensLink(meetupId) {
      await write(`/start m_${uuidToToken(meetupId)}`);
    },
    sees() {
      return lastScreen().text;
    },
    buttons() {
      return lastScreen().buttons.map((button) => button.text);
    },
    messages() {
      return screens().length;
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

type ScreenPayload = {
  chat_id?: unknown;
  text?: unknown;
  parse_mode?: unknown;
  rich_message?: { html?: unknown };
  entities?: MessageEntity[];
  message_id?: unknown;
  reply_markup?: {
    force_reply?: boolean;
    inline_keyboard?: { text: string; callback_data?: string }[][];
  };
};

const namedEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Видимый текст HTML карточки сходки. Разметку собирает бот сам
 * (`meetupCardHtml`, `meetupCardPlainHtml`): `<h1>`, `<p>`, `<br>`, `<b>` и
 * `<a href>`, а сущности — только те, что даёт его `escapeHtml`. `<br>` и
 * конец блока дают перевод строки, остальные теги снимаются. Сущности
 * раскрываются одним проходом после снятия тегов: так `&amp;lt;` остаётся
 * `&lt;`, а экранированный `&lt;b&gt;` — текстом, а не тегом.
 */
function visibleHtmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/(?:p|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
      const lower = name.toLowerCase();
      if (!lower.startsWith("#")) return namedEntities[lower] ?? entity;
      const code = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    .replace(/\n+$/, "");
}

/**
 * Экраны чата в том виде, в каком их сейчас видит человек: одно сообщение —
 * один экран с последним текстом и последней клавиатурой, по порядку
 * последнего изменения. Правка без клавиатуры клавиатуру снимает, как в
 * Telegram, поэтому кнопку с уже переписанного экрана нажать нельзя. Чужие
 * чаты отсекаются: записи харнесса общие на весь файл.
 */
function readScreens(calls: readonly RecordedCall[], chatId: number): Screen[] {
  const current = new Map<number, Screen>();
  calls.forEach((call, index) => {
    const payload = call.payload as ScreenPayload;
    if (payload.chat_id !== chatId) return;
    // Номер сообщения повторяет запись харнесса: отправленное сообщение
    // получает `100 + порядковый номер вызова`, правка несёт свой.
    const sent =
      call.method === "sendMessage" || call.method === "sendRichMessage";
    const messageId = sent
      ? 100 + index + 1
      : typeof payload.message_id === "number"
        ? payload.message_id
        : undefined;
    if (messageId === undefined) return;
    const previous = current.get(messageId);
    // Карточка сходки рисуется богатым сообщением (ADR-034): его текст — HTML
    // в `rich_message`, а не в `text`. Запасная карточка приходит в `text` с
    // `parse_mode: "HTML"`. Человек видит оба без разметки, поэтому экран
    // хранит видимый текст, а entities богатого экрана остаются пустыми: DSL
    // читает их только у вопросов ForceReply.
    const text =
      typeof payload.text === "string"
        ? payload.parse_mode === "HTML"
          ? visibleHtmlText(payload.text)
          : payload.text
        : typeof payload.rich_message?.html === "string"
          ? visibleHtmlText(payload.rich_message.html)
          : undefined;
    let next: Screen | undefined;
    if ((sent || call.method === "editMessageText") && text !== undefined) {
      next = {
        messageId,
        text,
        entities: payload.entities ?? [],
        buttons: readButtons(payload),
        asksForReply: payload.reply_markup?.force_reply === true,
      };
    } else if (
      call.method === "editMessageReplyMarkup" &&
      previous !== undefined
    ) {
      next = { ...previous, buttons: readButtons(payload) };
    }
    if (next === undefined) return;
    current.delete(messageId);
    current.set(messageId, next);
  });
  return [...current.values()];
}

function readButtons(payload: ScreenPayload): Button[] {
  return (payload.reply_markup?.inline_keyboard ?? [])
    .flat()
    .flatMap((button) =>
      button.callback_data === undefined
        ? []
        : [{ text: button.text, data: button.callback_data }],
    );
}
