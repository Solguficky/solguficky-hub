// Каноническое тело аукционного экрана (ADR-044, «Один аукцион, две оболочки»).
// Одинаково в обоих ботах: приложение оборачивает его в свою оболочку —
// `HubScreen` или `AuctionEntryScreen` — и только затем переводит в Telegram
// API. Текстов поверхности здесь нет: блоки семантические, подписи к ним
// выбирает рендерер.

export type AuctionBlock = {
  kind: "lot";
  lotId: string;
  auctionId: string;
  version: number;
};

export type AuctionButton = {
  // Действие кнопки. Подпись выбирает рендерер по нему же, поэтому поля с
  // текстом у кнопки нет.
  action: "lot.refresh";
  callbackData: string;
};

export type AuctionScreenBody = {
  blocks: readonly AuctionBlock[];
  keyboard: readonly (readonly AuctionButton[])[];
};
