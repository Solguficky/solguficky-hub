import type { AchievementsPort } from "./achievement-types.js";
import type { AuctionIntent } from "./callback-data.js";
import { openAchievements } from "./internal/use-cases/achievements.js";
import { openAuctionChronicle } from "./internal/use-cases/auction-chronicle.js";
import {
  answerQuestion,
  askQuestion,
  cancelQuestion,
  chooseUsername,
  commitCommand,
  commitWithdraw,
  confirmCommand,
  confirmWithdraw,
  placeFinalBid,
} from "./internal/use-cases/commands.js";
import { openDayChronicle } from "./internal/use-cases/day-chronicle.js";
import { openFavorites, toggleFollow } from "./internal/use-cases/favorites.js";
import { openInvoice, openInvoices } from "./internal/use-cases/invoices.js";
import {
  answerNameQuestion,
  askNameAlias,
  chooseNameUsername,
  openName,
} from "./internal/use-cases/name-settings.js";
import { openFeed } from "./internal/use-cases/open-feed.js";
import { openHistory } from "./internal/use-cases/open-history.js";
import { openLot } from "./internal/use-cases/open-lot.js";
import { openPromo } from "./internal/use-cases/open-promo.js";
import { openRoot } from "./internal/use-cases/open-root.js";
import { openSet } from "./internal/use-cases/open-set.js";
import { openPredictionResults } from "./internal/use-cases/prediction-results.js";
import {
  answerPredictionAlias,
  answerPredictionNumber,
  askPredictionAlias,
  cancelPredictionAlias,
  choosePredictionUsername,
  clearPredictionNomination,
  editPrediction,
  openPrediction,
  submitPredictionLot,
} from "./internal/use-cases/predictions.js";
import {
  answerRaffleQuestion,
  askRaffleAlias,
  cancelRaffleQuestion,
  cancelRaffleRegistration,
  chooseRaffleUsername,
  openRaffle,
  openRaffleProof,
  registerForRaffle,
} from "./internal/use-cases/raffle.js";
import type {
  AuctionPort,
  FavoritesPort,
  OperationIdPort,
  ProxyExplainerPort,
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
  favorites?: FavoritesPort;
  achievements?: AchievementsPort;
  proxyExplainer?: ProxyExplainerPort;
  media?: true;
  viewer: Viewer;
  user: TelegramUser;
  intent: AuctionIntent;
  answer?: { text?: string };
}): Promise<AuctionScreenBody> {
  const { intent } = input;
  const favorites =
    input.favorites === undefined ? {} : { favorites: input.favorites };
  const media = input.media === undefined ? {} : { media: input.media };
  const context = {
    auction: input.auction,
    operations: input.operations,
    ...favorites,
    ...(input.proxyExplainer === undefined
      ? {}
      : { proxyExplainer: input.proxyExplainer }),
    viewer: input.viewer,
    user: input.user,
  };
  const achievements =
    input.achievements === undefined
      ? {}
      : { achievements: input.achievements };
  switch (intent.kind) {
    case "achievements":
    case "achievement":
      return openAchievements({
        auction: input.auction,
        ...achievements,
        viewer: input.viewer,
        intent,
      });
    case "root":
      return openRoot({
        ...achievements,
        auction: input.auction,
        ...favorites,
        ...media,
        viewer: input.viewer,
        auctionId: intent.auctionId,
      });
    case "feed":
      return openFeed({
        auction: input.auction,
        viewer: input.viewer,
        auctionId: intent.auctionId,
        page: intent.page,
      });
    case "section":
      return openFeed({
        auction: input.auction,
        viewer: input.viewer,
        auctionId: intent.auctionId,
        page: intent.page,
        sectionId: intent.sectionId,
      });
    case "lot":
      return openLot({
        auction: input.auction,
        ...favorites,
        viewer: input.viewer,
        lotId: intent.lotId,
        page: intent.page,
        ...(intent.atLeastVersion === undefined
          ? {}
          : { atLeastVersion: intent.atLeastVersion }),
      });
    case "history":
      return openHistory({
        auction: input.auction,
        viewer: input.viewer,
        lotId: intent.lotId,
        page: intent.page,
        historyPage: intent.historyPage,
      });
    // Экран сета (ADR-073, п. 7): открывается с карточки лота сета.
    case "set":
      return openSet({
        auction: input.auction,
        ...favorites,
        viewer: input.viewer,
        lotId: intent.lotId,
        page: intent.page,
      });
    case "confirm":
      return intent.command === "withdraw"
        ? confirmWithdraw(context, intent)
        : confirmCommand(context, { ...intent, command: intent.command });
    case "commit":
      return intent.command === "withdraw"
        ? commitWithdraw(context, intent)
        : commitCommand(context, { ...intent, command: intent.command });
    case "final-bid":
      return placeFinalBid(context, intent);
    case "ask":
      return askQuestion(context, intent);
    case "explain":
      return askQuestion(context, {
        question: "proxy",
        lotId: intent.lotId,
        page: intent.page,
        explain: true,
      });
    case "question":
      return input.answer === undefined
        ? cancelQuestion(context, intent)
        : answerQuestion(context, intent, input.answer.text);
    case "username":
      return chooseUsername(context, intent);
    case "follow":
    case "unfollow":
      return toggleFollow({
        auction: input.auction,
        ...favorites,
        viewer: input.viewer,
        lotId: intent.lotId,
        page: intent.page,
        follow: intent.kind === "follow",
      });
    case "favorites":
      return openFavorites({
        auction: input.auction,
        ...favorites,
        viewer: input.viewer,
        page: intent.page,
        ...(intent.auctionId === undefined
          ? {}
          : { auctionId: intent.auctionId }),
      });
    case "prediction-results":
      return openPredictionResults(context, intent.auctionId);
    case "day-chronicle":
      return openDayChronicle(context, intent.auctionId);
    case "auction-chronicle":
      return openAuctionChronicle(context, intent.auctionId);
    case "promo":
      return openPromo({
        auction: input.auction,
        ...media,
        viewer: input.viewer,
        auctionId: intent.auctionId,
      });
    case "raffle":
      return openRaffle(context, intent.auctionId);
    case "raffle-register":
      return registerForRaffle(context, intent.auctionId);
    case "raffle-cancel":
      return cancelRaffleRegistration(context, intent.auctionId);
    case "raffle-proof":
      return openRaffleProof(context, intent.auctionId);
    case "raffle-username":
      return chooseRaffleUsername(context, intent.auctionId);
    case "raffle-ask-alias":
      return Promise.resolve(askRaffleAlias(context, intent.auctionId));
    case "raffle-question":
      return input.answer === undefined
        ? Promise.resolve(cancelRaffleQuestion(context, intent.auctionId))
        : answerRaffleQuestion(context, intent.auctionId, input.answer.text);
    case "name":
      return openName(context, intent.auctionId);
    case "name-username":
      return chooseNameUsername(context, intent.auctionId);
    case "name-ask-alias":
      return Promise.resolve(askNameAlias(context, intent.auctionId));
    // «Отмена» под вопросом возвращает на экран имени.
    case "name-question":
      return input.answer === undefined
        ? openName(context, intent.auctionId)
        : answerNameQuestion(context, intent.auctionId, input.answer.text);
    case "prediction":
      return openPrediction(context, intent);
    case "prediction-edit":
      return editPrediction(context, intent);
    case "prediction-lots":
      return editPrediction(context, intent);
    case "prediction-lot":
      return submitPredictionLot(context, intent);
    case "prediction-clear":
      return clearPredictionNomination(context, intent);
    case "prediction-username":
      return choosePredictionUsername(context, intent);
    case "prediction-ask-alias":
      return Promise.resolve(askPredictionAlias(context, intent));
    case "prediction-number-question":
      return input.answer === undefined
        ? openPrediction(context, intent)
        : answerPredictionNumber(context, {
            ...intent,
            ...(input.answer.text === undefined
              ? {}
              : { text: input.answer.text }),
          });
    case "prediction-alias-question":
      return input.answer === undefined
        ? Promise.resolve(cancelPredictionAlias(context, intent))
        : answerPredictionAlias(context, {
            ...intent,
            ...(input.answer.text === undefined
              ? {}
              : { text: input.answer.text }),
          });
    case "invoices":
      return openInvoices(context, intent.auctionId);
    case "invoice":
      return openInvoice(context, intent.lotId, intent.invoiceId);
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}
