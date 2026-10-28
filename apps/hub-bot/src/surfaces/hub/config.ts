import { type FaqContent, readFaqContent } from "../../auction-faq.js";
import {
  type Env,
  type Loaded,
  readBotUsername,
  reader,
} from "../../core/config.js";

// Своё у поверхности хаба: адреса Meetups, Notifications и Auction и имя бота
// аукциона для ссылок каналов прихода. Токены, среда, пояс, форма карточки и
// шина — общая конфигурация процесса (`src/core/config.ts`).
export type HubConfig = {
  meetupsUrl: string;
  notificationsUrl: string;
  faq: FaqContent;
  achievementsUrl?: string;
  // Аукцион сходки (PER-307) — расширение, а не опора бота: без адреса Auction
  // карточка сходки обходится без ряда аукциона. В графе AppHost адрес
  // передаётся всегда; пустым он остаётся только у запуска вне графа.
  auctionUrl?: string;
  // Имя бота аукциона без «@» для экрана каналов прихода (PER-441).
  auctionBotUsername?: string;
  // Имя бота поддержки без «@» для «Написать в поддержку ↗» в «Помощи» и в
  // кадре ожидания допуска (PER-625, ADR-068). Без него ряда и кнопки нет.
  supportBotUsername?: string;
};

export function readHubConfig(env: Env): Loaded<HubConfig> {
  const read = reader(env);
  const achievementsUrl = read("ACHIEVEMENTS_GRPC_URL");
  const faq = readFaqContent(env);
  if (!faq.ok) return faq;
  // Опечатка в имени бота аукциона дала бы администратору ссылку в чужой или
  // несуществующий бот, поэтому форма проверяется на старте, а не молча.
  const auctionBot = readBotUsername(env, "BOT_AUCTION_BOT_USERNAME");
  if (!auctionBot.ok) return auctionBot;
  // Та же проверка у бота поддержки: ссылка «Помощи» и кадра ожидания ведёт
  // в чужой бот так же молча (PER-625, ADR-068).
  const supportBot = readBotUsername(env, "BOT_SUPPORT_BOT_USERNAME");
  if (!supportBot.ok) return supportBot;
  const auctionUrl = read("AUCTION_GRPC_URL");
  return {
    ok: true,
    config: {
      meetupsUrl: read("MEETUPS_GRPC_URL") ?? "http://127.0.0.1:50052",
      notificationsUrl:
        read("NOTIFICATIONS_GRPC_URL") ?? "http://127.0.0.1:50053",
      faq: faq.content,
      ...(achievementsUrl === undefined ? {} : { achievementsUrl }),
      ...(auctionUrl === undefined ? {} : { auctionUrl }),
      ...(auctionBot.config === undefined
        ? {}
        : { auctionBotUsername: auctionBot.config }),
      ...(supportBot.config === undefined
        ? {}
        : { supportBotUsername: supportBot.config }),
    },
  };
}
