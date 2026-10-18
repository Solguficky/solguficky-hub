import { type FaqContent, readFaqContent } from "../../auction-faq.js";
import { type Env, type Loaded, reader } from "../../core/config.js";
import { isTelegramBotUsername } from "./presentation/source-deep-link.js";

// Своё у поверхности хаба: адреса Meetups, Notifications и Auction и имя бота
// аукциона для ссылок каналов прихода. Токены, среда, пояс, форма карточки и
// шина — общая конфигурация процесса (`src/core/config.ts`).
export type HubConfig = {
  meetupsUrl: string;
  notificationsUrl: string;
  faq: FaqContent;
  // Аукцион сходки (PER-307) — расширение, а не опора бота: без адреса Auction
  // карточка сходки обходится без ряда аукциона. В графе AppHost адрес
  // передаётся всегда; пустым он остаётся только у запуска вне графа.
  auctionUrl?: string;
  // Имя бота аукциона без «@» для экрана каналов прихода (PER-441).
  auctionBotUsername?: string;
};

export function readHubConfig(env: Env): Loaded<HubConfig> {
  const read = reader(env);
  const faq = readFaqContent(env);
  if (!faq.ok) return faq;
  // Опечатка в имени бота аукциона дала бы администратору ссылку в чужой или
  // несуществующий бот, поэтому форма проверяется на старте, а не молча.
  const auctionBotUsername = read("BOT_AUCTION_BOT_USERNAME");
  if (
    auctionBotUsername !== undefined &&
    !isTelegramBotUsername(auctionBotUsername)
  ) {
    return {
      ok: false,
      error: "BOT_AUCTION_BOT_USERNAME must be a Telegram bot username",
    };
  }
  const auctionUrl = read("AUCTION_GRPC_URL");
  return {
    ok: true,
    config: {
      meetupsUrl: read("MEETUPS_GRPC_URL") ?? "http://127.0.0.1:50052",
      notificationsUrl:
        read("NOTIFICATIONS_GRPC_URL") ?? "http://127.0.0.1:50053",
      faq: faq.content,
      ...(auctionUrl === undefined ? {} : { auctionUrl }),
      ...(auctionBotUsername === undefined ? {} : { auctionBotUsername }),
    },
  };
}
