import type { AuctionScreens } from "../auction/port.js";
import type { CommunityDay } from "../community-time.js";
import {
  meetupsInBotButton,
  type WhisperCommand,
  type WhisperFrame,
} from "./community-whisper.js";
import { readCurrentEvents } from "./current-events.js";
import { eventsSectionStartLink } from "./meetup-deep-link.js";
import {
  eventLines,
  eventsTitle,
  type HubEvent,
  noEventsText,
} from "./screens/events.js";
import { escapeHtml, screenText } from "./screens/kit.js";

// `/events` в чате сообщества (PER-884): строки раздела «События» шёпотом и
// ссылка в сам раздел, где у события есть вход. Строки те же, что видит
// человек в боте: событие и строка состояния аукциона — стадия, день недели
// торгов, «Счастливые часы» и срок регистрации в розыгрыше. Денег, ставок и
// имён в них нет, а скрытый аукцион событием не бывает (ADR-078, п. 4).

export function eventsWhisperFrame(
  events: readonly HubEvent[],
  timeZone: string,
  today: CommunityDay,
  botUsername: string,
  now: Date = new Date(),
): WhisperFrame {
  const lines = eventLines(events, timeZone, today, now);
  if (lines.length === 0) {
    // Пустые «События» ведут в «Сходки» (PER-914): подпись называет раздел,
    // а не общее «Открыть бота».
    return {
      id: "whisper-events",
      text: screenText(eventsTitle, noEventsText),
      buttons: [meetupsInBotButton(botUsername)],
    };
  }
  return {
    id: "whisper-events",
    text: screenText(
      eventsTitle,
      lines.map((line) => escapeHtml(line)).join("\n"),
    ),
    // Ссылка со `start` присылает сам раздел «События» и у того, кто уже
    // писал боту: голая `t.me/<бот>` открыла бы чат без нового сообщения.
    buttons: [
      { label: "Все события в боте", url: eventsSectionStartLink(botUsername) },
    ],
  };
}

/**
 * Запись реестра шёпота. Бот без Auction событий не знает: шёпот — пустой
 * кадр, как раздел в личке, а не отказ.
 */
export function eventsWhisper(
  auction: AuctionScreens | undefined,
  timeZone: string,
): WhisperCommand {
  return {
    useCase: "view_auction",
    async answer({ person, meta, botUsername, today }) {
      const events = await readCurrentEvents(auction, person, meta);
      if (events.kind === "unavailable") {
        return {
          kind: "failed",
          message: "events rejected",
          category: "dependency_unavailable",
          error: "auction_unavailable",
        };
      }
      return {
        kind: "frame",
        frame: eventsWhisperFrame(events.events, timeZone, today, botUsername),
      };
    },
  };
}
