import { InlineKeyboard } from "grammy";
import {
  heldProxyAccepted,
  heldProxyConfirmation,
  heldProxyQuestion,
  liveProxyAccepted,
  liveProxyConfirmation,
  liveProxyQuestion,
  noLimitDetail,
  noLimitTitle,
  withdrawNote,
  withdrawnTitle,
  withdrawQuestion,
} from "../../../../auction-final.js";
import {
  autoFollowNote,
  currentValueLine,
  extensionLine,
  nameSettingsParagraphs,
  nameSettingsTitle,
  overtakenByProxyLine,
  proxyHintLead,
} from "../../../../auction-standing.js";
import {
  type AnswerRefusal,
  type AuctionBlock,
  type AuctionButton,
  type CommandResult,
  MAX_COMMAND_AMOUNT,
  type Money,
} from "../../../../auction-ui/index.js";
import {
  confirmKeyboard,
  escapeHtml,
  nextRow,
  type Parent,
  screenText,
  subjectLine,
  withNav,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Лист ставки в оболочке хаба (PER-317): подтверждение, вопрос, выбор имени и
// экраны исхода команды (PER-472). Тексты — те же, что у бота
// аукциона: словарь у двух ботов один, а код оболочек не делится (ADR-044).
// `money` приходит параметром: формат цены держит оболочка аукциона хаба.

type ConfirmBlock = Extract<AuctionBlock, { kind: "confirm" }>;
type AcceptedBlock = Extract<AuctionBlock, { kind: "accepted" }>;
type QuestionBlock = Extract<AuctionBlock, { kind: "question" }>;
type NameChoiceBlock = Extract<AuctionBlock, { kind: "name-choice" }>;
type ResultBlock = Extract<AuctionBlock, { kind: "result" }>;
type AnswerRefusedBlock = Extract<AuctionBlock, { kind: "answer-refused" }>;

const cancelLabel = "Отмена";
// Выход кадра исхода и принятой команды — к лоту (PER-595).
const toLotLabel = "‹ Лот";

function dataOf(
  keyboard: readonly (readonly AuctionButton[])[],
  action: AuctionButton["action"],
): string {
  const button = keyboard.flat().find((each) => each.action === action);
  if (button === undefined) throw new Error(`body without ${action}`);
  return button.callbackData;
}

// Название лота на экранах листа ставки и хронологии — предмет экрана:
// жирный абзац без кавычек (дизайн-код, «Формат»; PER-594).
export const lotSubject = (title: string | undefined) =>
  title === undefined ? undefined : subjectLine(oneLine(title));

// Название лота в одну строку: Auction переносы строк в названии не режет, а
// в строке списка и в предмете экрана второй строкой оно читалось бы как чужая
// запись.
export const oneLine = (title: string) => title.replace(/\s+/g, " ").trim();

// Подтверждение (дизайн-код, «Подтверждение»): заголовок-вопрос с суммой,
// название лота, затем что нельзя отменить.
export function confirmScreen(
  block: ConfirmBlock,
  keyboard: readonly (readonly AuctionButton[])[],
  money: (amount: Money) => string,
): ShownScreen {
  if (block.command === "withdraw") {
    return {
      id: "withdraw-confirm",
      text: screenText(
        withdrawQuestion(block.amount, money),
        lotSubject(block.title),
        withdrawNote(block.forFinal === true),
      ),
      keyboard: confirmKeyboard({
        yes: "Да, снять автоставку",
        yesData: dataOf(keyboard, "confirm.yes"),
        noData: dataOf(keyboard, "confirm.no"),
      }),
      format: "HTML",
    };
  }
  const bid = block.command === "bid";
  return {
    id: bid ? "bid-confirm" : "proxy-confirm",
    text: bid
      ? screenText(
          `Поставить ${money(block.amount)}?`,
          lotSubject(block.title),
          "Отменить ставку нельзя.",
        )
      : screenText(
          `Включить автоставку до ${money(block.amount)}?`,
          lotSubject(block.title),
          `${block.liveFinal === true ? liveProxyConfirmation({ currentPrice: block.currentPrice, nextPrice: block.nextPrice, limit: block.amount, viewerIsLeader: block.liveFinalLeader === true, money }) : block.forFinal === true ? heldProxyConfirmation(block.currentPrice, block.amount, money) : proxyGap(block.currentPrice, block.amount, money, block.firstBid)}\nЛимит видишь только ты.`,
        ),
    keyboard: confirmKeyboard({
      // Сумма — в вопросе: с ней «Да» обрезалось в паре с «Нет» (PER-631, №86).
      yes: bid ? "Да, поставить" : "Да, включить автоставку",
      yesData: dataOf(keyboard, "confirm.yes"),
      noData: dataOf(keyboard, "confirm.no"),
      irreversible: true,
    }),
    format: "HTML",
  };
}

// Принятая команда — свой экран (PER-473): сумма в заголовке, карточку с новой
// ценой открывает «‹ Лот», ленту — «‹ Лоты» (PER-595); кнопки «Меню» нет
// (решение владельца 10 октября 2026 года). У бота с избранным экран
// говорит, что ставка кладёт лот туда сама (ADR-063), если лота там не было,
// а продление анти-снайпом называет новый дедлайн (PER-631, №107).
export function acceptedScreen(
  block: AcceptedBlock,
  keyboard: readonly (readonly AuctionButton[])[],
  money: (amount: Money) => string,
  timeZone: string,
): ShownScreen {
  const bid = block.command === "bid";
  const note = block.favorites === true ? autoFollowNote : undefined;
  const extension =
    block.extension === undefined
      ? undefined
      : extensionLine(block.extension, timeZone);
  return {
    id: bid ? "bid-accepted" : "proxy-accepted",
    text: bid
      ? screenText(
          `Ставка ${money(block.amount)} принята`,
          lotSubject(block.title),
          block.overtaken === undefined
            ? undefined
            : overtakenByProxyLine(block.overtaken),
          extension,
          note,
        )
      : screenText(
          `Автоставка до ${money(block.amount)} включена`,
          lotSubject(block.title),
          block.liveFinal === true
            ? `${liveProxyAccepted}\nЛимит видишь только ты.`
            : block.forFinal === true
              ? `${heldProxyAccepted}\nЛимит видишь только ты.`
              : "Лимит видишь только ты.",
          extension,
          note,
        ),
    keyboard: new InlineKeyboard()
      .text(toLotLabel, dataOf(keyboard, "accepted.lot"))
      .row()
      .text("‹ Лоты", dataOf(keyboard, "accepted.feed")),
    format: "HTML",
  };
}

// Автоставка объясняется разницей цены и лимита (RFC-007): на столько бот
// может поднять цену за человека, перебивая чужие ставки по шагу.
// У лота без ставок автоставка сразу ставит стартовую цену (П-01), даже
// лимитом, равным ей: подтверждение говорит о первой ставке прямо.
function proxyGap(
  currentPrice: Money,
  limit: Money,
  money: (amount: Money) => string,
  firstBid: Money | undefined,
): string {
  if (firstBid !== undefined) {
    return `Ставок ещё нет: бот сразу поставит за тебя ${money(firstBid)} и будет перебивать чужие ставки по шагу, но не выше ${money(limit)}.`;
  }
  const gap = limit.minorUnits - currentPrice.minorUnits;
  return gap > 0
    ? `Цена сейчас ${money(currentPrice)}: бот будет перебивать чужие ставки по шагу и поднимет её не больше чем на ${money({ minorUnits: gap, currency: limit.currency })}.`
    : `Цена сейчас ${money(currentPrice)}: лимит не выше неё, и перебивать бот не будет.`;
}

// Вопрос уходит новым сообщением с `force_reply`: режим ответа ставит
// отправка, экран несёт только текст и «Отмену». Текст — по правилу вопросов
// дизайн-кода: под заголовком одним абзацем — что прислать, подписанное
// текущее значение (PER-595) и образец. Непринятый ответ — свой экран.
export function questionScreen(
  block: QuestionBlock,
  keyboard: readonly (readonly AuctionButton[])[],
  money: (amount: Money) => string,
): ShownScreen {
  const current = () =>
    currentValueLine(
      block.current === undefined
        ? undefined
        : {
            amount: money(block.current),
            limit: block.currentIsLimit === true,
            ...(block.liveFinal === true && block.currentIsLimit !== true
              ? { floor: true }
              : {}),
          },
    );
  const text = (() => {
    switch (block.question) {
      case "bid":
        return screenText(
          "Своя сумма",
          [
            "Пришли сумму ставки в рублях.",
            ...current(),
            "Например: 1 500",
          ].join("\n"),
        );
      case "proxy":
        return screenText(
          "Автоставка",
          block.explainer === undefined
            ? undefined
            : proxyExplainer(block.explainer, money),
          [
            block.liveFinal === true
              ? liveProxyQuestion
              : block.forFinal === true
                ? heldProxyQuestion
                : "Пришли лимит в рублях: до этой суммы бот будет ставить за тебя по шагу. Лимит видишь только ты.",
            ...current(),
            // Подсказка уже несёт пример с ценой этого лота: второй, общий,
            // с ним расходится.
            ...(block.explainer === undefined && block.liveFinal !== true
              ? ["Например: 3 000"]
              : []),
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
  // «Как это работает» — над «Отменой»: выход из вопроса остаётся последним
  // рядом (дизайн-код, «Вопросы»).
  const explain = keyboard
    .flat()
    .find((button) => button.action === "question.explain");
  const rows = new InlineKeyboard();
  if (explain !== undefined) {
    rows.text(explainLabel, explain.callbackData).row();
  }
  return {
    id: "question",
    text,
    keyboard: rows.text(cancelLabel, dataOf(keyboard, "question.cancel")),
    format: "HTML",
  };
}

const explainLabel = "Как это работает";

// Пояснение автоставки голосом помощника (PER-517, RFC-007): платишь цену, а
// не лимит. Пример — на этом лоте: цена сейчас, шаг и лимит на три шага выше.
// Не лидеру бот сразу ставит порог, который посчитал Auction, лидеру — ничего;
// ответов по шагам пример не расписывает: у ступенчатого лота шаг на
// следующей цене другой. Текст тот же, что у бота аукциона.
function proxyExplainer(
  explainer: NonNullable<QuestionBlock["explainer"]>,
  money: (amount: Money) => string,
): string {
  const lines = [proxyHintLead];
  const { example } = explainer;
  if (example !== undefined) {
    const price = money(example.currentPrice);
    const limit = money(example.limit);
    lines.push(
      example.firstBid === undefined
        ? `Например: цена сейчас ${price} — твоя, шаг ${money(example.step)}, твой лимит ${limit}. Бот будет отвечать на чужие ставки, но не выше ${limit}. Никто не перебьёт — заплатишь ${price}, а не ${limit}.`
        : `Например: цена сейчас ${price}, шаг ${money(example.step)}, твой лимит ${limit}. Бот сразу поставит за тебя ${money(example.firstBid)} и будет отвечать на чужие ставки, но не выше ${limit}. Никто не перебьёт — заплатишь ${money(example.firstBid)}, а не ${limit}.`,
    );
  }
  return lines.join("\n");
}

// Выбор имени перед ставкой; розыгрыш (ADR-066, п. 3) показывает тот же экран
// своей записью каталога и с возвратом в розыгрыш.
export function nameChoiceScreen(
  block: Pick<NameChoiceBlock, "username">,
  keyboard: readonly (readonly AuctionButton[])[],
  target?: {
    id: "raffle-name-choice" | "prediction-name-choice";
    back: Parent;
    body: string;
  },
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
    target?.body ??
      [
        "Имя видно всем участникам аукциона рядом с твоими ставками. После первой ставки его не поменять.",
        block.username === undefined
          ? "Ника в Telegram у тебя нет: возьми псевдоним."
          : `Ставь под ником @${escapeHtml(block.username)} или возьми псевдоним.`,
      ].join("\n"),
  );
  return {
    id: target?.id ?? "name-choice",
    text,
    keyboard: withNav(
      rows,
      target?.back ?? { name: "Лот", data: dataOf(keyboard, "name.back") },
    ),
    format: "HTML",
  };
}

// Исход — свой экран (дизайн-код, «Экран исхода», PER-472): исход в заголовке
// без точки, название лота жирным, затем пояснение; выход — «‹ Лот», у
// непринятого ответа над ним — «Ввести заново».
type Outcome = { title: string; detail?: string };

function outcomeText(outcome: Outcome, lotTitle: string | undefined): string {
  return screenText(
    outcome.title,
    lotSubject(lotTitle),
    outcome.detail === undefined ? undefined : escapeHtml(outcome.detail),
  );
}

function toLotRow(
  rows: InlineKeyboard,
  keyboard: readonly (readonly AuctionButton[])[],
): InlineKeyboard {
  return nextRow(rows).text(toLotLabel, dataOf(keyboard, "result.lot"));
}

export function commandResultScreen(
  block: ResultBlock,
  keyboard: readonly (readonly AuctionButton[])[],
  money: (amount: Money) => string,
): ShownScreen {
  return {
    id: "command-result",
    text: outcomeText(resultOutcome(block.result, money), block.title),
    keyboard: toLotRow(new InlineKeyboard(), keyboard),
    format: "HTML",
  };
}

// Notifications ещё не знает лот (PER-495): факт аукциона до него не дошёл,
// и отметка не поставлена. Кадр исхода, как отказ команды: «‹ Лот».
export function followRefusedScreen(
  block: Extract<AuctionBlock, { kind: "follow-refused" }>,
  keyboard: readonly (readonly AuctionButton[])[],
): ShownScreen {
  return {
    id: "follow-refused",
    text: outcomeText(
      {
        title: "Лот пока нельзя добавить в избранное",
        detail: "Попробуй ещё раз через минуту.",
      },
      block.title,
    ),
    keyboard: toLotRow(new InlineKeyboard(), keyboard),
    format: "HTML",
  };
}

export function answerRefusedScreen(
  block: AnswerRefusedBlock,
  keyboard: readonly (readonly AuctionButton[])[],
  money: (amount: Money) => string,
): ShownScreen {
  const rows = new InlineKeyboard();
  for (const button of keyboard.flat()) {
    if (button.action === "answer.retry") {
      rows.text("Ввести заново", button.callbackData);
    }
    if (button.action === "name.alias") {
      rows.text("Взять псевдоним", button.callbackData);
    }
  }
  return {
    id: "answer-refused",
    text: outcomeText(answerRefusalOutcome(block.refusal, money), block.title),
    keyboard: toLotRow(rows, keyboard),
    format: "HTML",
  };
}

function answerRefusalOutcome(
  refusal: AnswerRefusal,
  money: (amount: Money) => string,
): Outcome {
  switch (refusal) {
    case "not-text":
      return { title: "Нужен ответ текстом" };
    case "not-a-number":
      return { title: "Это не сумма" };
    case "other-currency":
      return { title: "Ставки принимаются только в рублях" };
    case "not-positive":
      return { title: "Сумма должна быть больше нуля" };
    case "too-precise":
      return { title: "Копеек — не больше двух знаков" };
    case "too-large":
      return {
        title: "Сумма слишком большая",
        detail: `Бот принимает суммы до ${money({ minorUnits: MAX_COMMAND_AMOUNT, currency: "RUB" })}.`,
      };
    case "alias-invalid":
      return { title: "Такой псевдоним не подходит" };
    case "alias-taken":
      return { title: "Этот псевдоним уже занят" };
    case "name-frozen":
      return {
        title: "Имя уже не поменять",
        detail: "Ты ставил в этом аукционе.",
      };
    case "username-missing":
      return {
        title: "Ника в Telegram у тебя нет",
        detail: "Возьми псевдоним.",
      };
    default: {
      const _exhaustive: never = refusal;
      return _exhaustive;
    }
  }
}

// Исход команды после «Да» или после ответа, отвергнутого до «Да». Отказ
// называет цену сам; принятая команда — экран `accepted`.
function resultOutcome(
  result: CommandResult,
  money: (amount: Money) => string,
): Outcome {
  if (result.kind === "unknown") {
    return {
      title: "Аукцион не ответил",
      detail: "Проверь цену на карточке: команда могла пройти.",
    };
  }
  if (result.kind === "withdrawn") return { title: withdrawnTitle };
  const { refusal } = result;
  switch (refusal.kind) {
    case "no-active-limit":
      return { title: noLimitTitle, detail: noLimitDetail };
    case "lot-not-open":
      return { title: "Торги по лоту не идут" };
    case "lot-on-hold":
      return {
        title: "Лот ждёт финала",
        detail: `Ставки сейчас не принимаются. Цена: ${money(refusal.currentPrice)}.`,
      };
    case "bid-below-minimum":
      return {
        title: "Ставка ниже порога",
        detail: `Сейчас можно от ${money(refusal.minRequired)}.`,
      };
    case "bid-above-maximum":
      return {
        title: "Ставка выше потолка",
        detail: `Максимум сейчас — 5 × ${money(refusal.next)}.`,
      };
    case "bid-not-at-next-price":
      return {
        title: "Ставка не по цене финала",
        detail: `В финале ставят ровно ${money(refusal.expected)}.`,
      };
    case "bidder-is-leader":
      return {
        title: "Ты уже лидируешь",
        detail: `Цена ${money(refusal.currentPrice)} — твоя.`,
      };
    case "currency-mismatch":
      return { title: "Лот торгуется в другой валюте" };
    case "proxy-below-current-price":
      return {
        title: "Лимит ниже допустимой цены",
        detail: `Нужно от ${money(refusal.minLimit)}.`,
      };
    case "proxy-disabled":
      return { title: "Автоставка на этом лоте выключена" };
    // Выбор имени — свой экран, а не отказ: сюда отказ не доходит.
    case "display-name-not-chosen":
      return { title: "Выбери имя в аукционе" };
    // Снял администратор (ADR-072): кто и почему, ответ не несёт.
    case "removed-from-lot":
      return { title: "Ставки на этом лоте для тебя закрыты" };
    default: {
      const _exhaustive: never = refusal;
      return _exhaustive;
    }
  }
}

type NameSettingsBlock = Extract<AuctionBlock, { kind: "name-settings" }>;
type NameRefusedBlock = Extract<AuctionBlock, { kind: "name-answer-refused" }>;

// Имя в аукционе из «Настроек» (PER-595): тело дерева, тексты общие с ботом
// аукциона. Возврат ставит вызывающий: вход стоит в «Расширениях» настроек.
export function nameSettingsScreen(
  block: NameSettingsBlock,
  keyboard: readonly (readonly AuctionButton[])[],
  back: Parent,
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
  return {
    id: "name-settings",
    text: screenText(
      nameSettingsTitle,
      ...nameSettingsParagraphs(block.name, block.username),
    ),
    keyboard: withNav(rows, back),
    format: "HTML",
  };
}

// Непринятый псевдоним из настроек: «Ввести заново» и возврат на экран имени.
export function nameRefusedScreen(
  block: NameRefusedBlock,
  keyboard: readonly (readonly AuctionButton[])[],
  money: (amount: Money) => string,
): ShownScreen {
  const rows = new InlineKeyboard();
  for (const button of keyboard.flat()) {
    if (button.action === "answer.retry") {
      rows.text("Ввести заново", button.callbackData);
    }
  }
  return {
    id: "answer-refused",
    text: outcomeText(answerRefusalOutcome(block.refusal, money), undefined),
    keyboard: withNav(rows, {
      name: nameSettingsTitle,
      data: dataOf(keyboard, "name.return"),
    }),
    format: "HTML",
  };
}
