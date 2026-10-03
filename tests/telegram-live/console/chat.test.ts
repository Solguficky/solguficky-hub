import { describe, expect, it } from "../../../apps/hub-bot/testkit/index.js";
import { type ChatMessage, ChatScreens, screenOf } from "./chat.js";

// L0: модель экранов живого пульта из сообщений mtcute. Сообщение — объект с
// теми полями, которые модель читает; Telegram не нужен.

const encoder = new TextEncoder();

function message(
  id: number,
  text: string,
  buttons: ([string, string] | [string, { url: string }])[] = [],
  markup?: "force_reply",
): ChatMessage {
  return {
    id,
    text,
    media: null,
    markup:
      markup === "force_reply"
        ? ({ type: "force_reply" } as never)
        : buttons.length === 0
          ? null
          : ({
              type: "inline",
              buttons: [
                buttons.map(([label, target]) => ({
                  _: "keyboardInlineButton",
                  text: label,
                  type:
                    typeof target === "string"
                      ? {
                          _: "inlineButtonTypeCallback",
                          data: encoder.encode(target),
                        }
                      : { _: "inlineButtonTypeUrl", url: target.url },
                })),
              ],
            } as never),
  };
}

describe("экраны живого чата", () => {
  it("правка переносит экран в конец и снимает клавиатуру, как в клиенте", () => {
    const chat = new ChatScreens();
    chat.apply(
      screenOf(message(10, "Привет", [["Ближайшие сходки", "v1:nav:list"]])),
    );
    chat.apply(screenOf(message(11, "Как назовём сходку?", [], "force_reply")));
    expect(chat.last()?.awaitsReply).toBe(true);

    chat.apply(screenOf(message(10, "Сходок пока нет")));
    expect(chat.last()?.message).toBe(10);
    expect(chat.pressable()).toEqual([]);
    expect(() => chat.findButton("Ближайшие сходки")).toThrow(/нет/);
  });

  it("нажимает по подписи на последнем экране, где она есть, и не нажимает ссылку", () => {
    const chat = new ChatScreens();
    chat.apply(screenOf(message(1, "Главная", [["Архив", "v1:nav:archive"]])));
    chat.apply(
      screenOf(
        message(2, "Карточка", [
          ["Архив", "v1:nav:archive:2"],
          ["Чат сходки", { url: "https://t.me/c/1/2" }],
        ]),
      ),
    );
    expect(chat.findButton("Архив")).toMatchObject({
      screen: { message: 2 },
      data: "v1:nav:archive:2",
    });
    expect(chat.pressable()).toEqual(["Архив"]);
    expect(() => chat.findButton("Чат сходки")).toThrow(
      /ссылка https:\/\/t\.me/,
    );
  });
});
