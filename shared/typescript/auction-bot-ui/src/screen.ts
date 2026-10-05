import type {
  BidOriginView,
  LotCardView,
  LotStatusView,
  Money,
} from "./ports.js";

// Каноническое тело аукционного экрана (ADR-044, «Один аукцион, две оболочки»).
// Одинаково в обоих ботах: приложение оборачивает его в свою оболочку —
// `HubScreen` или `AuctionEntryScreen` — и только затем переводит в Telegram
// API. Текстов поверхности здесь нет: блоки семантические, подписи к ним
// выбирает рендерер.

// Лот в строке ленты: ровно то, что нужно его строке и кнопке.
export type FeedItem = {
  lotId: string;
  title?: string;
  status: LotStatusView;
};

// Строка хронологии: ставка, как её показывает экран. Лимита прокси здесь
// нет — его нет и в порту.
export type HistoryItem = {
  kind: "bid";
  sequence: number;
  occurredAt: string;
  amount: Money;
  origin: BidOriginView;
  // Имя ставившего — тем же путём, что имя лидера на карточке. Нет — Auction
  // имя не отдал; идентификатор вместо имени на экран не выходит.
  participantName?: string;
};

export type AuctionBlock =
  | {
      kind: "feed";
      auctionId: string;
      // Нумерация с нуля; пустая лента — одна страница без лотов.
      page: number;
      pageCount: number;
      lots: readonly FeedItem[];
    }
  | {
      kind: "lot";
      lotId: string;
      auctionId: string;
      version: number;
      card?: LotCardView;
      nextPrice?: Money;
      fixedStep?: Money;
      status: LotStatusView;
      // Имя участника из статуса: лидера в торгах или победителя проданного
      // лота. Нет — участника нет либо Auction имя не отдал; идентификатор
      // вместо имени на экран не выходит.
      participantName?: string;
    }
  | {
      kind: "history";
      lotId: string;
      auctionId: string;
      // Название лота для заголовка. Нет — у лота нет строки каталога.
      title?: string;
      // Нумерация с нуля; хронология без ставок — одна пустая страница.
      page: number;
      pageCount: number;
      // По возрастанию `sequence`: порядок журнала, а не часов.
      entries: readonly HistoryItem[];
    };

// Действие кнопки. Подпись выбирает рендерер по нему же, поэтому поля с
// текстом у кнопки нет; лот кнопки ленты рендерер находит в блоке по `lotId`.
export type AuctionButton =
  | { action: "feed.open-lot"; lotId: string; callbackData: string }
  | {
      action:
        | "feed.prev"
        | "feed.next"
        | "lot.refresh"
        | "lot.history"
        | "lot.back"
        | "history.prev"
        | "history.next"
        | "history.back";
      callbackData: string;
    };

export type AuctionScreenBody = {
  blocks: readonly AuctionBlock[];
  keyboard: readonly (readonly AuctionButton[])[];
};
