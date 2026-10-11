import {
  encodeAuctionCallback,
  MAX_COMMAND_AMOUNT,
  MAX_FEED_PAGE,
} from "../../callback-data.js";
import type {
  AuctionPort,
  FavoritesPort,
  LotStatusView,
  LotView,
  StepWindowView,
  Viewer,
} from "../../ports.js";
import type { AuctionButton, AuctionScreenBody } from "../../screen.js";
import { namesOf } from "./names.js";

// Сырой юзкейс: доступ он не проверяет и поэтому из пакета не экспортируется.
// Войти в него можно только через `handleAuctionUpdate`, после шлюза.
//
// `page` — страница ленты, с которой открыли карточку: на неё ведёт «Назад».
export async function openLot(input: {
  auction: AuctionPort;
  favorites?: FavoritesPort;
  viewer: Viewer;
  lotId: string;
  page: number;
  atLeastVersion?: number;
}): Promise<AuctionScreenBody> {
  const lot = await input.auction.getLot({
    viewer: input.viewer,
    lotId: input.lotId,
    ...(input.atLeastVersion === undefined
      ? {}
      : { atLeastVersion: input.atLeastVersion }),
  });
  return showLot({ ...input, lot });
}

// Карточка по уже прочитанному снимку. Исход команды участника карточка не
// несёт: он — свой экран (PER-472).
//
// `following` — состояние отметки, которое уже известно из ответа команды
// избранного: тогда список отметок карточка не перечитывает.
export async function showLot(input: {
  auction: AuctionPort;
  favorites?: FavoritesPort;
  viewer: Viewer;
  lot: LotView;
  page: number;
  following?: boolean;
}): Promise<AuctionScreenBody> {
  const { lot } = input;
  const nextWindow = announcedWindow(lot);
  const participantId = participantOf(lot.status);
  const names = await namesOf({
    auction: input.auction,
    viewer: input.viewer,
    auctionId: lot.auctionId,
    participantIds: participantId === undefined ? [] : [participantId],
  });
  const participantName =
    participantId === undefined ? undefined : names[participantId];
  const following =
    input.following ?? (await followingOf(input.favorites, input.viewer, lot));
  // Хронология открывается на последней странице — со свежими ставками:
  // страницу за пределом юзкейс хронологии прижимает к последней.
  const history: AuctionButton[][] = hasTraded(lot.status)
    ? [
        [
          {
            action: "lot.history",
            callbackData: encodeAuctionCallback({
              kind: "history",
              lotId: lot.lotId,
              page: input.page,
              historyPage: MAX_FEED_PAGE,
            }),
          },
        ],
      ]
    : [];
  const refresh: AuctionButton[][] = changesUnattended(lot.status)
    ? [
        [
          {
            action: "lot.refresh",
            callbackData: encodeAuctionCallback({
              kind: "lot",
              lotId: lot.lotId,
              page: input.page,
            }),
          },
        ],
      ]
    : [];
  return {
    blocks: [
      {
        kind: "lot",
        lotId: lot.lotId,
        auctionId: lot.auctionId,
        version: lot.version,
        ...(lot.card === undefined ? {} : { card: lot.card }),
        ...(lot.nextPrice === undefined ? {} : { nextPrice: lot.nextPrice }),
        ...(lot.fixedStep === undefined ? {} : { fixedStep: lot.fixedStep }),
        ...(lot.baseStep === undefined ? {} : { baseStep: lot.baseStep }),
        ...(lot.activeWindow === undefined
          ? {}
          : { activeWindow: lot.activeWindow }),
        ...(nextWindow === undefined ? {} : { nextWindow }),
        status: lot.status,
        ...(participantName === undefined ? {} : { participantName }),
        ...(lot.viewerProxyLimit === undefined
          ? {}
          : { viewerProxyLimit: lot.viewerProxyLimit }),
        ...(following === undefined ? {} : { following }),
      },
    ],
    keyboard: [
      ...bidRows(lot, input.page),
      ...refresh,
      ...history,
      ...followRows(lot, input.page, following),
      [
        {
          action: "lot.back",
          callbackData: encodeAuctionCallback({
            kind: "feed",
            auctionId: lot.auctionId,
            page: input.page,
          }),
        },
      ],
    ],
  };
}

// Будущее окно Auction отдаёт с объявленной суммой, не сверяя её с обычным
// шагом (proto, `next_window`): в окне действует меньшая из двух. Окно, которое
// при текущей цене шаг не снизит, карточка не обещает — так же Auction молчит о
// действующем окне, которое шаг не снижает.
function announcedWindow(lot: LotView): StepWindowView | undefined {
  const { nextWindow, baseStep } = lot;
  if (nextWindow === undefined) return undefined;
  if (baseStep === undefined) return nextWindow;
  return nextWindow.step.minorUnits < baseStep.minorUnits
    ? nextWindow
    : undefined;
}

// Отмечен ли лот. Отказ Notifications карточку не роняет: цена и ставка
// важнее отметки, и карточка остаётся без кнопки избранного — так же, как без
// имени лидера, когда Auction его не отдал.
async function followingOf(
  favorites: FavoritesPort | undefined,
  viewer: Viewer,
  lot: LotView,
): Promise<boolean | undefined> {
  if (favorites === undefined) return undefined;
  try {
    return (await favorites.listFollowedLots(viewer)).includes(lot.lotId);
  } catch {
    return undefined;
  }
}

// Кнопка избранного стоит над возвратом: это действие экрана, а не
// навигация. Состояния нет — нет и кнопки. У закрытого лота «В избранное»
// нет: следить за ним уже не за чем, а Notifications вычищает его реплику
// через 30 дней, и поздняя отметка отказывала бы вечным «попробуй позже».
// Отмеченный закрытый лот снимается «Убрать», как любой.
function followRows(
  lot: LotView,
  page: number,
  following: boolean | undefined,
): AuctionButton[][] {
  if (following === undefined) return [];
  if (!following && isClosed(lot.status)) return [];
  const { lotId } = lot;
  return [
    [
      following
        ? {
            action: "lot.unfollow",
            callbackData: encodeAuctionCallback({
              kind: "unfollow",
              lotId,
              page,
            }),
          }
        : {
            action: "lot.follow",
            callbackData: encodeAuctionCallback({
              kind: "follow",
              lotId,
              page,
            }),
          },
    ],
  ];
}

// Чьё имя нужно экрану: лидера в торгах или победителя проданного лота. У
// закрытого без продажи и снятого лота участника нет, и Auction за именем не
// зовут.
function participantOf(status: LotStatusView): string | undefined {
  switch (status.kind) {
    case "trading":
    case "held":
      return status.leaderId;
    case "sold":
      return status.winnerId;
    case "draft":
    case "scheduled":
    case "unsold":
    case "withdrawn":
      return undefined;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function isClosed(status: LotStatusView): boolean {
  return (
    status.kind === "sold" ||
    status.kind === "unsold" ||
    status.kind === "withdrawn"
  );
}

// «Обновить» стоит, пока у лота нет итога (дизайн-код, «Навигация»): у
// запланированного сами открываются торги, в торгах меняются цена и лидер,
// отложенный уходит в финал и возвращается из него. У лота без условий
// торгов, проданного, непроданного и снятого без человека ничего не меняется.
function changesUnattended(status: LotStatusView): boolean {
  switch (status.kind) {
    case "scheduled":
    case "trading":
    case "held":
      return true;
    case "draft":
    case "sold":
    case "unsold":
    case "withdrawn":
      return false;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// Хронология есть у лота, который открывался к торгам: у черновика и
// запланированного ставок быть не может. Снятый лот мог быть снят и из торгов,
// поэтому кнопка у него остаётся, а пустая хронология говорит сама за себя.
function hasTraded(status: LotStatusView): boolean {
  switch (status.kind) {
    case "trading":
    case "held":
    case "sold":
    case "unsold":
    case "withdrawn":
      return true;
    case "draft":
    case "scheduled":
      return false;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// Ставка из бота — только в онлайн-торгах: в живом финале ставят по шагу в
// зале, а кнопку финала добавит его лист. Ряд «по шагу» несёт порог, который
// видел человек. Порог выше потолка кнопки не принимает ни одна команда бота —
// ни ставка, ни лимит не меньше порога, — поэтому рядов ставки у такого лота
// нет вовсе, а не вопрос, на который любой ответ отказ. Лимит предлагается
// лоту, который его принимает.
function bidRows(lot: LotView, page: number): AuctionButton[][] {
  const { nextPrice } = lot;
  if (
    lot.status.kind !== "trading" ||
    lot.status.phase !== "online" ||
    nextPrice === undefined ||
    nextPrice.minorUnits > MAX_COMMAND_AMOUNT
  ) {
    return [];
  }
  const ask = (question: "bid" | "proxy") =>
    encodeAuctionCallback({ kind: "ask", question, lotId: lot.lotId, page });
  return [
    [
      {
        action: "lot.bid-step",
        amount: nextPrice,
        callbackData: encodeAuctionCallback({
          kind: "confirm",
          command: "bid",
          lotId: lot.lotId,
          amount: nextPrice.minorUnits,
          page,
        }),
      },
    ],
    [{ action: "lot.bid-custom", callbackData: ask("bid") }],
    ...(lot.proxyEnabled
      ? [[{ action: "lot.proxy" as const, callbackData: ask("proxy") }]]
      : []),
  ];
}
