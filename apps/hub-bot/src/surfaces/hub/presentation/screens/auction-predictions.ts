import { InlineKeyboard } from "grammy";
import {
  predictionNameChoiceText,
  predictionNumberQuestionText,
  predictionParagraphs,
  predictionRefusalText,
  predictionRoundTitle,
  predictionTitle,
} from "../../../../auction-prediction.js";
import type {
  AuctionBlock,
  AuctionButton,
  FeedItem,
  LotStatusView,
} from "../../../../auction-ui/index.js";
import {
  parseAuctionCallback,
  predictionSpec,
} from "../../../../auction-ui/index.js";
import { money, truncate } from "../../../../core/format.js";
import { communityLocalTime } from "../../community-time.js";
import type { AuctionView } from "./auction.js";
import { nameChoiceScreen } from "./auction-bid.js";
import {
  buttonText,
  escapeHtml,
  nextRow,
  type Parent,
  pagedTitle,
  readableMoment,
  screenText,
  withNav,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

type Keyboard = readonly (readonly AuctionButton[])[];

function dataOf(keyboard: Keyboard, action: AuctionButton["action"]): string {
  const button = keyboard.flat().find((each) => each.action === action);
  if (button === undefined) throw new Error(`body without ${action}`);
  return button.callbackData;
}

function predictionParent(keyboard: Keyboard): Parent {
  return { name: "Лоты", data: dataOf(keyboard, "prediction.back") };
}

export function predictionScreen(
  block: Extract<AuctionBlock, { kind: "prediction" }>,
  keyboard: Keyboard,
  view: Pick<AuctionView, "timeZone" | "today">,
): ShownScreen {
  const rows = new InlineKeyboard();
  const hasAnswer = new Set(block.answers.map((answer) => answer.nomination));
  for (const row of keyboard) {
    for (const button of row) {
      switch (button.action) {
        case "prediction.edit": {
          const parsed = parseAuctionCallback(button.callbackData);
          if (!parsed.ok || parsed.intent.kind !== "prediction-edit") {
            throw new Error("prediction edit button has invalid callback data");
          }
          const nomination = predictionSpec(parsed.intent.nomination);
          nextRow(rows).text(
            `${hasAnswer.has(nomination.id) ? "Изменить" : "Ответить"} ${nomination.number}`,
            button.callbackData,
          );
          break;
        }
        case "prediction.switch-round": {
          const parsed = parseAuctionCallback(button.callbackData);
          if (!parsed.ok || parsed.intent.kind !== "prediction") {
            throw new Error(
              "prediction round button has invalid callback data",
            );
          }
          nextRow(rows).text(
            predictionRoundTitle(parsed.intent.round),
            button.callbackData,
          );
          break;
        }
        case "prediction.back":
          break;
        default:
          throw new Error(`action ${button.action} in a prediction screen`);
      }
    }
  }
  return {
    id: "predictions",
    text: screenText(
      predictionTitle,
      ...predictionParagraphs(block, {
        moment: (instant) =>
          readableMoment(
            communityLocalTime(instant, view.timeZone),
            view.today,
          ),
        money,
      }),
    ),
    keyboard: withNav(rows, predictionParent(keyboard)),
    format: "HTML",
  };
}

export function predictionLotsScreen(
  block: Extract<AuctionBlock, { kind: "prediction-lots" }>,
  keyboard: Keyboard,
): ShownScreen {
  const rows = new InlineKeyboard();
  const items = new Map<string, FeedItem>(
    block.lots.map((item) => [item.lotId, item]),
  );
  for (const row of keyboard) {
    for (const button of row) {
      switch (button.action) {
        case "prediction.select-lot": {
          const item = items.get(button.lotId);
          const label =
            item === undefined
              ? "Лот без названия"
              : buttonText(
                  `${item.title ?? "Лот без названия"} · ${lotPrice(item.status)}`,
                );
          nextRow(rows).text(label, button.callbackData);
          break;
        }
        case "feed.prev":
          rows.text("←", button.callbackData);
          break;
        case "feed.next":
          rows.text("→", button.callbackData);
          break;
        case "prediction.clear":
          nextRow(rows).text("Очистить", button.callbackData);
          break;
        case "prediction.back":
          break;
        default:
          throw new Error(
            `action ${button.action} in prediction lot selection`,
          );
      }
    }
  }
  const nomination = predictionSpec(block.nomination);
  const current =
    block.currentTitle === undefined
      ? undefined
      : `Сейчас выбрано: ${escapeHtml(oneLine(block.currentTitle))}`;
  return {
    id: "prediction-lots",
    text: screenText(
      pagedTitle("Выбрать лот", {
        items: block.lots,
        page: block.page,
        pageCount: block.pageCount,
      }),
      `${nomination.number} · ${escapeHtml(nomination.question)}`,
      current,
      block.lots.length === 0
        ? "В этом раунде пока нет доступных лотов."
        : block.lots
            .map(
              (lot) =>
                `• ${escapeHtml(oneLine(lot.title ?? "Лот без названия"))} — ${lotPrice(lot.status)}`,
            )
            .join("\n"),
    ),
    keyboard: withNav(rows, {
      name: "Прогнозы",
      data: dataOf(keyboard, "prediction.back"),
    }),
    format: "HTML",
  };
}

export function predictionNumberQuestionScreen(
  block: Extract<AuctionBlock, { kind: "prediction-number-question" }>,
  keyboard: Keyboard,
): ShownScreen {
  const rows = new InlineKeyboard();
  for (const button of keyboard.flat()) {
    if (button.action === "prediction.clear") {
      nextRow(rows).text("Очистить", button.callbackData);
    }
  }
  rows.row().text("Отмена", dataOf(keyboard, "question.cancel"));
  const nomination = predictionSpec(block.nomination);
  return {
    id: "prediction-number-question",
    text: screenText(
      nomination.question,
      ...predictionNumberQuestionText(block, money),
    ),
    keyboard: rows,
    format: "HTML",
  };
}

export function predictionNameChoiceScreen(
  block: Extract<AuctionBlock, { kind: "prediction-name-choice" }>,
  keyboard: Keyboard,
): ShownScreen {
  return nameChoiceScreen(block, keyboard, {
    id: "prediction-name-choice",
    back: { name: "Прогнозы", data: dataOf(keyboard, "prediction.back") },
    body: predictionNameChoiceText(block.username),
  });
}

export function predictionAliasQuestionScreen(keyboard: Keyboard): ShownScreen {
  return {
    id: "prediction-alias-question",
    text: screenText(
      "Псевдоним",
      [
        "Пришли псевдоним до 32 символов. Участники увидят его со звёздочкой.",
        "Например: Сова",
      ].join("\n"),
    ),
    keyboard: new InlineKeyboard().text(
      "Отмена",
      dataOf(keyboard, "question.cancel"),
    ),
    format: "HTML",
  };
}

export function predictionAnswerRefusedScreen(
  block: Extract<AuctionBlock, { kind: "prediction-answer-refused" }>,
  keyboard: Keyboard,
): ShownScreen {
  const rows = new InlineKeyboard();
  for (const button of keyboard.flat()) {
    if (button.action === "answer.retry") {
      nextRow(rows).text("Ввести заново", button.callbackData);
    }
  }
  return {
    id: "prediction-answer-refused",
    text: screenText(
      predictionRefusalText(block.refusal).title,
      predictionRefusalText(block.refusal).detail,
    ),
    keyboard: withNav(rows, {
      name: "Прогнозы",
      data: dataOf(keyboard, "prediction.back"),
    }),
    format: "HTML",
  };
}

function lotPrice(status: LotStatusView): string {
  switch (status.kind) {
    case "draft":
      return "готовится";
    case "scheduled":
      return `старт ${money(status.startingPrice)}`;
    case "trading":
    case "held":
      return money(status.currentPrice);
    case "sold":
      return `продан за ${money(status.price)}`;
    case "unsold":
      return "не продан";
    case "withdrawn":
      return "снят";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function oneLine(text: string): string {
  return truncate(text.replace(/\s+/g, " ").trim(), 256);
}
