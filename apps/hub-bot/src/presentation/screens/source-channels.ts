import { InlineKeyboard } from "grammy";
import type { SourceChannel } from "../../identity/port.js";
import { sourceStartLink } from "../source-deep-link.js";
import {
  escapeHtml,
  pagedTitle,
  pageSize,
  paginate,
  screenText,
  toManage,
  withNav,
  withPager,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Каналы прихода (ADR-060, пункты 17–18). Экран отдаёт готовые ссылки
// `s_<код>` для пересылки: в бот хаба всегда, в бот аукциона — когда его имя
// задано конфигурацией. Удаления канала нет: заявка ссылается на канал.

export const sourceChannelsData = (page: number) => `v1:sc:l:${page}`;

/** Имена ботов, для которых экран собирает ссылки. */
export type SourceLinkBots = { hub: string; auction?: string };

function channelLines(channel: SourceChannel, bots: SourceLinkBots): string {
  const links = [
    `  Хаб: ${escapeHtml(sourceStartLink(bots.hub, channel.code))}`,
    ...(bots.auction === undefined
      ? []
      : [
          `  Аукцион: ${escapeHtml(sourceStartLink(bots.auction, channel.code))}`,
        ]),
  ];
  return [
    `• ${escapeHtml(channel.label)} · ${escapeHtml(channel.code)}`,
    ...links,
  ].join("\n");
}

/** Страница, на которой стоит канал с этим кодом; список упорядочен Identity. */
export function sourceChannelPage(
  channels: readonly SourceChannel[],
  code: string,
): number {
  const index = channels.findIndex((channel) => channel.code === code);
  return index === -1 ? 0 : Math.floor(index / pageSize);
}

export function sourceChannelsScreen(
  channels: readonly SourceChannel[],
  requestedPage: number,
  bots: SourceLinkBots,
  notice?: string,
): ShownScreen {
  const page = paginate(channels, requestedPage);
  const keyboard = new InlineKeyboard().text("Завести канал", "v1:sc:a");
  withPager(keyboard, page, sourceChannelsData);
  return {
    id: "source-channels",
    text: screenText(
      pagedTitle("Каналы прихода", page),
      notice === undefined ? undefined : escapeHtml(notice),
      page.items.length === 0
        ? "Пока ни одного."
        : page.items.map((channel) => channelLines(channel, bots)).join("\n"),
    ),
    keyboard: withNav(keyboard, toManage),
    format: "HTML",
  };
}
