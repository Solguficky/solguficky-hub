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
  Money,
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
import { type LotNeighbors, readNeighbors } from "./neighbors.js";
import { standingOf } from "./standing.js";

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

// «Следить за торгами» (PER-826): та же карточка, а трансляцию запускает
// оболочка по признаку `watch`. Лот уже не в торгах финала — кнопка устарела,
// и карточка без признака и есть ответ: трансляции за ним нет.
export async function watchFinal(input: {
  auction: AuctionPort;
  favorites?: FavoritesPort;
  viewer: Viewer;
  lotId: string;
  page: number;
}): Promise<AuctionScreenBody> {
  const lot = await input.auction.getLot({
    viewer: input.viewer,
    lotId: input.lotId,
  });
  return showLot({
    ...input,
    lot,
    ...(isLive(lot.status) ? { watch: true } : {}),
  });
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
  // Нажатие «Следить за торгами» (PER-826): оболочка запускает трансляцию.
  watch?: boolean;
}): Promise<AuctionScreenBody> {
  const { lot } = input;
  // Соседей в ленте читают параллельно имени и отметке и стартуют последними:
  // карточка ждёт самое долгое из трёх, а не их сумму. В живом финале
  // листания нет — карточку правит поток, и ряд пропадал бы на каждой правке.
  const [participantName, following, neighbors] = await Promise.all([
    participantNameOf(input),
    input.following === undefined
      ? followingOf(input.favorites, input.viewer, lot)
      : Promise.resolve(input.following),
    isLive(lot.status)
      ? Promise.resolve<LotNeighbors>({})
      : readNeighbors({ auction: input.auction, viewer: input.viewer, lot }),
  ]);
  return lotBody({
    lot,
    viewer: input.viewer,
    page: input.page,
    neighbors,
    ...(participantName === undefined ? {} : { participantName }),
    ...(following === undefined ? {} : { following }),
    ...(input.finalBid === undefined ? {} : { finalBid: input.finalBid }),
    ...(input.watch === true ? { watch: true } : {}),
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
    neighbors: {},
    ...(participantName === undefined ? {} : { participantName }),
    ...(input.following === undefined ? {} : { following: input.following }),
  });
}

function lotBody(input: {
  lot: LotView;
  viewer: Viewer;
  page: number;
  neighbors: LotNeighbors;
  participantName?: string;
  following?: boolean;
  finalBid?: FinalBidOutcome;
  watch?: boolean;
}): AuctionScreenBody {
  const { lot, participantName, following } = input;
  const standing = standingOf(lot.status, input.viewer);
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
  // Ряды складываются по смыслу (дизайн-код, «Клавиатура»): «Ставки» и
  // отметка избранного — взгляд на лот, а «Обновить» встаёт в середину
  // листания — «предыдущий, этот же, следующий» — над возвратом (решение
  // владельца по отзыву тестовой группы 19 октября 2026 года, PER-669).
  const lookRow = [...history, ...followButtons(lot, input.page, following)];
  // «Следить за торгами» — своим рядом под ставкой: пары кнопок дизайн-код
  // называет поимённо, и эта в них не входит.
  const watchRow = watchButton(lot, input.page);
  // Лоты сета — содержимое карточки (ADR-073, п. 7): свой ряд между взглядом
  // на лот и листанием.
  const setRow: AuctionButton[] =
    lot.lotSet === undefined
      ? []
      : [
          {
            action: "lot.set",
            callbackData: encodeAuctionCallback({
              kind: "set",
              lotId: lot.lotId,
              page: input.page,
            }),
          },
        ];
  // «Мои счета» — покупателю проданного лота (PER-813): счёт выставляет
  // проекция на каждую продажу, и ведёт кнопка в тот же список, что корень.
  const invoicesRow: AuctionButton[] =
    standing === "won"
      ? [
          {
            action: "lot.invoices",
            callbackData: encodeAuctionCallback({
              kind: "invoices",
              auctionId: lot.auctionId,
            }),
          },
        ]
      : [];
  return {
    blocks: [
      {
        ...lotBlock(lot, participantName),
        ...(standing === undefined ? {} : { standing }),
        ...(lot.viewerProxyLimit === undefined
          ? {}
          : { viewerProxyLimit: lot.viewerProxyLimit }),
        ...(following === undefined ? {} : { following }),
        ...(isLive(lot.status) || input.neighbors.final !== undefined
          ? { live: { page: input.page } }
          : {}),
        ...(input.finalBid === undefined ? {} : { finalBid: input.finalBid }),
        ...(input.watch === true ? { watch: true as const } : {}),
      },
    ],
    keyboard: [
      ...bidRows(lot, input.viewer, input.page),
      ...(input.neighbors.final?.activeLotId === undefined ||
      input.neighbors.final.activeLotId === lot.lotId
        ? []
        : [
            [
              {
                action: "lot.current" as const,
                callbackData: encodeAuctionCallback({
                  kind: "lot",
                  lotId: input.neighbors.final.activeLotId,
                  page: input.page,
                }),
              },
            ],
          ]),
      ...(watchRow.length === 0 ? [] : [watchRow]),
      ...(lookRow.length === 0 ? [] : [lookRow]),
      ...(setRow.length === 0 ? [] : [setRow]),
      ...(invoicesRow.length === 0 ? [] : [invoicesRow]),
      ...pagerRows(input.neighbors, refresh),
      [
        {
          action: "lot.back",
          // Лот раздела возвращает в свой раздел (PER-719).
          callbackData: encodeAuctionCallback(
            input.neighbors.sectionId === undefined
              ? { kind: "feed", auctionId: lot.auctionId, page: input.page }
              : {
                  kind: "section",
                  auctionId: lot.auctionId,
                  sectionId: input.neighbors.sectionId,
                  page: input.page,
                },
          ),
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
    ...(lot.tiers === undefined ? {} : { tiers: lot.tiers }),
    ...(lot.baseStep === undefined ? {} : { baseStep: lot.baseStep }),
    ...(lot.activeWindow === undefined
      ? {}
      : { activeWindow: lot.activeWindow }),
    ...(nextWindow === undefined ? {} : { nextWindow }),
    status: lot.status,
    ...(participantName === undefined ? {} : { participantName }),
    // Сет, в который входит лот (ADR-073, п. 7): карточка называет его и
    // ведёт к его экрану.
    ...(lot.lotSet === undefined ? {} : { set: lot.lotSet }),
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

// Будущее окно Auction отдаёт с объявленными суммами, не сверяя их с обычными
// (proto, `next_window`): в окне действует меньший шаг из двух, а стартовая
// окна — только пока у лота нет ставок. Чего окно при текущей цене не даст,
// карточка не обещает — так же Auction молчит о действующем окне, которое
// ничего не меняет: шаг не ниже обычного не показывается, а стартовая — у лота
// с лидером и не ниже текущей цены (ADR-047, дополнение 2026-10-27).
function announcedWindow(lot: LotView): StepWindowView | undefined {
  const { nextWindow, baseStep, status } = lot;
  if (nextWindow === undefined) return undefined;
  const step =
    nextWindow.step !== undefined &&
    (baseStep === undefined || nextWindow.step.minorUnits < baseStep.minorUnits)
      ? nextWindow.step
      : undefined;
  const start =
    nextWindow.start !== undefined &&
    status.kind === "trading" &&
    status.leaderId === undefined &&
    nextWindow.start.minorUnits < status.currentPrice.minorUnits
      ? nextWindow.start
      : undefined;
  if (step === undefined && start === undefined) return undefined;
  return {
    from: nextWindow.from,
    until: nextWindow.until,
    ...(step === undefined ? {} : { step }),
    ...(start === undefined ? {} : { start }),
  };
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

// `[◀️][🔄 Обновить][▶️]` — листание лотов в одном сообщении (PER-644) с
// «Обновить» посередине (PER-669): ряд стоит над возвратом, на краях ленты
// своей кнопки нет. Сосед — та же кнопка лота со своей страницей ленты.
function pagerRows(
  neighbors: LotNeighbors,
  refresh: AuctionButton[],
): AuctionButton[][] {
  const button = (
    action: "lot.prev" | "lot.next",
    neighbor: LotNeighbors["prev"],
  ): AuctionButton[] =>
    neighbor === undefined
      ? []
      : [
          {
            action,
            callbackData: encodeAuctionCallback({
              kind: "lot",
              lotId: neighbor.lotId,
              page: neighbor.page,
            }),
          },
        ];
  const row = [
    ...button("lot.prev", neighbors.prev),
    ...refresh,
    ...button("lot.next", neighbors.next),
  ];
  return row.length === 0 ? [] : [row];
}

// «Следить за торгами» (PER-826) — только на карточке лота в торгах живого
// финала: трансляция идёт за активным лотом, а до финала ходом торгов служит
// сама карточка.
function watchButton(lot: LotView, page: number): AuctionButton[] {
  if (!isLive(lot.status)) return [];
  return [
    {
      action: "lot.watch",
      callbackData: encodeAuctionCallback({
        kind: "watch-final",
        lotId: lot.lotId,
        page,
      }),
    },
  ];
}

// Кнопка избранного стоит рядом со «Ставками»: это действие экрана, а не
// навигация. Состояния нет — нет и кнопки. У закрытого лота «Добавить в
// избранное» нет: следить за ним уже не за чем, а Notifications вычищает его
// реплику через 30 дней, и поздняя отметка отказывала бы вечным «попробуй
// позже». У проданного нет и «Убрать из избранного» (PER-595): итог известен, а
// список избранного очищается сам, когда аукцион закончен (ADR-063,
// дополнение 2026-10-12). Отмеченный непроданный или снятый лот снимается
// как любой.
function followButtons(
  lot: LotView,
  page: number,
  following: boolean | undefined,
): AuctionButton[] {
  if (following === undefined) return [];
  if (lot.status.kind === "sold") return [];
  if (!following && isClosed(lot.status)) return [];
  const { lotId } = lot;
  return [
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
  if (status.kind === "held")
    return heldRows(lot, status.currentPrice, viewer, page);
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
  // Лидеру онлайна — как в финале: ставку против себя Auction отклонит, и
  // «Своя сумма» узнала бы об этом только после введённой суммы. Лимит
  // автоставки лидер ставить может.
  if (status.leaderId === viewer.identityId) {
    return lot.proxyEnabled
      ? [[{ action: "lot.proxy", callbackData: ask("proxy") }]]
      : [];
  }
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

// Лот, который ждёт финала, принимает только лимит автоставки (PER-821,
// ADR-079): он сработает в финале по сетке цен, а ставки и «Своей суммы» у
// удержания нет. Лидеру удержания ряд тоже нужен — лимит лидера разрешён.
// Ряд — тому, кто вправе ставить: хаб пускает в аукцион и держателя
// `run-auctions` без права ставок, а его лимит Auction отклонил бы.
function heldRows(
  lot: LotView,
  currentPrice: Money,
  viewer: Viewer,
  page: number,
): AuctionButton[][] {
  if (
    !lot.proxyEnabled ||
    !viewer.rights.includes("place-bids") ||
    currentPrice.minorUnits > MAX_COMMAND_AMOUNT
  ) {
    return [];
  }
  return [
    [
      {
        action: "lot.proxy",
        callbackData: encodeAuctionCallback({
          kind: "ask",
          question: "proxy",
          lotId: lot.lotId,
          page,
        }),
      },
    ],
  ];
}
