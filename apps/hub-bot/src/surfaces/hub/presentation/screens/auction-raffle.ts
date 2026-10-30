import { InlineKeyboard } from "grammy";
import {
  cancelRegistrationLabel,
  raffleBackName,
  raffleNameChoiceText,
  raffleParagraphs,
  raffleProofLabel,
  raffleProofParagraphs,
  raffleProofTitle,
  raffleRegisteredParagraphs,
  raffleRegisteredTitle,
  raffleRichText,
  raffleTitle,
  registerLabel,
} from "../../../../auction-raffle.js";
import type {
  AuctionBlock,
  AuctionButton,
} from "../../../../auction-ui/index.js";
import { richPhotoBlock } from "../../../../core/auction/lot-photos.js";
import { type CommunityDay, communityShownTime } from "../../community-time.js";
import { nameChoiceScreen } from "./auction-bid.js";
import {
  cancelLabel,
  nextRow,
  readableMoment,
  screenText,
  toAuctionRoot,
  withNav,
} from "./kit.js";
import type { ScreenPhoto, ShownScreen } from "./show.js";

// Розыгрыш среди участников в оболочке хаба (ADR-066): экран открывает
// «Розыгрыш» в корне аукциона сходки, возврат — в корень (PER-644). Тексты экрана
// общие с ботом аукциона (`src/auction-raffle.ts`), оболочка ставит навигацию
// и момент в поясе сообщества.

type Keyboard = readonly (readonly AuctionButton[])[];

function dataOf(keyboard: Keyboard, action: AuctionButton["action"]): string {
  const button = keyboard.flat().find((each) => each.action === action);
  if (button === undefined) throw new Error(`body without ${action}`);
  return button.callbackData;
}

const toRaffle = (keyboard: Keyboard) => ({
  name: raffleBackName,
  data: dataOf(keyboard, "raffle.return"),
});

export function raffleScreen(
  block: Extract<AuctionBlock, { kind: "raffle" }>,
  keyboard: Keyboard,
  view: {
    timeZone: string;
    today: CommunityDay;
    presentation?: "rich" | "plain";
    photos?: readonly ScreenPhoto[] | undefined;
  },
): ShownScreen {
  const rows = new InlineKeyboard();
  for (const button of keyboard.flat()) {
    if (button.action === "raffle.register") {
      nextRow(rows).text(registerLabel, button.callbackData);
    }
    if (button.action === "raffle.cancel") {
      nextRow(rows).text(cancelRegistrationLabel, button.callbackData);
    }
    if (button.action === "raffle.proof") {
      nextRow(rows).text(raffleProofLabel, button.callbackData);
    }
  }
  const paragraphs = raffleParagraphs(block.raffle, {
    moment: (instant) =>
      readableMoment(communityShownTime(instant, view.timeZone), view.today),
  });
  // Розыгрыш открыт из корня аукциона, и тело ведёт назад туда же
  // (PER-605, PER-644).
  const nav = withNav(rows, toAuctionRoot(block.auctionId));
  // Приз с фото (PER-773) — rich-сообщение с фото первым блоком, как
  // карточка лота; фото не прочиталось — тот же rich-экран без него.
  if (view.presentation === "rich" && block.raffle?.prizePhoto !== undefined) {
    const photos = view.photos ?? [];
    return {
      id: "raffle",
      text: `${richPhotoBlock(photos.map((photo) => photo.id))}${raffleRichText(raffleTitle, paragraphs)}`,
      keyboard: nav,
      format: "rich",
      ...(photos.length === 0 ? {} : { media: photos }),
    };
  }
  return {
    id: "raffle",
    text: screenText(raffleTitle, ...paragraphs),
    keyboard: nav,
    format: "HTML",
  };
}

// Регистрация принята (прогон 14.10, №69): экран исхода с отменой регистрации
// и возвратами «‹ Розыгрыш» и «‹ Аукцион».
export function raffleRegisteredScreen(
  block: Extract<AuctionBlock, { kind: "raffle-registered" }>,
  keyboard: Keyboard,
  view: { timeZone: string; today: CommunityDay },
): ShownScreen {
  const rows = new InlineKeyboard()
    .text(cancelRegistrationLabel, dataOf(keyboard, "raffle.cancel"))
    .row()
    .text(`‹ ${raffleBackName}`, dataOf(keyboard, "raffle.return"));
  return {
    id: "raffle-registered",
    text: screenText(
      raffleRegisteredTitle,
      ...raffleRegisteredParagraphs(block.raffle, {
        moment: (instant) =>
          readableMoment(
            communityShownTime(instant, view.timeZone),
            view.today,
          ),
      }),
    ),
    keyboard: withNav(rows, toAuctionRoot(block.auctionId)),
    format: "HTML",
  };
}

// Как проверить честность (PER-618): техника розыгрыша отдельным экраном с
// возвратом «‹ Розыгрыш».
export function raffleProofScreen(
  block: Extract<AuctionBlock, { kind: "raffle-proof" }>,
  keyboard: Keyboard,
): ShownScreen {
  return {
    id: "raffle-proof",
    text: screenText(raffleProofTitle, ...raffleProofParagraphs(block.raffle)),
    keyboard: withNav(new InlineKeyboard(), toRaffle(keyboard)),
    format: "HTML",
  };
}

// Выбор имени перед регистрацией — тот же экран, что перед ставкой (ADR-066,
// п. 3), с возвратом в розыгрыш.
export function raffleNameChoiceScreen(
  block: Extract<AuctionBlock, { kind: "raffle-name-choice" }>,
  keyboard: Keyboard,
): ShownScreen {
  return nameChoiceScreen(block, keyboard, {
    id: "raffle-name-choice",
    back: toRaffle(keyboard),
    body: raffleNameChoiceText(block.username),
  });
}

export function raffleQuestionScreen(keyboard: Keyboard): ShownScreen {
  return {
    id: "question",
    text: screenText(
      "Псевдоним",
      [
        "Пришли псевдоним до 32 символов. Участники увидят его со звёздочкой.",
        "Например: Сова",
      ].join("\n"),
    ),
    keyboard: new InlineKeyboard().text(
      cancelLabel,
      dataOf(keyboard, "question.cancel"),
    ),
    format: "HTML",
  };
}

const refusalTitles: Record<
  Extract<AuctionBlock, { kind: "raffle-answer-refused" }>["refusal"],
  { title: string; detail?: string }
> = {
  "not-text": { title: "Нужен ответ текстом" },
  "alias-invalid": { title: "Такой псевдоним не подходит" },
  "alias-taken": { title: "Этот псевдоним уже занят" },
  "name-frozen": {
    title: "Имя уже не поменять",
    detail: "Ты ставил в этом аукционе.",
  },
  "username-missing": {
    title: "Ника в Telegram у тебя нет",
    detail: "Возьми псевдоним.",
  },
};

export function raffleAnswerRefusedScreen(
  block: Extract<AuctionBlock, { kind: "raffle-answer-refused" }>,
  keyboard: Keyboard,
): ShownScreen {
  const rows = new InlineKeyboard();
  for (const button of keyboard.flat()) {
    if (button.action === "answer.retry") {
      rows.text("Ввести заново", button.callbackData);
    }
  }
  const outcome = refusalTitles[block.refusal];
  return {
    id: "answer-refused",
    text: screenText(outcome.title, outcome.detail),
    keyboard: withNav(rows, toRaffle(keyboard)),
    format: "HTML",
  };
}
