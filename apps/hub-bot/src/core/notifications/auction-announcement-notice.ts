import type { OnlinePhase } from "../../../gen/auction/v1/auction_pb.js";
import type {
  AuctionPublished,
  AuctionTradingOpened,
  StepWindowAnnounced,
} from "../../../gen/notifications/v1/notifications_pb.js";
import { marked, pictogram } from "../pictograms.js";
import { localTime } from "./lot-notice.js";

// Вести о новом аукционе и об открытии торгов (PER-646) и общая весть о
// начале «Счастливых часов» (PER-766; ADR-047, дополнение 2026-10-27) — по
// одной каждому
// держателю права ставок. У двух ботов они одни: участнику Их доставляет бот
// хаба, гостю — бот аукциона, маршрут по кругу получателя выбирает Notifications
// (ADR-064). Здесь разбор ветки, текст и кнопка; данные кнопки каждая
// поверхность кодирует своим следом, как у итога розыгрыша.
//
// Права `place-bids` получателя канал перед этими вестями не спрашивает:
// адресата выбрал издатель по тому же праву, а снятое право после — повод не
// отзывать уже сказанное. Имя сходки приезжает в факте (у аукциона своего
// названия нет), неделя — снимком онлайн-фазы: у черновика её нет, и весть дат
// тогда не называет.

export type AuctionAnnouncementNotice =
  | {
      kind: "new-auction";
      auctionId: string;
      meetupTitle: string;
      //моменты онлайн-недели, как они пришли в факте: непонятный момент весть
      //не показывает, а не подменяет полуночью.
      opensAt?: string;
      closesAt?: string;
    }
  | {
      kind: "trading-opened";
      auctionId: string;
      meetupTitle: string;
      opensAt?: string;
      closesAt?: string;
    }
  | {
      // Окно сниженного шага началось, а получатель не следит ни за одним его
      // лотом: следящему Notifications шлёт свою весть с лотами
      // (step-window-notice.ts), а эту — нет.
      kind: "step-window-announced";
      auctionId: string;
      // Конец окна — RFC 3339, самый поздний из концов окон этого начала.
      until: string;
      lotCount: number;
    };

// Аукцион сходки — UUIDv5, свой — UUIDv7: версия не проверяется, только
// каноническая форма, из которой кодировщик кнопки соберёт токен.
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Факт — ввод соседа: кривой идентификатор аукциона — дефект издателя, и разбор
// отвечает `undefined`, как у остальных веток. Пустое название сходки — не
// дефект: реплика может знать сходку по идентификатору, и весть тогда её не
// называет.
export function newAuctionNoticeOf(
  value: AuctionPublished,
): AuctionAnnouncementNotice | undefined {
  if (!CANONICAL_UUID.test(value.auctionId)) return undefined;
  return {
    kind: "new-auction",
    auctionId: value.auctionId,
    meetupTitle: value.meetupTitle,
    ...phaseOf(value.onlinePhase),
  };
}

export function tradingOpenedNoticeOf(
  value: AuctionTradingOpened,
): AuctionAnnouncementNotice | undefined {
  if (!CANONICAL_UUID.test(value.auctionId)) return undefined;
  return {
    kind: "trading-opened",
    auctionId: value.auctionId,
    meetupTitle: value.meetupTitle,
    ...phaseOf(value.onlinePhase),
  };
}

// Ноль лотов и конец не как момент — дефект издателя: весть «шаг ниже на 0
// лотах» или без срока была бы неправдой, и разбор отвечает `undefined`.
export function stepWindowAnnouncedNoticeOf(
  value: StepWindowAnnounced,
): AuctionAnnouncementNotice | undefined {
  if (!CANONICAL_UUID.test(value.auctionId)) return undefined;
  if (value.lotCount === 0) return undefined;
  if (Number.isNaN(Date.parse(value.until))) return undefined;
  return {
    kind: "step-window-announced",
    auctionId: value.auctionId,
    until: value.until,
    lotCount: value.lotCount,
  };
}

// Пустая строка — отсутствие поля, как у схемы: момент, которого нет, весть не
// называет. Моменты остаются строками: понятность проверяет рендер, а не разбор.
function phaseOf(phase: OnlinePhase | undefined): {
  opensAt?: string;
  closesAt?: string;
} {
  if (phase === undefined) return {};
  return {
    ...(phase.opensAt === "" ? {} : { opensAt: phase.opensAt }),
    ...(phase.closesAt === undefined || phase.closesAt === ""
      ? {}
      : { closesAt: phase.closesAt }),
  };
}

// Кнопка следа: «Аукцион» ведёт в корень аукциона, «Лоты» — в его ленты. Экран
// приходит новым сообщением, весть остаётся в истории.
export type AuctionAnnouncementButton = { auctionId: string; text: string };

export type AuctionAnnouncementView = {
  text: string;
  button: AuctionAnnouncementButton;
};

const newAuctionLabel = "Аукцион";
const tradingOpenedLabel = "Лоты";
// «К лотам» дизайн-код вывел из словаря: вход в ленту — «🏷️ Лоты», как у
// кнопки объявления аукциона (organizer-announcement.ts).
const stepWindowLabel = marked(pictogram.auction, "Лоты");

const dayFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

// Одна-две фразы на «ты», без заголовка и разметки (дизайн-код, «Уведомления
// аукциона»). Сходка названа в кавычках, как в остальных вестях; сроки недели
// идут по часам сообщества.
export function renderAuctionAnnouncement(
  notice: AuctionAnnouncementNotice,
  timeZone: string,
): AuctionAnnouncementView {
  if (notice.kind === "step-window-announced") {
    const until = localTime(notice.until, timeZone);
    return {
      text: `Счастливые часы${until === undefined ? "" : ` до ${until}`}: шаг ниже на ${lotsOn(notice.lotCount)}.`,
      button: { auctionId: notice.auctionId, text: stepWindowLabel },
    };
  }
  const meetup = notice.meetupTitle.trim();
  const of = meetup === "" ? "сходки" : `сходки «${meetup}»`;
  const opens = momentText(notice.opensAt, timeZone);
  const closes = momentText(notice.closesAt, timeZone);
  if (notice.kind === "new-auction") {
    return {
      text: `Аукцион ${of} открыт: ${weekText(opens, closes)}.`,
      button: { auctionId: notice.auctionId, text: newAuctionLabel },
    };
  }
  return {
    text:
      closes === undefined
        ? "Торги открыты."
        : `Торги открыты: неделя идёт до ${closes}.`,
    button: { auctionId: notice.auctionId, text: tradingOpenedLabel },
  };
}

// «на 1 лоте», «на 3 лотах», «на 11 лотах»: предложный падеж различает только
// единственное число.
function lotsOn(count: number): string {
  const single = count % 10 === 1 && count % 100 !== 11;
  return `${count} ${single ? "лоте" : "лотах"}`;
}

// «торги с 20 октября, 12:00 по 26 октября, 22:00»; конца нет — «до», начала
// нет — только конец, обоих нет — срок ещё не назначен.
function weekText(
  opens: string | undefined,
  closes: string | undefined,
): string {
  if (opens !== undefined && closes !== undefined) {
    return `торги с ${opens} по ${closes}`;
  }
  if (closes !== undefined) return `торги до ${closes}`;
  if (opens !== undefined) return `торги с ${opens}`;
  return "сроки объявлю, когда их назначат";
}

// Момент по часам сообщества: «26 октября, 22:00». Непонятный момент — пусто:
// весть не выдумывает времени, которого не знает.
function momentText(
  instant: string | undefined,
  timeZone: string,
): string | undefined {
  if (instant === undefined || instant === "") return undefined;
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const [year, month, day, hours, minutes] = [
    part("year"),
    part("month"),
    part("day"),
    part("hour"),
    part("minute"),
  ];
  if ([year, month, day, hours, minutes].some(Number.isNaN)) return undefined;
  const label = dayFormat.format(new Date(Date.UTC(year, month - 1, day)));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${label}, ${pad(hours)}:${pad(minutes)}`;
}
