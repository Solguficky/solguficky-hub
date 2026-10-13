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
import type {
  AuctionBlock,
  AuctionButton,
  AuctionScreenBody,
  FinalBidOutcome,
} from "../../screen.js";
import { namesOf } from "./names.js";

// Сырой юзкейс: доступ он не проверяет и поэтому из пакета не экспортируется.
// Войти в него можно только через `handleAuctionUpdate`, после шлюза. Из этого
// модуля наружу уходит только `previewLot` — см. его комментарий.
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

// Карточка по уже прочитанному снимку. Исход команды онлайн-недели карточка не
// несёт: он — свой экран (PER-472). Исключение — ставка финала `finalBid`
// (PER-336): её исход — строка карточки, которая остаётся живой.
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
  finalBid?: FinalBidOutcome;
}): Promise<AuctionScreenBody> {
  const { lot } = input;
  const participantName = await participantNameOf(input);
  const following =
    input.following ?? (await followingOf(input.favorites, input.viewer, lot));
  return lotBody({
    lot,
    viewer: input.viewer,
    page: input.page,
    ...(participantName === undefined ? {} : { participantName }),
    ...(following === undefined ? {} : { following }),
    ...(input.finalBid === undefined ? {} : { finalBid: input.finalBid }),
  });
}

// Карточка финала по снимку из потока `WatchAuction` (PER-336): поверхность
// правит ею открытое сообщение вне update. Шлюза здесь нет, как у
// `previewLot`: снимок прочитан правами смотрящего, которого шлюз пустил,
// когда карточку открывали, а команду кнопка карточки шлёт снова через шлюз.
// `following` — отметка, с которой карточку открыли: Notifications на каждое
// изменение цены не спрашивается. Имя участника — тем же путём, что у
// карточки; кэш имён держит вызывающий.
export async function liveLot(input: {
  auction: Pick<AuctionPort, "getDisplayNames">;
  viewer: Viewer;
  lot: LotView;
  page: number;
  following?: boolean;
}): Promise<AuctionScreenBody> {
  const participantName = await participantNameOf(input);
  return lotBody({
    lot: input.lot,
    viewer: input.viewer,
    page: input.page,
    ...(participantName === undefined ? {} : { participantName }),
    ...(input.following === undefined ? {} : { following: input.following }),
  });
}

function lotBody(input: {
  lot: LotView;
  viewer: Viewer;
  page: number;
  participantName?: string;
  following?: boolean;
  finalBid?: FinalBidOutcome;
}): AuctionScreenBody {
  const { lot, participantName, following } = input;
  // Хронология открывается на последней странице — со свежими ставками:
  // страницу за пределом юзкейс хронологии прижимает к последней.
  const history: AuctionButton[] = hasTraded(lot.status)
    ? [
        {
          action: "lot.history",
          callbackData: encodeAuctionCallback({
            kind: "history",
            lotId: lot.lotId,
            page: input.page,
            historyPage: MAX_FEED_PAGE,
          }),
        },
      ]
    : [];
  const refresh: AuctionButton[] = changesUnattended(lot.status)
    ? [
        {
          action: "lot.refresh",
          callbackData: encodeAuctionCallback({
            kind: "lot",
            lotId: lot.lotId,
            page: input.page,
          }),
        },
      ]
    : [];
  // Ряды складываются по смыслу (дизайн-код, «Клавиатура»; PER-594):
  // «Обновить» и «Ставки» — одна группа, просмотр хода торгов лота.
  const watch = [...refresh, ...history];
  return {
    blocks: [
      {
        ...lotBlock(lot, participantName),
        ...(lot.viewerProxyLimit === undefined
          ? {}
          : { viewerProxyLimit: lot.viewerProxyLimit }),
        ...(following === undefined ? {} : { following }),
        ...(isLive(lot.status) ? { live: { page: input.page } } : {}),
        ...(input.finalBid === undefined ? {} : { finalBid: input.finalBid }),
      },
    ],
    keyboard: [
      ...bidRows(lot, input.viewer, input.page),
      ...(watch.length === 0 ? [] : [watch]),
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

// Карточка глазами участника для организатора (PER-512): тот же блок, что у
// `showLot`, без кнопок вовсе — ставки, избранного, «Обновить» и возврата;
// возврат ставит оболочка. Смотрящий — нейтральный участник: своего лимита
// и отметки у него нет, поэтому блок их не несёт, а избранное не читается.
// Команд юзкейс не шлёт, а снимок читает и проверяет на право вызывающий.
export async function previewLot(input: {
  auction: AuctionPort;
  viewer: Viewer;
  lot: LotView;
}): Promise<AuctionScreenBody> {
  const participantName = await participantNameOf(input);
  return { blocks: [lotBlock(input.lot, participantName)], keyboard: [] };
}

// Блок карточки без состояния смотрящего — общий у карточки и предпросмотра:
// расхождение двух экранов по тексту здесь невозможно по устройству.
function lotBlock(
  lot: LotView,
  participantName: string | undefined,
): Extract<AuctionBlock, { kind: "lot" }> {
  const nextWindow = announcedWindow(lot);
  return {
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
  };
}

async function participantNameOf(input: {
  auction: Pick<AuctionPort, "getDisplayNames">;
  viewer: Viewer;
  lot: LotView;
}): Promise<string | undefined> {
  const { lot } = input;
  const participantId = participantOf(lot.status);
  if (participantId === undefined) return undefined;
  const names = await namesOf({
    auction: input.auction,
    viewer: input.viewer,
    auctionId: lot.auctionId,
    participantIds: [participantId],
  });
  return names[participantId];
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

function isLive(status: LotStatusView): boolean {
  return status.kind === "trading" && status.phase === "live";
}

// Ставка из бота в онлайн-торгах — «по шагу», своя сумма и автоставка. Ряд
// «по шагу» несёт порог, который видел человек. Порог выше потолка кнопки не
// принимает ни одна команда бота — ни ставка, ни лимит не меньше порога, —
// поэтому рядов ставки у такого лота нет вовсе, а не вопрос, на который любой
// ответ отказ. Лимит предлагается лоту, который его принимает.
//
// В живом финале кнопка одна — «Поставить N» на следующую цену (ADR-049):
// своей суммы нет, а лимит участник ставит до финала. Лидеру кнопки нет —
// против себя он не ставит, и Auction отказал бы.
function bidRows(
  lot: LotView,
  viewer: Viewer,
  page: number,
): AuctionButton[][] {
  const { nextPrice, status } = lot;
  if (
    status.kind !== "trading" ||
    nextPrice === undefined ||
    nextPrice.minorUnits > MAX_COMMAND_AMOUNT
  ) {
    return [];
  }
  if (status.phase === "live") {
    if (status.leaderId === viewer.identityId) return [];
    return [
      [
        {
          action: "lot.bid-final",
          amount: nextPrice,
          callbackData: encodeAuctionCallback({
            kind: "final-bid",
            lotId: lot.lotId,
            amount: nextPrice.minorUnits,
            page,
          }),
        },
      ],
    ];
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
    // Своя сумма и автоставка — ставки, которые человек задаёт сам, одним
    // рядом; ставка по шагу несёт цену и стоит рядом одна (PER-594).
    [
      { action: "lot.bid-custom", callbackData: ask("bid") },
      ...(lot.proxyEnabled
        ? [{ action: "lot.proxy" as const, callbackData: ask("proxy") }]
        : []),
    ],
  ];
}
