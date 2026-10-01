import type {
  AuctionBlock,
  AuctionButton,
  AuctionDenial,
  AuctionScreenBody,
} from "@solguficky/auction-bot-ui";

// Оболочка бота аукциона (ADR-044, «Один аукцион, две оболочки»). Экран здесь
// корневой: короткий контекст для пришедшего по пересланной ссылке и тело из
// общего пакета. Доступа к хабу он не обещает. Тексты принадлежат этому боту и
// с хабом не делятся, даже когда совпадают.
//
// Правила и помощь — PER-294, торговые экраны — PER-306 и PER-317: оболочка
// пока не рисует ни одной кнопки сама.
export type AuctionEntryScreen =
  | { kind: "welcome" }
  | { kind: "auction"; body: AuctionScreenBody }
  | { kind: "denied"; reason: AuctionDenial }
  | { kind: "outdated" }
  | { kind: "unavailable" };

export type TelegramButton = { text: string; callback_data: string };

export type RenderedScreen = {
  text: string;
  keyboard: readonly (readonly TelegramButton[])[];
};

const context = "Аукцион сообщества.";

export function renderEntryScreen(screen: AuctionEntryScreen): RenderedScreen {
  switch (screen.kind) {
    case "welcome":
      return {
        text: `${context}\nЛоты появятся здесь, когда начнутся торги.`,
        keyboard: [],
      };
    case "auction":
      return {
        text: [context, ...screen.body.blocks.map(renderBlock)].join("\n\n"),
        keyboard: screen.body.keyboard.map((row) => row.map(renderButton)),
      };
    case "denied":
      return {
        text:
          screen.reason === "blocked"
            ? "Доступ к аукциону закрыт."
            : "Чтобы участвовать в аукционе, отправьте /start.",
        keyboard: [],
      };
    case "outdated":
      return {
        text: "Этот экран устарел. Отправьте /start, чтобы открыть аукцион заново.",
        keyboard: [],
      };
    case "unavailable":
      return {
        text: "Аукцион сейчас недоступен. Попробуйте позже.",
        keyboard: [],
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
