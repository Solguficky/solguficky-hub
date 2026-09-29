import type { Message } from "@mtcute/node";

// Экраны чата с ботом так, как их видит человек в клиенте: одно сообщение —
// один экран с последним текстом и последней клавиатурой, по порядку
// последнего изменения. Модель та же, что у `Person` в L2, но собрана из
// сообщений Telegram, а не из вызовов Bot API.

export type ScreenButton = {
  text: string;
  /** callback_data: по нему пульт нажимает кнопку. */
  data?: string;
  url?: string;
};

export type Screen = {
  message: number;
  text: string;
  buttons: ScreenButton[];
  /** Бот ждёт ответа на это сообщение (ForceReply). */
  awaitsReply: boolean;
  /** Тип медиа, если сообщение — не текст: карточку без текста видно сразу. */
  media?: string;
};

/** Ровно то, что модель читает из сообщения mtcute; L0-тесты дают объект. */
export type ChatMessage = Pick<Message, "id" | "text" | "markup"> & {
  media: { type: string } | null;
};

export function screenOf(message: ChatMessage): Screen {
  const markup = message.markup;
  const decoder = new TextDecoder();
  const buttons: ScreenButton[] =
    markup?.type === "inline"
      ? markup.buttons.flat().map((button) => {
          const { type } = button;
          if (type._ === "inlineButtonTypeCallback") {
            return { text: button.text, data: decoder.decode(type.data) };
          }
          if (type._ === "inlineButtonTypeUrl") {
            return { text: button.text, url: type.url };
          }
          return { text: button.text };
        })
      : [];
  return {
    message: message.id,
    text: message.text,
    buttons,
    awaitsReply: markup?.type === "force_reply",
    ...(message.media === null ? {} : { media: message.media.type }),
  };
}

export class ChatScreens {
  readonly #screens = new Map<number, Screen>();

  /** Новое сообщение или правка: экран уходит в конец порядка. */
  apply(screen: Screen): void {
    this.#screens.delete(screen.message);
    this.#screens.set(screen.message, screen);
  }

  replaceAll(screens: Screen[]): void {
    this.#screens.clear();
    for (const screen of screens) this.apply(screen);
  }

  has(message: number): boolean {
    return this.#screens.has(message);
  }

  list(): Screen[] {
    return [...this.#screens.values()];
  }

  last(): Screen | undefined {
    return this.list().at(-1);
  }

  /** Подписи, которые можно нажать, начиная с последнего экрана. */
  pressable(): string[] {
    const labels = this.list()
      .reverse()
      .flatMap((screen) =>
        screen.buttons
          .filter((button) => button.data !== undefined)
          .map((button) => button.text),
      );
    return [...new Set(labels)];
  }

  /**
   * Кнопка с этой подписью на последнем изменённом экране, где она есть, — как
   * `presses` в L2. Ссылку нажать нельзя: её открывает клиент, а не бот.
   */
  findButton(label: string): { screen: Screen; data: string } {
    for (const screen of this.list().reverse()) {
      const button = screen.buttons.find(
        (candidate) => candidate.text === label,
      );
      if (button === undefined) continue;
      if (button.data === undefined) {
        throw new Error(
          `«${label}» — не callback-кнопка${button.url === undefined ? "" : `, а ссылка ${button.url}`}`,
        );
      }
      return { screen, data: button.data };
    }
    throw new Error(
      `кнопки «${label}» нет; можно нажать: ${this.pressable().join(" | ") || "ничего"}`,
    );
  }
}
