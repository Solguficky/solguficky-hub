import type {
  AuctionBlock,
  AuctionButton,
  AuctionDenial,
  AuctionScreenBody,
} from "@solguficky/auction-bot-ui";
import { defaultFaq, entryCallback, type FaqContent } from "./faq.js";

// Оболочка бота аукциона (ADR-044, «Один аукцион, две оболочки»). Экран здесь
// корневой: короткий контекст для пришедшего по пересланной ссылке и тело из
// общего пакета. Доступа к хабу он не обещает. Тексты принадлежат этому боту и
// с хабом не делятся, даже когда совпадают.
//
// Общий FAQ и меню — оболочка. Каталог и торговые экраны — PER-306/PER-317.
export type AuctionEntryScreen =
  | { kind: "welcome" }
  | { kind: "faq" }
  | { kind: "menu" }
  | { kind: "auctions" }
  | { kind: "details" }
  | { kind: "question" }
  | { kind: "auction"; body: AuctionScreenBody }
  | { kind: "denied"; reason: AuctionDenial }
  | { kind: "outdated" }
  | { kind: "unavailable" };

export type TelegramButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

export type RenderedScreen = {
  text: string;
  keyboard: readonly (readonly TelegramButton[])[];
};

const context = "Аукцион сообщества.";

const faqButton = {
  text: "Правила и FAQ",
  callback_data: entryCallback("faq"),
};
const menuButton = { text: "В меню", callback_data: entryCallback("menu") };

export function renderEntryScreen(
  screen: AuctionEntryScreen,
  faq: FaqContent = defaultFaq,
): RenderedScreen {
  switch (screen.kind) {
    case "faq":
      return {
        text: [
          "Правила и FAQ",
          `Что продаём\n${faq.items}`,
          `Куда идут средства\n${faq.purpose}`,
          "Правила ставок\nОтменить сделанную ставку нельзя.",
          `Почти одновременные ставки\n${faq.simultaneousBids}`,
          `Сбой и потеря связи\n${faq.connectionFailure}`,
          `Доставка победителю\n${faq.delivery}`,
        ].join("\n\n"),
        keyboard: [
          [menuButton],
          [
            faq.detailsUrl === undefined
              ? {
                  text: "Прочитать подробнее",
                  callback_data: entryCallback("details"),
                }
              : { text: "Прочитать подробнее", url: faq.detailsUrl },
          ],
          [
            faq.questionUrl === undefined
              ? {
                  text: "Задать вопрос",
                  callback_data: entryCallback("question"),
                }
              : { text: "Задать вопрос", url: faq.questionUrl },
          ],
        ],
      };
    case "menu":
      return {
        text: `${context}\nВыберите раздел.`,
        keyboard: [
          [{ text: "Аукционы", callback_data: entryCallback("auctions") }],
          [faqButton],
        ],
      };
    case "auctions":
      return {
        text: "Аукционы\nКаталог пока не открыт. Он появится здесь, когда будет готов.",
        keyboard: [[faqButton], [menuButton]],
      };
    case "details":
      return {
        text: "Организатор ещё не указал ссылку на подробные правила.",
        keyboard: [[faqButton], [menuButton]],
      };
    case "question":
      return {
        text: "Организатор ещё не указал, куда направлять вопросы.",
        keyboard: [[faqButton], [menuButton]],
      };
    case "welcome":
      return {
        text: `${context}\nЛоты появятся здесь, когда начнутся торги.`,
        keyboard: [],
      };
    case "auction":
      return {
        text: [context, ...screen.body.blocks.map(renderBlock)].join("\n\n"),
        keyboard: [
          ...screen.body.keyboard.map((row) => row.map(renderButton)),
          [faqButton],
          [menuButton],
        ],
      };
    case "denied":
      return {
        text:
          screen.reason === "blocked"
            ? "Доступ к аукциону закрыт."
            : "Заявка на рассмотрении. Участие в аукционе пока не открыто.",
        keyboard: [],
      };
    case "outdated":
      return {
        text: "Этот экран устарел. Отправьте /start, чтобы открыть аукцион заново.",
        keyboard: [[faqButton]],
      };
    case "unavailable":
      return {
        text: "Аукцион сейчас недоступен. Попробуйте позже.",
        keyboard: [[faqButton]],
      };
    default: {
      const _exhaustive: never = screen;
      return _exhaustive;
    }
  }
}

function renderBlock(block: AuctionBlock): string {
  switch (block.kind) {
    case "lot":
      return `Лот ${block.lotId}`;
    default: {
      const _exhaustive: never = block.kind;
      return _exhaustive;
    }
  }
}

function renderButton(button: AuctionButton): TelegramButton {
  switch (button.action) {
    case "lot.refresh":
      return { text: "Обновить", callback_data: button.callbackData };
    default: {
      const _exhaustive: never = button.action;
      return _exhaustive;
    }
  }
}
