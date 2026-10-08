import { type Env, type Loaded, reader } from "../../core/config.js";
import { type FaqContent, readFaqContent } from "./faq.js";

// Своё у поверхности аукциона: адрес Auction и тексты FAQ. Токены, среда,
// пояс, форма карточки и шина — общая конфигурация процесса
// (`src/core/config.ts`).
export type AuctionConfig = {
  auctionUrl: string;
  faq: FaqContent;
};

export function readAuctionConfig(env: Env): Loaded<AuctionConfig> {
  const faq = readFaqContent(env);
  if (!faq.ok) return faq;
  return {
    ok: true,
    config: {
      auctionUrl: reader(env)("AUCTION_GRPC_URL") ?? "http://127.0.0.1:8081",
      faq: faq.content,
    },
  };
}
