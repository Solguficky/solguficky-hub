import {
  Conversation,
  MemoryStorage,
  type Message,
  MtTimeoutError,
  networkMiddlewares,
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
  text: string;
  callbackData: string[];
};

export type LiveDriver = {
  sendStart(payload?: string): Promise<BotReply>;
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

export async function openLiveDriver(
  secrets: LiveSecrets,
): Promise<LiveDriver> {
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
  try {
    await withDeadline(
      client.start({ session: secrets.session }),
      connectDeadlineMs,
      `тестовый DC не ответил за ${connectDeadlineMs / 1000} с`,
    );
    const config = await client.call({ _: "help.getConfig" });
    if (!config.testMode) {
      throw new TelegramLiveFailure(
        "not-test-environment",
        "сервер сообщил, что это не тестовая среда Telegram",
      );
    }
    const bot = await client.getPeer(secrets.botUsername);
    return {
      async sendStart(payload) {
        const conversation = new Conversation(client, bot.id);
        try {
          return await conversation.with(async () => {
            const sent = await conversation.sendText(
              payload === undefined ? "/start" : `/start ${payload}`,
            );
            const reply = await conversation.waitForNewMessage(
              (message) => message.sender.id === bot.id && message.id > sent.id,
              replyDeadlineMs,
            );
            return { text: reply.text, callbackData: callbackDataOf(reply) };
          });
        } catch (error) {
          if (error instanceof MtTimeoutError) {
            throw new TelegramLiveFailure(
              "bot-no-reply",
              `@${secrets.botUsername} не ответил за ${replyDeadlineMs / 1000} с: ` +
                "запущен ли hub с --telegram-environment test?",
              { cause: error },
            );
          }
          throw classifyFailure(error);
        }
      },
      close: () => client.destroy(),
    };
  } catch (error) {
    await client.destroy();
    throw classifyFailure(error);
  }
}
