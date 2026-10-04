import {
  type AuctionBotPorts,
  type AuctionResult,
  type GlobalRole,
  handleAuctionUpdate,
  parseAuctionCallback,
  type ResolvedIdentity,
} from "@solguficky/auction-bot-ui";
import type { Person } from "../application/types.js";

// Торговое нажатие в боте хаба (ADR-044, «Доступ как обязательный шлюз»):
// личность уже разрешена краем, один раз на update, и уезжает в шлюз пакета
// готовой. Поверхность — `hub`: шлюз пускает круг `member`. Над этой функцией
// идёт contract suite пакета — той же, что и в маршруте бота.
export function hubTradeCallback(input: {
  ports: AuctionBotPorts;
  identity: ResolvedIdentity;
  data: string;
}): Promise<AuctionResult> {
  return handleAuctionUpdate(
    { kind: "hub", ports: input.ports },
    { identity: input.identity, input: { kind: "callback", data: input.data } },
  );
}

/**
 * Кнопка принадлежит аукциону: домен `auc`, даже нечитаемая. Чужой домен —
 * кнопка хаба, и её разбирает `parse-callback.ts`.
 */
export function isAuctionCallback(data: string): boolean {
  const parsed = parseAuctionCallback(data);
  return parsed.ok || parsed.error.reason !== "foreign";
}

const packageRoles: readonly GlobalRole[] = [
  "admin",
  "maintainer",
  "member",
  "public",
];

/** Личность края в словаре пакета: роли, которых пакет не знает, не едут. */
export function packageIdentity(
  person: Person,
  blocked: boolean,
): ResolvedIdentity {
  return {
    identityId: person.identityId,
    globalRoles: packageRoles.filter((role) =>
      person.globalRoles.includes(role),
    ),
    blocked,
  };
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
