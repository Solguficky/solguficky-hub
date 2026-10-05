import type { AuctionIntent } from "./callback-data.js";
import {
  answerQuestion,
  askQuestion,
  cancelQuestion,
  chooseUsername,
  commitCommand,
  confirmCommand,
} from "./internal/use-cases/commands.js";
import { openFeed } from "./internal/use-cases/open-feed.js";
import { openHistory } from "./internal/use-cases/open-history.js";
import { openLot } from "./internal/use-cases/open-lot.js";
import type {
  AuctionPort,
  OperationIdPort,
  TelegramUser,
  Viewer,
} from "./ports.js";
import type { AuctionScreenBody } from "./screen.js";

// Диспетчер принимает личность, которую уже установил шлюз, и сам доступ не
// проверяет. Из пакета не экспортируется по той же причине, что и юзкейсы.
//
// `answer` — ответ на вопрос: шаг вопроса пришёл из `reply_to_message`, а не
// нажатием его «Отмены». `text` нет — ответили не текстом.
export function dispatchAuctionIntent(input: {
  auction: AuctionPort;
  operations: OperationIdPort;
  viewer: Viewer;
  user: TelegramUser;
  intent: AuctionIntent;
  answer?: { text?: string };
}): Promise<AuctionScreenBody> {
  const { intent } = input;
  const context = {
    auction: input.auction,
    operations: input.operations,
    viewer: input.viewer,
    user: input.user,
  };
  switch (intent.kind) {
    case "feed":
      return openFeed({
        auction: input.auction,
        viewer: input.viewer,
        auctionId: intent.auctionId,
        page: intent.page,
      });
    case "lot":
      return openLot({
        auction: input.auction,
        viewer: input.viewer,
        lotId: intent.lotId,
        page: intent.page,
      });
    case "history":
      return openHistory({
        auction: input.auction,
        viewer: input.viewer,
        lotId: intent.lotId,
        page: intent.page,
        historyPage: intent.historyPage,
      });
    case "confirm":
      return confirmCommand(context, intent);
    case "commit":
      return commitCommand(context, intent);
    case "ask":
      return askQuestion(context, intent);
    case "question":
      return input.answer === undefined
        ? cancelQuestion(context, intent)
        : answerQuestion(context, intent, input.answer.text);
    case "username":
      return chooseUsername(context, intent);
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}
