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
 * Кнопка принадлежит аукциону: второй сегмент — домен `auc`, даже если сама
 * кнопка нечитаема. Всё остальное, включая кнопки хаба без версии, разбирает
 * `parse-callback.ts`: пакет назвал бы их нечитаемыми, а не чужими.
 */
export function isAuctionCallback(data: string): boolean {
  return data.split(":")[1] === AUCTION_CALLBACK_DOMAIN;
}

/** Личность края в словаре пакета: смотрящий несёт права, роли не едут. */
export function packageIdentity(
  person: Person,
  blocked: boolean,
): ResolvedIdentity {
  return { viewer: viewerOf(person), blocked };
}

/**
 * `file_id` наибольшего размера из ответа rich-сообщения. Фото лежит в блоке
 * `photo` его `rich_message` (зонд PER-450); блоки бывают вложенными, поэтому
 * обход идёт по всему ответу, а не по первому уровню.
 */
export function photoFileId(message: unknown): string | undefined {
  const rich = (message as { rich_message?: unknown } | undefined)
    ?.rich_message;
  return findPhoto(rich);
}

function findPhoto(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPhoto(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node !== "object" || node === null) return undefined;
  const block = node as { type?: unknown; photo?: unknown };
  if (block.type === "photo" && Array.isArray(block.photo)) {
    const largest = block.photo.at(-1) as { file_id?: unknown } | undefined;
    if (typeof largest?.file_id === "string") return largest.file_id;
  }
  for (const value of Object.values(node)) {
    const found = findPhoto(value);
    if (found !== undefined) return found;
  }
  return undefined;
}
