import { createHash } from "node:crypto";
import type {
  AchievementScreen,
  AchievementsIntent,
  AchievementsPort,
} from "../../achievement-types.js";
import { encodeAuctionCallback, uuidToToken } from "../../callback-data.js";
import type { AuctionPort, Viewer } from "../../ports.js";
import type { AuctionScreenBody } from "../../screen.js";

const pageSize = 6;
const holderPageSize = 8;
// Код определения может быть длиннее бюджета callback. Отпечаток стабилен и
// сверяется с заново прочитанным набором; неоднозначное совпадение не открывается.
export const achievementReference = (code: string): string =>
  createHash("sha256").update(code).digest("hex").slice(0, 12);

export async function openAchievements(input: {
  auction: AuctionPort;
  achievements?: AchievementsPort;
  viewer: Viewer;
  intent: AchievementsIntent;
}): Promise<AuctionScreenBody> {
  const { intent } = input;
  const scope = intent.auctionId === undefined ? "mine" : "event";
  const event =
    intent.auctionId === undefined ? {} : { auctionId: intent.auctionId };
  const list = (page: number) =>
    encodeAuctionCallback({ kind: "achievements", ...event, page });
  const back =
    intent.kind === "achievement"
      ? list(intent.page)
      : intent.auctionId === undefined
        ? "v1:entry:menu"
        : encodeAuctionCallback({ kind: "root", auctionId: intent.auctionId });
  const base = { scope, ...event, page: 0, pages: 1, items: [], back } as const;
  const body = (screen: AchievementScreen): AuctionScreenBody => ({
    blocks: [{ kind: "achievements", screen }],
    keyboard: [],
  });
  try {
    // Публичность набора не даёт права увидеть скрытый аукцион.
    if (
      intent.auctionId !== undefined &&
      (await input.auction.getAuction({
        viewer: input.viewer,
        auctionId: intent.auctionId,
      })) === undefined
    ) {
      return body({ ...base, view: "list" });
    }
    if (input.achievements === undefined)
      throw new Error("achievements not configured");
    const rows =
      intent.auctionId === undefined
        ? (await input.achievements.listMine(input.viewer.identityId)).map(
            (held) => ({
              achievement: held.achievement,
              reference: uuidToToken(held.grantId),
              grantedAt: held.grantedAt,
              holderIds: [] as readonly string[],
              erasedHolders: 0,
            }),
          )
        : (await input.achievements.getEvent(intent.auctionId)).map(
            (entry) => ({
              ...entry,
              reference: achievementReference(entry.achievement.code),
              grantedAt: undefined,
            }),
          );
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.min(intent.page, pages - 1);
    if (intent.kind === "achievements") {
      return body({
        ...base,
        view: "list",
        page,
        pages,
        items: rows
          .slice(page * pageSize, (page + 1) * pageSize)
          .map((row) => ({
            title: row.achievement.title,
            callbackData: encodeAuctionCallback({
              kind: "achievement",
              ...event,
              reference: row.reference,
              page,
              holdersPage: 0,
            }),
          })),
        ...(page > 0 ? { previous: list(page - 1) } : {}),
        ...(page + 1 < pages ? { next: list(page + 1) } : {}),
      });
    }
    const matches = rows.filter((row) => row.reference === intent.reference);
    const row = matches.length === 1 ? matches[0] : undefined;
    // Подделанная или устаревшая ссылка не даёт чужой выдачи: только новый список.
    if (row === undefined)
      return openAchievements({
        ...input,
        intent: { kind: "achievements", ...event, page },
      });
    const holderPages = Math.max(
      1,
      Math.ceil(row.holderIds.length / holderPageSize),
    );
    const holdersPage = Math.min(intent.holdersPage, holderPages - 1);
    const ids = row.holderIds.slice(
      holdersPage * holderPageSize,
      (holdersPage + 1) * holderPageSize,
    );
    const names =
      intent.auctionId === undefined || ids.length === 0
        ? ({} as Readonly<Record<string, string>>)
        : await input.auction.getDisplayNames({
            viewer: input.viewer,
            auctionId: intent.auctionId,
            participantIds: ids,
          });
    const card = (holdersPage: number) =>
      encodeAuctionCallback({ ...intent, page, holdersPage });
    return body({
      ...base,
      view: "card",
      page,
      pages,
      achievement: row.achievement,
      ...(row.grantedAt === undefined ? {} : { grantedAt: row.grantedAt }),
      holderNames: ids.map((id) => names[id] ?? "Имя не выбрано"),
      erasedHolders: row.erasedHolders,
      holdersPage,
      holderPages,
      ...(holdersPage > 0 ? { previous: card(holdersPage - 1) } : {}),
      ...(holdersPage + 1 < holderPages ? { next: card(holdersPage + 1) } : {}),
    });
  } catch (cause) {
    input.achievements?.reportFailure?.(cause);
    return body({
      ...base,
      view: "unavailable",
      retry: encodeAuctionCallback(intent),
      ...(intent.kind === "achievement" ? { backToList: true } : {}),
    });
  }
}
