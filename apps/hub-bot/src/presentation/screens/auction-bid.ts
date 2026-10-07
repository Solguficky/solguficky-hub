import {
  type AnswerRefusal,
  type AuctionBlock,
  type AuctionButton,
  type CommandResult,
  MAX_COMMAND_AMOUNT,
  type Money,
} from "@solguficky/auction-bot-ui";
import { InlineKeyboard } from "grammy";
import {
  confirmKeyboard,
  escapeHtml,
  menuLabel,
  nextRow,
  screenText,
  toMenu,
  withNav,
  withNote,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Лист ставки в оболочке хаба (PER-317): подтверждение, вопрос, выбор имени и
// строка исхода команды на карточке лота. Тексты — те же, что у бота
// аукциона: словарь у двух ботов один, а код оболочек не делится (ADR-044).
// `money` приходит параметром: формат цены держит оболочка аукциона хаба.

type ConfirmBlock = Extract<AuctionBlock, { kind: "confirm" }>;
type AcceptedBlock = Extract<AuctionBlock, { kind: "accepted" }>;
type QuestionBlock = Extract<AuctionBlock, { kind: "question" }>;
type NameChoiceBlock = Extract<AuctionBlock, { kind: "name-choice" }>;

const cancelLabel = "Отмена";

function dataOf(
  keyboard: readonly (readonly AuctionButton[])[],
  action: AuctionButton["action"],
): string {
  const button = keyboard.flat().find((each) => each.action === action);
  if (button === undefined) throw new Error(`body without ${action}`);
  return button.callbackData;
}

// Название лота на экранах листа ставки — абзац в кавычках (дизайн-код,
// «Лист ставки»).
export const quoted = (title: string | undefined) =>
  title === undefined ? undefined : `«${escapeHtml(oneLine(title))}»`;

// Название лота в одну строку: Auction переносы строк в названии не режет, а
// в строке списка и в кавычках второй строкой оно читалось бы как чужая
// запись.
export const oneLine = (title: string) => title.replace(/\s+/g, " ").trim();

// Подтверждение (дизайн-код, «Подтверждение»): заголовок-вопрос с суммой,
// название лота, затем что нельзя отменить.
export function confirmScreen(
  block: ConfirmBlock,
  keyboard: readonly (readonly AuctionButton[])[],
  money: (amount: Money) => string,
): ShownScreen {
  const bid = block.command === "bid";
  return {
    id: bid ? "bid-confirm" : "proxy-confirm",
    text: bid
      ? screenText(
          `Поставить ${money(block.amount)}?`,
          quoted(block.title),
          "Отменить ставку нельзя.",
        )
      : screenText(
          `Включить автоставку до ${money(block.amount)}?`,
          quoted(block.title),
          `${proxyGap(block.currentPrice, block.amount, money)}\nЛимит видишь только ты.`,
        ),
    keyboard: confirmKeyboard({
      yes: bid
        ? `Да, поставить ${money(block.amount)}`
        : "Да, включить автоставку",
      yesData: dataOf(keyboard, "confirm.yes"),
      noData: dataOf(keyboard, "confirm.no"),
      money: true,
    }),
    format: "HTML",
  };
}

// Принятая команда — свой экран (PER-473): сумма в заголовке, карточку с новой
// ценой открывает «К лоту» — в одном ряду с «Меню», как выход кадра исхода.
export function acceptedScreen(
  block: AcceptedBlock,
  keyboard: readonly (readonly AuctionButton[])[],
  money: (amount: Money) => string,
): ShownScreen {
  const bid = block.command === "bid";
  return {
    id: bid ? "bid-accepted" : "proxy-accepted",
    text: bid
      ? screenText(`Ставка ${money(block.amount)} принята`, quoted(block.title))
      : screenText(
          `Автоставка до ${money(block.amount)} включена`,
          quoted(block.title),
          "Лимит видишь только ты.",
        ),
    keyboard: new InlineKeyboard()
      .text("К лоту", dataOf(keyboard, "accepted.lot"))
      .text(menuLabel, toMenu.data),
    format: "HTML",
  };
}

// Автоставка объясняется разницей цены и лимита (RFC-007): на столько бот
// может поднять цену за человека, перебивая чужие ставки по шагу.
function proxyGap(
  currentPrice: Money,
  limit: Money,
  money: (amount: Money) => string,
): string {
  const gap = limit.minorUnits - currentPrice.minorUnits;
  return gap > 0
    ? `Цена сейчас ${money(currentPrice)}: бот будет перебивать чужие ставки по шагу и поднимет её не больше чем на ${money({ minorUnits: gap, currency: limit.currency })}.`
    : `Цена сейчас ${money(currentPrice)}: лимит не выше неё, и перебивать бот не будет.`;
}

// Вопрос уходит новым сообщением с `force_reply`: режим ответа ставит
// отправка, экран несёт только текст и «Отмену». Текст — по правилу вопросов
// дизайн-кода: причина отказа над заголовком, под ним одним абзацем — что
// прислать, «Сейчас: …» и образец.
export function questionScreen(
  block: QuestionBlock,
  keyboard: readonly (readonly AuctionButton[])[],
  money: (amount: Money) => string,
): ShownScreen {
  const current = (prefix: string) =>
    block.current === undefined
      ? []
      : [`Сейчас: ${prefix}${money(block.current)}`];
  const text = (() => {
    switch (block.question) {
      case "bid":
        return screenText(
          "Своя сумма",
          [
            "Пришли сумму ставки в рублях.",
            ...current("от "),
            "Например: 1 500",
          ].join("\n"),
        );
      case "proxy":
        return screenText(
          "Автоставка",
          [
            "Пришли лимит в рублях: до этой суммы бот будет ставить за тебя по шагу. Лимит видишь только ты.",
            ...current(""),
            "Например: 3 000",
          ].join("\n"),
        );
      case "alias":
        return screenText(
          "Псевдоним",
          [
            "Пришли псевдоним до 32 символов. Участники увидят его со звёздочкой.",
            "Например: Сова",
          ].join("\n"),
        );
      default: {
        const _exhaustive: never = block.question;
        return _exhaustive;
      }
    }
  })();
  return {
    id: "question",
    text: withNote(
      block.refusal === undefined
        ? undefined
        : answerRefusalText(block.refusal, money),
      text,
    ),
    keyboard: new InlineKeyboard().text(
      cancelLabel,
      dataOf(keyboard, "question.cancel"),
    ),
    format: "HTML",
  };
}

export function nameChoiceScreen(
  block: NameChoiceBlock,
  keyboard: readonly (readonly AuctionButton[])[],
  money: (amount: Money) => string,
): ShownScreen {
  const rows = new InlineKeyboard();
  for (const button of keyboard.flat()) {
    if (button.action === "name.username" && block.username !== undefined) {
      nextRow(rows).text(`Ник @${block.username}`, button.callbackData);
    }
    if (button.action === "name.alias") {
      nextRow(rows).text("Взять псевдоним", button.callbackData);
    }
  }
  const text = screenText(
    "Имя в аукционе",
    [
      "Имя видно всем участникам аукциона рядом с твоими ставками. После первой ставки его не поменять.",
      block.username === undefined
        ? "Ника в Telegram у тебя нет: возьми псевдоним."
        : `Ставь под ником @${escapeHtml(block.username)} или возьми псевдоним.`,
    ].join("\n"),
  );
  return {
    id: "name-choice",
    text: withNote(
      block.refusal === undefined
        ? undefined
        : answerRefusalText(block.refusal, money),
      text,
    ),
    keyboard: withNav(rows, {
      name: "Лот",
      data: dataOf(keyboard, "name.back"),
    }),
    format: "HTML",
  };
}

function answerRefusalText(
  refusal: AnswerRefusal,
  money: (amount: Money) => string,
): string {
  switch (refusal) {
    case "not-text":
      return "Нужен ответ текстом.";
    case "not-a-number":
      return "Это не сумма.";
    case "other-currency":
      return "Ставки принимаются только в рублях.";
    case "not-positive":
      return "Сумма должна быть больше нуля.";
    case "too-precise":
      return "Копеек — не больше двух знаков.";
    case "too-large":
      return `Бот принимает суммы до ${money({ minorUnits: MAX_COMMAND_AMOUNT, currency: "RUB" })}.`;
    case "alias-invalid":
      return "Такой псевдоним не подходит.";
    case "alias-taken":
      return "Этот псевдоним уже занят.";
    case "name-frozen":
      return "Имя уже не поменять: ты ставил в этом аукционе.";
    case "username-missing":
      return "Ника в Telegram у тебя нет: возьми псевдоним.";
    default: {
      const _exhaustive: never = refusal;
      return _exhaustive;
    }
  }
}

// Исход команды — первая строка карточки после «Да» или после ответа,
// отвергнутого до «Да». Отказ называет цену сам; принятая команда — свой экран.
export function resultText(
  result: CommandResult,
  money: (amount: Money) => string,
): string {
  if (result.kind === "unknown") {
    return "Аукцион не ответил. Проверь цену на карточке: команда могла пройти.";
  }
  const { refusal } = result;
  switch (refusal.kind) {
    case "lot-not-open":
      return "Торги по лоту не идут.";
    case "lot-on-hold":
      return `Лот ждёт финала, ставки сейчас не принимаются. Цена: ${money(refusal.currentPrice)}.`;
    case "bid-below-minimum":
      return `Ставка ниже порога. Сейчас можно от ${money(refusal.minRequired)}.`;
    case "bid-not-at-next-price":
      return `В финале ставят ровно ${money(refusal.expected)}.`;
    case "bidder-is-leader":
      return `Ты уже лидируешь: цена ${money(refusal.currentPrice)} — твоя.`;
    case "currency-mismatch":
      return "Лот торгуется в другой валюте.";
    case "proxy-below-current-price":
      return `Лимит ниже текущей цены. Нужно от ${money(refusal.minLimit)}.`;
    case "proxy-disabled":
      return "Автоставка на этом лоте выключена.";
    // Выбор имени — свой экран, а не строка карточки: сюда отказ не доходит.
    case "display-name-not-chosen":
      return "Выбери имя в аукционе.";
    default: {
      const _exhaustive: never = refusal;
      return _exhaustive;
    }
  }
}
