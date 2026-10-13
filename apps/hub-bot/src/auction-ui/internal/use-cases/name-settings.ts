import { encodeAuctionCallback } from "../../callback-data.js";
import type {
  DisplayNameChoice,
  DisplayNameRefusal,
  OwnDisplayName,
} from "../../ports.js";
import type { AuctionButton, AuctionScreenBody } from "../../screen.js";
import type { CommandContext } from "./commands.js";

// Имя в аукционе из настроек (PER-595): выбрать его можно до первой ставки, а
// после неё экран только называет имя (ADR-059, п. 5). Аукцион — идущий: его
// находит оболочка и кладёт в кнопку. Возврат в настройки тоже ставит
// оболочка: родитель экрана у двух ботов разный.

const toName = (auctionId: string): AuctionButton => ({
  action: "name.return",
  callbackData: encodeAuctionCallback({ kind: "name", auctionId }),
});

function askAlias(
  auctionId: string,
  action: "name.alias" | "answer.retry",
): AuctionButton {
  return {
    action,
    callbackData: encodeAuctionCallback({ kind: "name-ask-alias", auctionId }),
  };
}

// Экран имени. Выбор есть, пока имя не закреплено; ник предлагается, только
// если он есть в update.
function nameBody(
  context: CommandContext,
  auctionId: string,
  name: OwnDisplayName | undefined,
): AuctionScreenBody {
  const username = context.user.telegramUsername;
  const hasUsername = username !== undefined && username !== "";
  const choosing = name?.frozen !== true;
  return {
    blocks: [
      {
        kind: "name-settings",
        auctionId,
        ...(name === undefined ? {} : { name }),
        ...(choosing && hasUsername ? { username } : {}),
      },
    ],
    keyboard: choosing
      ? [
          ...(hasUsername
            ? [
                [
                  {
                    action: "name.username" as const,
                    callbackData: encodeAuctionCallback({
                      kind: "name-username",
                      auctionId,
                    }),
                  },
                ],
              ]
            : []),
          [askAlias(auctionId, "name.alias")],
        ]
      : [],
  };
}

export async function openName(
  context: CommandContext,
  auctionId: string,
): Promise<AuctionScreenBody> {
  return nameBody(
    context,
    auctionId,
    await context.auction.getOwnDisplayName({
      viewer: context.viewer,
      auctionId,
    }),
  );
}

// Вопрос псевдонима с `force_reply`: шаг и адресат едут в «Отмене».
export function askNameAlias(
  context: CommandContext,
  auctionId: string,
): AuctionScreenBody {
  return {
    blocks: [{ kind: "name-question", auctionId }],
    keyboard: [
      [
        {
          action: "question.cancel",
          callbackData: encodeAuctionCallback({
            kind: "name-question",
            auctionId,
            addressee: context.user.telegramUserId,
          }),
        },
      ],
    ],
  };
}

export function answerNameQuestion(
  context: CommandContext,
  auctionId: string,
  text: string | undefined,
): Promise<AuctionScreenBody> {
  if (text === undefined) {
    return Promise.resolve(refusedBody(auctionId, "not-text"));
  }
  return chooseName(context, auctionId, { kind: "alias", alias: text });
}

export function chooseNameUsername(
  context: CommandContext,
  auctionId: string,
): Promise<AuctionScreenBody> {
  return chooseName(context, auctionId, {
    kind: "username",
    username: context.user.telegramUsername ?? "",
  });
}

// Принятое имя — экран имени с ним. Закреплённое имя — ставкой из другого
// окна, пока висел этот экран, — экран перечитывает: человек видит имя, а не
// отказ.
async function chooseName(
  context: CommandContext,
  auctionId: string,
  choice: DisplayNameChoice,
): Promise<AuctionScreenBody> {
  const outcome = await context.auction.chooseDisplayName({
    viewer: context.viewer,
    auctionId,
    choice,
  });
  if (outcome.kind === "accepted") {
    return nameBody(context, auctionId, { text: outcome.name, frozen: false });
  }
  if (outcome.refusal === "name-frozen") return openName(context, auctionId);
  return refusedBody(auctionId, outcome.refusal);
}

function refusedBody(
  auctionId: string,
  refusal: "not-text" | Exclude<DisplayNameRefusal, "name-frozen">,
): AuctionScreenBody {
  return {
    blocks: [{ kind: "name-answer-refused", auctionId, refusal }],
    keyboard: [[askAlias(auctionId, "answer.retry")], [toName(auctionId)]],
  };
}
