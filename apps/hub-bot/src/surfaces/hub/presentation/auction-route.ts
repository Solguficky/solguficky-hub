import {
  AUCTION_CALLBACK_DOMAIN,
  type AuctionBotPorts,
  type AuctionResult,
  type AuctionUpdate,
  handleAuctionUpdate,
  type ResolvedIdentity,
  type TelegramUser,
} from "../../../auction-ui/index.js";
import type { Person } from "../application/types.js";
import { viewerOf } from "../auction/port.js";
import { eventsEntryDomain } from "./screens/kit.js";

// Торговое нажатие в боте хаба (ADR-044, «Доступ как обязательный шлюз»):
// личность уже разрешена краем, один раз на update, и уезжает в шлюз пакета
// готовой. Поверхность — `hub`: шлюз пускает право хаба. Над этой функцией
// идёт contract suite пакета — той же, что и в маршруте бота.
//
// `input` — нажатие кнопки либо ответ на аукционный вопрос: шаг вопроса из
// `reply_to_message` и текст ответа (PER-317). `user` — кто прислал update:
// адресат вопроса и ник для выбора имени в аукционе.
export function hubTradeCallback(input: {
  ports: AuctionBotPorts;
  identity: ResolvedIdentity;
  user: TelegramUser;
  input: AuctionUpdate["input"];
}): Promise<AuctionResult> {
  return handleAuctionUpdate(
    { kind: "hub", ports: input.ports },
    { identity: input.identity, user: input.user, input: input.input },
  );
}

/**
 * Кнопка принадлежит аукциону: второй сегмент — домен `auc` или `aue` —
 * то же дерево со входом из «Событий» (PER-669), — даже если сама кнопка
 * нечитаема. Всё остальное, включая кнопки хаба без версии, разбирает
 * `parse-callback.ts`: пакет назвал бы их нечитаемыми, а не чужими.
 */
export function isAuctionCallback(data: string): boolean {
  const segments = data.split(":");
  return (
    segments[1] === AUCTION_CALLBACK_DOMAIN ||
    segments[1] === eventsEntryDomain ||
    (segments[1] === "t" && segments[2] === AUCTION_CALLBACK_DOMAIN)
  );
}

/** Личность края в словаре пакета: смотрящий несёт только права. */
export function packageIdentity(
  person: Person,
  blocked: boolean,
): ResolvedIdentity {
  return { viewer: viewerOf(person), blocked };
}
