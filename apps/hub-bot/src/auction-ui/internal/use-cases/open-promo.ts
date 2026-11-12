import { encodeAuctionCallback } from "../../callback-data.js";
import type { AuctionPort, Viewer } from "../../ports.js";
import type { AuctionScreenBody } from "../../screen.js";

// Промо-видео аукциона (PER-774): номер поста в чате медиа ботов из сводки
// аукциона, прочитанной сейчас, — видео могли заменить или убрать, пока корень
// висел в чате. Сам пост присылает оболочка: это вызов Telegram, а дерево
// Telegram не знает. Без чата медиа поста нет, и подделанная кнопка получает
// то же «видео недоступно», что и удалённый пост.
//
// Сырой юзкейс: доступ он не проверяет и поэтому из пакета не экспортируется.
// Отказ чтения аукциона бросается, как у корня.
export async function openPromo(input: {
  auction: AuctionPort;
  media?: true;
  viewer: Viewer;
  auctionId: string;
}): Promise<AuctionScreenBody> {
  const auction =
    input.media === undefined
      ? undefined
      : await input.auction.getAuction({
          viewer: input.viewer,
          auctionId: input.auctionId,
        });
  const postId = auction?.promoVideo;
  return {
    blocks: [
      {
        kind: "promo",
        auctionId: input.auctionId,
        ...(postId === undefined ? {} : { postId }),
      },
    ],
    keyboard: [
      [
        {
          action: "promo.back",
          callbackData: encodeAuctionCallback({
            kind: "root",
            auctionId: input.auctionId,
          }),
        },
      ],
    ],
  };
}
