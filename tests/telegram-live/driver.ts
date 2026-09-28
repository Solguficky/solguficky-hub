import { readStringSession } from "@mtcute/core/utils.js";
import {
  Conversation,
  MemoryStorage,
  type Message,
  MtTimeoutError,
  networkMiddlewares,
  type Peer,
  TelegramClient,
} from "@mtcute/node";
import { classifyFailure, TelegramLiveFailure } from "./failure.js";
import type { LiveSecrets } from "./session.js";

// Драйвер пользователя из ADR-046, половина B: синтетический аккаунт тестового
// DC пишет боту и читает ответ. Бота в тестовой среде поднимает владелец —
// `aspire run -- --profile hub --telegram-environment test`; драйвер его не
// запускает, чтобы не завести второй поллер рядом с работающим профилем.

export const connectDeadlineMs = 20_000;
export const replyDeadlineMs = 15_000;

export type BotReply = {
  messageId: number;
  text: string;
  callbackData: string[];
};

export type LiveDriver = {
  sendStart(payload?: string): Promise<BotReply>;
  /**
   * Нажимает inline-кнопку под сообщением бота и ждёт правки **этого же**
   * сообщения: так бот отвечает на кнопку, и новое сообщение вместо правки —
   * тоже отказ, а не ответ.
   */
  press(reply: BotReply, callbackData: string): Promise<BotReply>;
  close(): Promise<void>;
};

function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  detail: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TelegramLiveFailure("telegram-unreachable", detail)),
      ms,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function callbackDataOf(message: Message): string[] {
  const markup = message.markup;
  if (markup?.type !== "inline") {
    return [];
  }
  const decoder = new TextDecoder();
  return markup.buttons
    .flat()
    .flatMap(({ type }) =>
      type._ === "inlineButtonTypeCallback" ? [decoder.decode(type.data)] : [],
    );
}

function replyOf(message: Message): BotReply {
  return {
    messageId: message.id,
    text: message.text,
    callbackData: callbackDataOf(message),
  };
}

function sessionRejected(): never {
  throw new TelegramLiveFailure(
    "session-invalid",
    "Telegram не принял строку сессии: получи новую just telegram-live-login",
  );
}

/**
 * Строка сессии несёт адреса своих дата-центров, и mtcute подменяет ими
 * тестовые: продакшн-сессия увела бы соединение в продакшн-DC вопреки
 * `testMode`. Поэтому среда сессии проверяется до соединения, а не после.
 */
export function assertTestSession(session: string): void {
  let testMode: boolean;
  try {
    testMode = readStringSession(session).primaryDcs.main.testMode === true;
  } catch (error) {
    throw new TelegramLiveFailure(
      "session-invalid",
      "строка сессии не разбирается: получи новую just telegram-live-login",
      { cause: error },
    );
  }
  if (!testMode) {
    throw new TelegramLiveFailure(
      "not-test-environment",
      "строка сессии выдана продакшн-DC; контур ходит только в тестовую среду",
    );
  }
}

async function connect(
  client: TelegramClient,
  secrets: LiveSecrets,
): Promise<Peer> {
  await client.start({
    session: secrets.session,
    // Отвергнутую сессию mtcute пытается заменить новым входом, а его
    // Node-обёртка спрашивает номер в stdin: прогон висел бы до дедлайна и
    // падал бы как недоступный Telegram. Вход — только just telegram-live-login.
    phone: sessionRejected,
    code: sessionRejected,
    password: sessionRejected,
  });
  const config = await client.call({ _: "help.getConfig" });
  if (!config.testMode) {
    throw new TelegramLiveFailure(
      "not-test-environment",
      "сервер сообщил, что это не тестовая среда Telegram",
    );
  }
  return client.getPeer(secrets.botUsername);
}

export async function openLiveDriver(
  secrets: LiveSecrets,
): Promise<LiveDriver> {
  assertTestSession(secrets.session);
  const client = new TelegramClient({
    apiId: secrets.apiId,
    apiHash: secrets.apiHash,
    // Продакшн-DC контуру недоступен не по договорённости, а по коду: режим
    // зашит здесь и параметром не переключается.
    testMode: true,
    storage: new MemoryStorage(),
    network: {
      // Флуд-лимит — названный отказ, а не молчаливое ожидание внутри mtcute.
      middlewares: networkMiddlewares.basic({ floodWaiter: { maxWait: 0 } }),
    },
  });
  let bot: Peer;
  try {
    bot = await withDeadline(
      connect(client, secrets),
      connectDeadlineMs,
      `тестовый DC не ответил за ${connectDeadlineMs / 1000} с`,
    );
  } catch (error) {
    await client.destroy();
    throw classifyFailure(error);
  }
  // Только таймаут ожидания ответа значит молчащего бота; таймаут отправки
  // остаётся недоступностью Telegram.
  async function awaitBot(waiting: Promise<Message>): Promise<BotReply> {
    try {
      return replyOf(await waiting);
    } catch (error) {
      if (error instanceof MtTimeoutError) {
        throw new TelegramLiveFailure(
          "bot-no-reply",
          `@${secrets.botUsername} не ответил за ${replyDeadlineMs / 1000} с: ` +
            "запущен ли hub с --telegram-environment test?",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async function inConversation(
    work: (conversation: Conversation) => Promise<BotReply>,
  ): Promise<BotReply> {
    const conversation = new Conversation(client, bot.id);
    try {
      return await conversation.with(() => work(conversation));
    } catch (error) {
      throw classifyFailure(error);
    }
  }

  return {
    sendStart: (payload) =>
      inConversation(async (conversation) => {
        const sent = await conversation.sendText(
          payload === undefined ? "/start" : `/start ${payload}`,
        );
        return awaitBot(
          conversation.waitForNewMessage(
            (message) => message.sender.id === bot.id && message.id > sent.id,
            replyDeadlineMs,
          ),
        );
      }),
    press: (reply, callbackData) =>
      // Разговор открыт до нажатия: правку, пришедшую раньше ответа на
      // callback, он запоминает, и ожидание её не пропустит.
      inConversation(async (conversation) => {
        await client.getCallbackAnswer({
          chatId: bot.id,
          message: reply.messageId,
          data: callbackData,
          timeout: replyDeadlineMs,
        });
        return awaitBot(
          conversation.waitForEdit(undefined, {
            message: reply.messageId,
            timeout: replyDeadlineMs,
          }),
        );
      }),
    close: () => client.destroy(),
  };
}
