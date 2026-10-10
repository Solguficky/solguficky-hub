import { type Env, type Loaded, reader } from "../../core/config.js";
import { type FaqContent, readFaqContent } from "./faq.js";

// Своё у поверхности аукциона: адреса Auction и Notifications и тексты FAQ.
// Токены, среда, пояс, форма карточки и шина — общая конфигурация процесса
// (`src/core/config.ts`).
export type AuctionConfig = {
  auctionUrl: string;
  faq: FaqContent;
  // Настройка «перебили» (PER-515) — расширение, а не опора бота: без адреса
  // Notifications нет ни пункта меню «Уведомления», ни «Реже» под
  // перебитием. Профиль `auction-bot` Notifications не поднимает, и
  // перебитий без него тоже нет.
  notificationsUrl?: string;
};

export function readAuctionConfig(env: Env): Loaded<AuctionConfig> {
  const read = reader(env);
  const faq = readFaqContent(env);
  if (!faq.ok) return faq;
  const notificationsUrl = read("NOTIFICATIONS_GRPC_URL");
  return {
    ok: true,
    config: {
      auctionUrl: read("AUCTION_GRPC_URL") ?? "http://127.0.0.1:8081",
      faq: faq.content,
      ...(notificationsUrl === undefined ? {} : { notificationsUrl }),
    },
  };
}
