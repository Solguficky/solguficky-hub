import { type Message, MtTimeoutError, tl } from "@mtcute/node";
import { type LiveClient, replyDeadlineMs } from "../driver.js";
import { classifyFailure } from "../failure.js";
import { ChatScreens, type Screen, screenOf } from "./chat.js";
import {
  type Command,
  CommandError,
  help,
  startPayloadIn,
} from "./commands.js";

// Исполнение команд живого пульта. В отличие от L2, `handleUpdate` здесь не
// возвращает управление по окончании обработки: бот отвечает асинхронно, через
// Telegram. Поэтому ответ пульта — всё, что бот прислал или поправил от начала
// действия до тишины: первое событие ждётся до `replyDeadlineMs`, дальше —
// пока бот молчит `quietMs`.

export type ChangedScreen = Screen & {
  change: "new" | "edit";
  /** Payload «Ссылки для чата»: его подставляют в `link`. */
  startPayload?: string;
};

export type Reply =
  | { ok: true; kind: "help"; commands: string[] }
  | { ok: true; kind: "quit" }
  | {
      ok: true;
      kind: "look";
      screens: Screen[];
      pressable: string[];
    }
  | {
      ok: true;
      kind: "screen";
      /** Что бот прислал или поправил между прошлой командой и этой. */
      meanwhile: ChangedScreen[];
      /** Что бот прислал или поправил в ответ на действие, по порядку. */
      changed: ChangedScreen[];
      /** Бот не ответил ничем за `replyDeadlineMs`: молчание — тоже ответ. */
      silent: boolean;
      /** Всплывающее уведомление на нажатие, если бот его показал. */
      toast?: { text: string; alert: boolean };
      last: Screen | null;
      pressable: string[];
    }
  | { ok: false; error: string };

export type SettleOptions = {
  /** Сколько бот должен молчать, чтобы ответ считался законченным. */
  quietMs: number;
  /** Предел одного действия: от зависания, а не от медленного бота. */
  capMs: number;
};

export const defaultSettle: SettleOptions = { quietMs: 1_500, capMs: 30_000 };

export async function openLiveConsoleSession(
  { client, bot }: LiveClient,
  settle: SettleOptions = defaultSettle,
) {
  const screens = new ChatScreens();
  // События бота копятся здесь всегда, а не только во время действия:
  // уведомление, пришедшее между командами, иначе потерялось бы.
  let pending: ChangedScreen[] = [];
  let lastEventAt = 0;

  const fromBot = (message: Message): boolean =>
    message.chat.id === bot.id && !message.isOutgoing;

  const record = (message: Message): void => {
    if (!fromBot(message)) return;
    const screen = screenOf(message);
    const existed = screens.has(screen.message);
    screens.apply(screen);
    const startPayload = startPayloadIn(screen.text);
    pending.push({
      ...screen,
      change: existed ? "edit" : "new",
      ...(startPayload === undefined ? {} : { startPayload }),
    });
    lastEventAt = Date.now();
  };
  client.onNewMessage.add(record);
  client.onEditMessage.add(record);

  async function reload(): Promise<void> {
    // Последние сообщения чата — из Telegram, а не из памяти пульта: так
    // кнопки экранов, отрисованных до его старта, тоже нажимаются.
    const history = await client.getHistory(bot.id, { limit: 30 });
    screens.replaceAll(
      history
        .filter((message) => !message.isOutgoing)
        .sort((left, right) => left.id - right.id)
        .map(screenOf),
    );
  }
  await reload();

  const drain = (): ChangedScreen[] => {
    const drained = pending;
    pending = [];
    return drained;
  };

  async function waitForSettle(since: number): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const now = Date.now();
      const answered = lastEventAt >= since;
      if (!answered && now - started >= replyDeadlineMs) return false;
      if (answered && now - lastEventAt >= settle.quietMs) return true;
      if (now - started >= settle.capMs) return answered;
    }
  }

  async function act(
    action: () => Promise<{ text: string; alert: boolean } | undefined>,
  ): Promise<Reply> {
    const meanwhile = drain();
    const since = Date.now();
    let toast: { text: string; alert: boolean } | undefined;
    try {
      toast = await action();
    } catch (error) {
      if (error instanceof CommandError) throw error;
      throw classifyFailure(error);
    }
    const answered = await waitForSettle(since);
    return {
      ok: true,
      kind: "screen",
      meanwhile,
      changed: drain(),
      silent: !answered,
      ...(toast === undefined ? {} : { toast }),
      last: screens.last() ?? null,
      pressable: screens.pressable(),
    };
  }

  async function send(text: string, replyTo?: number): Promise<undefined> {
    await client.sendText(
      bot.id,
      text,
      replyTo === undefined ? {} : { replyTo },
    );
    return undefined;
  }

  async function press(label: string) {
    let found: ReturnType<ChatScreens["findButton"]>;
    try {
      found = screens.findButton(label);
    } catch (error) {
      throw new CommandError(
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      const answer = await client.getCallbackAnswer({
        chatId: bot.id,
        message: found.screen.message,
        data: found.data,
        timeout: replyDeadlineMs,
      });
      return answer.message === undefined
        ? undefined
        : { text: answer.message, alert: answer.alert === true };
    } catch (error) {
      // Бот не ответил на callback — это наблюдение, а не отказ пульта:
      // правка экрана могла прийти и без ответа, и её покажет ожидание.
      if (
        error instanceof MtTimeoutError ||
        (tl.RpcError.is(error) && error.text === "BOT_RESPONSE_TIMEOUT")
      ) {
        return { text: "(бот не ответил на нажатие)", alert: false };
      }
      throw error;
    }
  }

  async function run(command: Command): Promise<Reply> {
    switch (command.kind) {
      case "help":
        return { ok: true, kind: "help", commands: help };
      case "quit":
        return { ok: true, kind: "quit" };
      case "look":
        drain();
        await reload();
        return {
          ok: true,
          kind: "look",
          screens: screens.list(),
          pressable: screens.pressable(),
        };
      case "say": {
        // Вопрос с ForceReply клиент Telegram отвечает цитатой сам — так же
        // ведёт себя `says` в L2.
        const last = screens.last();
        return act(() =>
          send(
            command.text,
            last?.awaitsReply === true ? last.message : undefined,
          ),
        );
      }
      case "reply":
        if (!screens.has(command.message)) {
          throw new CommandError(
            `сообщения ${command.message} среди экранов нет: look покажет номера`,
          );
        }
        return act(() => send(command.text, command.message));
      case "press":
        return act(() => press(command.label));
      case "link":
        return act(() => send(`/start ${command.payload}`));
    }
  }

  // Команды по одной: иначе «что ответил бот на это действие» не вычисляется.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    execute(command: Command): Promise<Reply> {
      const next = queue.then(() => run(command));
      queue = next.catch(() => undefined);
      return next;
    },
    close(): void {
      client.onNewMessage.remove(record);
      client.onEditMessage.remove(record);
    },
  };
}
