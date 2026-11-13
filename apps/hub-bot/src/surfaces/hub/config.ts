import { type FaqContent, readFaqContent } from "../../auction-faq.js";
import { type HallLinks, readHallLinks } from "../../auction-hall.js";
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
  // Стрим и экран финала (PER-825, PER-832): кнопки-URL в корне аукциона и в
  // «Расширениях» сходки. Нет адресов — нет кнопок.
  hall: HallLinks;
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
  // Чат сообщества (ADR-078, п. 2): единственная группа, где бот хаба
  // работает. Из других групп он выходит. Нет — группы бот, как прежде, не
  // обрабатывает и ни из одной не выходит.
  communityChatId?: number;
};

// Id группы в Bot API отрицательный: у обычной группы — минус и номер, у
// супергруппы — `-100` и номер. Чат сообщества — обычная группа, а после
// миграции — супергруппа, поэтому годятся обе формы. Значение в чужой форме —
// отказ старта: иначе бот вышел бы из самого чата сообщества. Ноль группой
// не бывает: `-0` дал бы id, которому не равен ни один чат.
const groupId = /^-[1-9]\d*$/;

function readCommunityChatId(env: Env): Loaded<number | undefined> {
  const raw = reader(env)("BOT_COMMUNITY_CHAT_ID");
  if (raw === undefined) return { ok: true, config: undefined };
  const id = Number(raw);
  if (!groupId.test(raw) || !Number.isSafeInteger(id)) {
    return {
      ok: false,
      error: "BOT_COMMUNITY_CHAT_ID must be a group id like -…",
    };
  }
  return { ok: true, config: id };
}

export function readHubConfig(env: Env): Loaded<HubConfig> {
  const read = reader(env);
  const achievementsUrl = read("ACHIEVEMENTS_GRPC_URL");
  const faq = readFaqContent(env);
  if (!faq.ok) return faq;
  const hall = readHallLinks(env);
  if (!hall.ok) return { ok: false, error: hall.error };
  // Опечатка в имени бота аукциона дала бы администратору ссылку в чужой или
  // несуществующий бот, поэтому форма проверяется на старте, а не молча.
  const auctionBot = readBotUsername(env, "BOT_AUCTION_BOT_USERNAME");
  if (!auctionBot.ok) return auctionBot;
  // Та же проверка у бота поддержки: ссылка «Помощи» и кадра ожидания ведёт
  // в чужой бот так же молча (PER-625, ADR-068).
  const supportBot = readBotUsername(env, "BOT_SUPPORT_BOT_USERNAME");
  if (!supportBot.ok) return supportBot;
  const communityChat = readCommunityChatId(env);
  if (!communityChat.ok) return communityChat;
  const auctionUrl = read("AUCTION_GRPC_URL");
  return {
    ok: true,
    config: {
      meetupsUrl: read("MEETUPS_GRPC_URL") ?? "http://127.0.0.1:50052",
      notificationsUrl:
        read("NOTIFICATIONS_GRPC_URL") ?? "http://127.0.0.1:50053",
      faq: faq.content,
      hall: hall.links,
      ...(achievementsUrl === undefined ? {} : { achievementsUrl }),
      ...(auctionUrl === undefined ? {} : { auctionUrl }),
      ...(auctionBot.config === undefined
        ? {}
        : { auctionBotUsername: auctionBot.config }),
      ...(supportBot.config === undefined
        ? {}
        : { supportBotUsername: supportBot.config }),
      ...(communityChat.config === undefined
        ? {}
        : { communityChatId: communityChat.config }),
    },
  };
}
