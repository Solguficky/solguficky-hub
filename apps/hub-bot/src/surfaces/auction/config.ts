import {
  type Env,
  type Loaded,
  readBotUsername,
  reader,
} from "../../core/config.js";
import { type FaqContent, readFaqContent } from "./faq.js";

// Своё у поверхности аукциона: адреса Auction и Notifications и тексты FAQ.
// Токены, среда, пояс, форма карточки и шина — общая конфигурация процесса
// (`src/core/config.ts`).
export type AuctionConfig = {
  auctionUrl: string;
  faq: FaqContent;
  achievementsUrl?: string;
  // Настройка «перебили» (PER-515) и избранные лоты (PER-495) — расширение,
  // а не опора бота: без адреса Notifications нет ни пункта меню
  // «Уведомления», ни «Частоты уведомлений» под вестями о торгах, ни кнопки избранного на карточке
  // и пункта «Избранное».
  notificationsUrl?: string;
  // Имя бота поддержки без «@» для кнопки кадра ожидания допуска (PER-625,
  // ADR-068). Без него кнопки нет.
  supportBotUsername?: string;
};

export function readAuctionConfig(env: Env): Loaded<AuctionConfig> {
  const read = reader(env);
  const achievementsUrl = read("ACHIEVEMENTS_GRPC_URL");
  const faq = readFaqContent(env);
  if (!faq.ok) return faq;
  const notificationsUrl = read("NOTIFICATIONS_GRPC_URL");
  // Имя бота поддержки — адрес кнопки кадра ожидания допуска (PER-625,
  // ADR-068): без него кнопки нет, а чужое имя — отказ конфигурации.
  const supportBot = readBotUsername(env, "BOT_SUPPORT_BOT_USERNAME");
  if (!supportBot.ok) return supportBot;
  return {
    ok: true,
    config: {
      auctionUrl: read("AUCTION_GRPC_URL") ?? "http://127.0.0.1:8081",
      faq: faq.content,
      ...(achievementsUrl === undefined ? {} : { achievementsUrl }),
      ...(notificationsUrl === undefined ? {} : { notificationsUrl }),
      ...(supportBot.config === undefined
        ? {}
        : { supportBotUsername: supportBot.config }),
    },
  };
}
