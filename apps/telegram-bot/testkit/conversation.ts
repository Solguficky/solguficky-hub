import type {
  InlineKeyboardButton,
  Message,
  MessageEntity,
  MessageOrigin,
  Update,
} from "grammy/types";
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

const buttonStyles = ["danger", "success", "primary"] as const;
type ButtonStyle = (typeof buttonStyles)[number];

type KeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
  style?: ButtonStyle;
};

/** Чем нарисован экран: богатым сообщением, HTML-разметкой или текстом как есть. */
export type ScreenFormat = "rich" | "html" | "plain";

type ScreenMedia = { kind: "document" | "photo"; fileId: string };

type Screen = {
  messageId: number;
  text: string;
  entities: readonly MessageEntity[];
  buttons: readonly Button[];
  // Клавиатура целиком, с url-кнопками: Telegram возвращает её в сообщении
  // нажатой кнопки, и бот читает из неё источник материала.
  keyboard: readonly (readonly KeyboardButton[])[];
  asksForReply: boolean;
  // Сообщение было вопросом, даже если бот его уже снял: по этому счёту
  // вопросы нумеруются в том порядке, в каком задавались.
  asked: boolean;
  format: ScreenFormat;
  // Сообщение с файлом: его текст — подпись, и правится оно своим методом.
  media?: ScreenMedia;
  // Сообщение, на которое экран отвечает: Telegram возвращает его в нажатии, и
  // бот читает оттуда текст рассылки.
  replyTo?: number;
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
  /**
   * Пересылает боту пост публичного канала. Висит вопрос — это ответ на него,
   * как `says`.
   */
  forwardsChannelPost(channel: string, postId: number): Promise<void>;
  /** Отправляет боту документ. Висит вопрос — это ответ на него, как `says`. */
  sendsDocument(fileName: string): Promise<void>;
  /** Отправляет боту фотографию. Висит вопрос — это ответ на него, как `says`. */
  sendsPhoto(): Promise<void>;
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
  /**
   * Подписи кнопок, которые сейчас можно нажать на любом экране чата, начиная
   * с последнего. Только подписи: `callback_data` сценарий не видит.
   */
  pressable(): string[];
  /** Сколько сообщений бота в чате: правка экрана их не прибавляет. */
  messages(): number;
  /**
   * Все экраны чата по порядку последнего изменения. Номер сообщения отличает
   * новое сообщение от правки старого: по нему пульт (`bot-wire/console/`)
   * показывает, что изменило действие.
   */
  history(): ScreenView[];
};

export type ButtonView = {
  text: string;
  /** `url` открывает клиент Telegram, а не бот: нажать её в проводе нельзя. */
  kind: "callback" | "url";
  /** `callback_data` либо адрес: по ним видно правку, не менявшую подписей. */
  target: string;
  /** Цвет кнопки, если бот его задал (Bot API 9.4). */
  style?: ButtonStyle;
};

export type ScreenView = {
  message: number;
  text: string;
  buttons: string[];
  /** Клавиатура по рядам, как её отдал бот, вместе с url-кнопками. */
  rows: ButtonView[][];
  format: ScreenFormat;
  /** Сообщение несёт файл, и `text` — его подпись. */
  media?: ScreenMedia["kind"];
  /** Бот ждёт ответа на это сообщение (ForceReply). */
  awaitsReply: boolean;
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

  const write = async (
    content:
      | { text: string; forward_origin?: MessageOrigin }
      | Pick<Message.DocumentMessage, "document">
      | Pick<Message.PhotoMessage, "photo">,
    replyTo?: Screen,
  ): Promise<void> => {
    messageId += 1;
    const message = {
      message_id: messageId,
      date: 0,
      chat,
      from,
      ...content,
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
              // И клавиатуру вопроса: шаг лежит в его кнопке «Отмена».
              ...(replyTo.keyboard.length === 0
                ? {}
                : { reply_markup: { inline_keyboard: replyTo.keyboard } }),
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

  // Сообщение нажатой кнопки приходит в update целиком, как его отдаёт
  // Telegram: текст или файл с подписью, клавиатура с url-кнопками и
  // сообщение, на которое экран отвечал. Бот читает по ним подтверждение
  // материала и текст рассылки — они живут в самом экране, а не в его памяти.
  const press = (screen: Screen, data: string): Promise<unknown> => {
    updateId += 1;
    const repliedTo =
      screen.replyTo === undefined
        ? undefined
        : screens().find((candidate) => candidate.messageId === screen.replyTo);
    const message = {
      message_id: screen.messageId,
      date: 0,
      chat,
      ...pressedContent(screen),
      ...(screen.keyboard.length === 0
        ? {}
        : {
            reply_markup: {
              // Клавиатуру записал сам бот: это `reply_markup`, который он
              // отдал grammY, и Telegram вернул бы её как есть. Тип записи
              // держит только поля, которые харнесс читает.
              inline_keyboard: screen.keyboard as InlineKeyboardButton[][],
            },
          }),
      ...(repliedTo === undefined
        ? {}
        : {
            reply_to_message: {
              message_id: repliedTo.messageId,
              date: 0,
              chat,
              from: { id: botInfo.id, is_bot: true, first_name: "stub" },
              text: repliedTo.text,
            },
          }),
    };
    return bot.handleUpdate({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        chat_instance: `chat-${userId}`,
        from,
        data,
        message,
      },
      // Сообщение с файлом и ответом — другие ветви `Message`, чем текстовое, а
      // `reply_to_message` в grammY под exactOptionalPropertyTypes не населён
      // (см. `write`): форму держит запись бота, из которой экран собран.
    } as Update);
  };

  const answerable = (): Screen | undefined => {
    const last = screens().at(-1);
    return last?.asksForReply === true ? last : undefined;
  };

  return {
    async says(text) {
      await write({ text }, answerable());
    },
    async sendsDocument(fileName) {
      // Идентификатор файла выдаёт Telegram; боту он нужен только как ключ,
      // который вернётся в подтверждении.
      const fileId = `contour-document-${userId}-${messageId + 1}`;
      await write(
        {
          document: {
            file_id: fileId,
            file_unique_id: fileId,
            file_name: fileName,
          },
        },
        answerable(),
      );
    },
    async sendsPhoto() {
      const fileId = `contour-photo-${userId}-${messageId + 1}`;
      await write(
        {
          photo: [
            { file_id: fileId, file_unique_id: fileId, width: 1, height: 1 },
          ],
        },
        answerable(),
      );
    },
    async forwardsChannelPost(channel, postId) {
      await write(
        {
          // Текст поста бот не читает: ему нужен только источник пересылки.
          text: "пост канала",
          forward_origin: {
            type: "channel",
            chat: {
              id: -1001234567890,
              type: "channel",
              title: channel,
              username: channel,
            },
            message_id: postId,
            date: 0,
          } satisfies MessageOrigin,
        },
        answerable(),
      );
    },
    async answers(number, text) {
      // Номер сообщения вопроса растёт в порядке, в котором вопросы задавались.
      // Снятый вопрос из счёта не выпадает: ответить на него в клиенте всё ещё
      // можно, и бот обязан сказать, что вопрос устарел.
      const questions = screens()
        .filter((screen) => screen.asked)
        .sort((left, right) => left.messageId - right.messageId);
      const question = questions[number - 1];
      if (question === undefined) {
        throw new Error(
          `вопроса №${number} нет: бот задал ${questions.length}`,
        );
      }
      await write({ text }, question);
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
      await write({ text: `/start m_${uuidToToken(meetupId)}` });
    },
    sees() {
      return lastScreen().text;
    },
    buttons() {
      return lastScreen().buttons.map((button) => button.text);
    },
    pressable() {
      const labels = screens()
        .reverse()
        .flatMap((screen) => screen.buttons.map((button) => button.text));
      return [...new Set(labels)];
    },
    messages() {
      return screens().length;
    },
    history() {
      return screens().map(viewOf);
    },
  };
}

/**
 * Экраны чата для чтения глазами: то же, что `Person.history()`, но по записи
 * вызовов Bot API без разговора. Вход L0-теста самой модели экранов.
 */
export function readScreenViews(
  calls: readonly RecordedCall[],
  chatId: number,
): ScreenView[] {
  return readScreens(calls, chatId).map(viewOf);
}

function viewOf(screen: Screen): ScreenView {
  return {
    message: screen.messageId,
    text: screen.text,
    buttons: screen.buttons.map((button) => button.text),
    rows: screen.keyboard.map((row) =>
      row.map((button) => ({
        text: button.text,
        kind: button.callback_data === undefined ? "url" : "callback",
        target: button.callback_data ?? button.url ?? "",
        ...(button.style === undefined ? {} : { style: button.style }),
      })),
    ),
    format: screen.format,
    ...(screen.media === undefined ? {} : { media: screen.media.kind }),
    awaitsReply: screen.asksForReply,
  };
}

// Сообщение с файлом Telegram отдаёт подписью и самим файлом, а не текстом: по
// этой разнице бот выбирает, править текст или подпись.
function pressedContent(
  screen: Screen,
):
  | Pick<Message.TextMessage, "text">
  | (Pick<Message.DocumentMessage, "document"> & { caption: string })
  | (Pick<Message.PhotoMessage, "photo"> & { caption: string }) {
  if (screen.media === undefined) return { text: screen.text };
  const file = {
    file_id: screen.media.fileId,
    file_unique_id: screen.media.fileId,
  };
  return screen.media.kind === "document"
    ? { caption: screen.text, document: file }
    : { caption: screen.text, photo: [{ ...file, width: 1, height: 1 }] };
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
  caption?: unknown;
  document?: unknown;
  photo?: unknown;
  parse_mode?: unknown;
  rich_message?: { html?: unknown };
  entities?: MessageEntity[];
  message_id?: unknown;
  reply_parameters?: { message_id?: unknown };
  reply_markup?: {
    force_reply?: boolean;
    inline_keyboard?: KeyboardButton[][];
  };
};

const sendingMethods: ReadonlySet<string> = new Set([
  "sendMessage",
  "sendRichMessage",
  "sendDocument",
  "sendPhoto",
]);

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
    const sent = sendingMethods.has(call.method);
    const messageId = sent
      ? 100 + index + 1
      : typeof payload.message_id === "number"
        ? payload.message_id
        : undefined;
    if (messageId === undefined) return;
    const previous = current.get(messageId);
    // Файл бот отправляет по идентификатору Telegram, а текст такого сообщения
    // — его подпись.
    const media = readMedia(payload) ?? previous?.media;
    // Карточка сходки рисуется богатым сообщением (ADR-034): его текст — HTML
    // в `rich_message`, а не в `text`. Запасная карточка приходит в `text` с
    // `parse_mode: "HTML"`. Человек видит оба без разметки, поэтому экран
    // хранит видимый текст, а entities богатого экрана остаются пустыми: DSL
    // читает их только у вопросов ForceReply.
    const raw =
      typeof payload.text === "string"
        ? payload.text
        : typeof payload.caption === "string"
          ? payload.caption
          : undefined;
    const format: ScreenFormat =
      payload.rich_message !== undefined
        ? "rich"
        : payload.parse_mode === "HTML"
          ? "html"
          : "plain";
    const text =
      raw !== undefined
        ? format === "html"
          ? visibleHtmlText(raw)
          : raw
        : typeof payload.rich_message?.html === "string"
          ? visibleHtmlText(payload.rich_message.html)
          : // Файл без подписи — тоже сообщение в чате.
            sent && media !== undefined
            ? ""
            : undefined;
    const replyTo =
      typeof payload.reply_parameters?.message_id === "number"
        ? payload.reply_parameters.message_id
        : previous?.replyTo;
    let next: Screen | undefined;
    if (
      (sent ||
        call.method === "editMessageText" ||
        call.method === "editMessageCaption") &&
      text !== undefined
    ) {
      next = {
        messageId,
        text,
        entities: payload.entities ?? [],
        buttons: readButtons(payload),
        keyboard: payload.reply_markup?.inline_keyboard ?? [],
        // Вопрос, который бот правит на месте, остаётся вопросом, пока под
        // ним стоит «Отмена» с шагом: так заготовки дня сменяются временем.
        asksForReply:
          payload.reply_markup?.force_reply === true ||
          (previous?.asksForReply === true && carriesQuestionStep(payload)),
        asked:
          payload.reply_markup?.force_reply === true ||
          previous?.asked === true,
        format,
        ...(media === undefined ? {} : { media }),
        ...(replyTo === undefined ? {} : { replyTo }),
      };
    } else if (
      call.method === "editMessageReplyMarkup" &&
      previous !== undefined
    ) {
      const keyboard = payload.reply_markup?.inline_keyboard ?? [];
      next = {
        ...previous,
        buttons: readButtons(payload),
        keyboard,
        // Вопрос, у которого бот снял клавиатуру, ответа больше не ждёт.
        asksForReply: previous.asksForReply && keyboard.flat().length > 0,
      };
      // Снятие клавиатуры сообщение не трогает: внизу чата остаётся то, что
      // пришло последним, а не экран, у которого убрали кнопки.
      if (keyboard.flat().length === 0) {
        current.set(messageId, next);
        return;
      }
    }
    if (next === undefined) return;
    current.delete(messageId);
    current.set(messageId, next);
  });
  return [...current.values()];
}

function carriesQuestionStep(payload: ScreenPayload): boolean {
  const last = payload.reply_markup?.inline_keyboard?.at(-1);
  const data = last?.length === 1 ? last[0]?.callback_data : undefined;
  return typeof data === "string" && data.startsWith("v1:q:");
}

function readMedia(payload: ScreenPayload): ScreenMedia | undefined {
  if (typeof payload.document === "string") {
    return { kind: "document", fileId: payload.document };
  }
  if (typeof payload.photo === "string") {
    return { kind: "photo", fileId: payload.photo };
  }
  return undefined;
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
