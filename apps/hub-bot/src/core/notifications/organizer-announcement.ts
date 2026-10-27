import { create } from "@bufbuild/protobuf";
import { GrammyError, InputFile } from "grammy";
import {
  type AuctionNotice,
  type AuctionNoticeButton,
  AuctionNoticeButtonSchema,
  type AuctionNoticePhoto,
  AuctionNoticePhotoSchema,
  AuctionNoticeView,
} from "../../../gen/notifications/v1/notifications_pb.js";
import {
  encodeAuctionCallback,
  type LotImage,
} from "../../auction-ui/index.js";
import type { Logger } from "../logging.js";
import { marked, pictogram } from "../pictograms.js";
import { canonical } from "./lot-notice.js";

// Объявление аукциона (PER-765, эпик PER-763) — весть каждому держателю права
// ставок, которую составил держатель `run_auctions` в пульте хаба. У двух
// ботов она одна: участнику её доставляет бот хаба, гостю — бот аукциона,
// маршрут по кругу выбирает Notifications (PER-764). Здесь разбор факта
// `auction_notice`, перевод кнопки и фото в провод, подписи кнопок и отправка
// с фото лота — та же у предпросмотра в пульте и у доставки, поэтому
// предпросмотр показывает ровно то, что получит человек. Данные кнопки каждая
// поверхность кодирует своим следом.
//
// Права `place-bids` получателя канал перед объявлением не спрашивает:
// адресата выбрал издатель по тому же праву, как у вестей о новом аукционе.

/** Куда ведёт кнопка объявления — набор эпика PER-763. */
export type AnnouncementButtonKind =
  | "auction"
  | "lots"
  | "lot"
  | "raffle"
  | "predictions"
  | "chronicle";

export type AnnouncementButton =
  | { kind: Exclude<AnnouncementButtonKind, "lot"> }
  | { kind: "lot"; lotId: string };

/** Фото объявления — одно из фото лота Auction (своё медиа — PER-776). */
export type AnnouncementPhoto = { lotId: string; photoId: string };

export type OrganizerAnnouncement = {
  kind: "organizer-announcement";
  auctionId: string;
  text: string;
  button?: AnnouncementButton;
  photo?: AnnouncementPhoto;
};

export const announcementButtonLabels: Readonly<
  Record<AnnouncementButtonKind, string>
> = {
  auction: "К аукциону",
  // «К лотам» дизайн-код вывел из словаря: вход в ленту — «🔨 Лоты».
  lots: marked(pictogram.auction, "Лоты"),
  lot: "К лоту",
  raffle: "К розыгрышу",
  predictions: "Прогнозы",
  chronicle: "Хроники дня",
};

/**
 * Предел текста — подпись фото Telegram: с фото объявление уходит одним
 * сообщением-фотографией, и текст длиннее подписи не поместился бы. Тот же
 * предел и без фото: выбор фото после текста не должен отказывать тексту,
 * уже принятому на первом шаге.
 */
export const announcementTextLimit = 1024;

export type AnnouncementTextCheck =
  | { kind: "ok"; text: string }
  | { kind: "empty" }
  | { kind: "too-long" }
  | { kind: "nul" };

// Правила края проверяются до предпросмотра: отказ после «Отправить» стоил бы
// набранного текста. Окончательную проверку делает Notifications.
export function checkAnnouncementText(raw: string): AnnouncementTextCheck {
  const text = raw.trim();
  if (text === "") return { kind: "empty" };
  if (text.length > announcementTextLimit) return { kind: "too-long" };
  if (text.includes("\u0000")) return { kind: "nul" };
  return { kind: "ok", text };
}

const viewsToWire: Readonly<Record<AnnouncementButtonKind, AuctionNoticeView>> =
  {
    auction: AuctionNoticeView.AUCTION,
    lots: AuctionNoticeView.LOTS,
    lot: AuctionNoticeView.LOT,
    raffle: AuctionNoticeView.RAFFLE,
    predictions: AuctionNoticeView.PREDICTIONS,
    chronicle: AuctionNoticeView.CHRONICLE,
  };

export function wireAnnouncementButton(
  button: AnnouncementButton,
): AuctionNoticeButton {
  return create(AuctionNoticeButtonSchema, {
    view: viewsToWire[button.kind],
    lotId: button.kind === "lot" ? button.lotId : "",
  });
}

export function wireAnnouncementPhoto(
  photo: AnnouncementPhoto,
): AuctionNoticePhoto {
  return create(AuctionNoticePhotoSchema, {
    source: { case: "lotPhoto", value: photo },
  });
}

function buttonOf(
  wire: AuctionNoticeButton | undefined,
): AnnouncementButton | undefined | "malformed" {
  if (wire === undefined) return undefined;
  switch (wire.view) {
    case AuctionNoticeView.AUCTION:
      return { kind: "auction" };
    case AuctionNoticeView.LOTS:
      return { kind: "lots" };
    case AuctionNoticeView.RAFFLE:
      return { kind: "raffle" };
    case AuctionNoticeView.PREDICTIONS:
      return { kind: "predictions" };
    case AuctionNoticeView.CHRONICLE:
      return { kind: "chronicle" };
    case AuctionNoticeView.LOT: {
      const lotId = canonical(wire.lotId);
      return lotId === undefined ? "malformed" : { kind: "lot", lotId };
    }
    // Вид новее бота: текст важнее кнопки, и объявление уходит без неё.
    default:
      return undefined;
  }
}

// Факт — ввод соседа: кривой идентификатор аукциона или лота кнопки уронил бы
// кодировщик кнопки — это дефект издателя. Фото с кривой ссылкой — украшение,
// и объявление уходит без него. Источник фото новее бота — тоже без фото.
export function organizerAnnouncementOf(
  value: AuctionNotice,
): OrganizerAnnouncement | undefined {
  const auctionId = canonical(value.auctionId);
  if (auctionId === undefined || value.body.trim() === "") return undefined;
  const button = buttonOf(value.button);
  if (button === "malformed") return undefined;
  const source = value.photo?.source;
  const lotId =
    source?.case === "lotPhoto" ? canonical(source.value.lotId) : undefined;
  const photoId =
    source?.case === "lotPhoto" ? canonical(source.value.photoId) : undefined;
  return {
    kind: "organizer-announcement",
    auctionId,
    text: value.body,
    ...(button === undefined ? {} : { button }),
    ...(lotId === undefined || photoId === undefined
      ? {}
      : { photo: { lotId, photoId } }),
  };
}

/** Кнопка объявления: подпись и цель; данные кодирует поверхность. */
export type AnnouncementButtonView = {
  kind: AnnouncementButtonKind;
  text: string;
  auctionId: string;
  lotId?: string;
};

export type OrganizerAnnouncementView = {
  // Текст организатора как есть, простым текстом: разметки он не несёт, и
  // символы `<` и `&` в нём остаются символами.
  text: string;
  button?: AnnouncementButtonView;
  photo?: AnnouncementPhoto;
};

export function renderOrganizerAnnouncement(
  notice: Omit<OrganizerAnnouncement, "kind">,
): OrganizerAnnouncementView {
  const { button } = notice;
  return {
    text: notice.text,
    ...(button === undefined
      ? {}
      : {
          button: {
            kind: button.kind,
            text: announcementButtonLabels[button.kind],
            auctionId: notice.auctionId,
            ...(button.kind === "lot" ? { lotId: button.lotId } : {}),
          },
        }),
    ...(notice.photo === undefined ? {} : { photo: notice.photo }),
  };
}

/**
 * Данные кнопки — обычная кнопка аукционного дерева: поверхность оборачивает
 * её своим следом, и экран приходит новым сообщением, как у «К лоту» и «К
 * розыгрышу». Прогнозы открываются раундом каталога: объявление уходит до
 * финала, пока каталог открыт.
 */
export function announcementButtonData(button: AnnouncementButtonView): string {
  const { auctionId } = button;
  switch (button.kind) {
    case "auction":
      return encodeAuctionCallback({ kind: "root", auctionId });
    case "lots":
      return encodeAuctionCallback({ kind: "feed", auctionId, page: 0 });
    case "lot":
      return encodeAuctionCallback({
        kind: "lot",
        lotId: button.lotId ?? "",
        page: 0,
      });
    case "raffle":
      return encodeAuctionCallback({ kind: "raffle", auctionId });
    case "predictions":
      return encodeAuctionCallback({
        kind: "prediction",
        auctionId,
        round: "catalog",
      });
    case "chronicle":
      return encodeAuctionCallback({ kind: "day-chronicle", auctionId });
    default: {
      const _exhaustive: never = button.kind;
      return _exhaustive;
    }
  }
}

/**
 * Байты фото лота правами смотрящего; отказ — исключение, как у порта
 * изображения дерева. Смотрящий — получатель на доставке и автор в пульте.
 */
export type AnnouncementPhotoLoader = (
  photo: AnnouncementPhoto,
  viewerId: string,
) => Promise<LotImage>;

/**
 * Фото объявления у одного бота: `file_id` из первой загрузки, чтобы рассылка
 * на сотни человек грузила байты один раз. Кэш в памяти процесса: `file_id`
 * действует только у бота-получателя, а рестарт стоит одной загрузки.
 */
export type AnnouncementPhotos = {
  file(
    photo: AnnouncementPhoto,
    viewerId: string,
  ): Promise<InputFile | string | undefined>;
  remember(photo: AnnouncementPhoto, fileId: string): void;
  // `file_id`, который Telegram не принял, выпадает из кэша: следующий
  // получатель получит фото загрузкой, а не текст до рестарта.
  forget(photo: AnnouncementPhoto): void;
};

const photoCacheLimit = 200;

/** Запись о фото, которого Auction не отдал: объявление ушло текстом. */
export function logMissingAnnouncementPhoto(
  logger: Pick<Logger, "warn">,
): (cause: unknown) => void {
  return (cause) =>
    logger.warn("announcement photo unavailable", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
}

export function createAnnouncementPhotos(
  load: AnnouncementPhotoLoader,
  onUnavailable: (cause: unknown) => void,
): AnnouncementPhotos {
  const cache = new Map<string, string>();
  const keyOf = (photo: AnnouncementPhoto) => `${photo.lotId}:${photo.photoId}`;
  return {
    async file(photo, viewerId) {
      const cached = cache.get(keyOf(photo));
      if (cached !== undefined) return cached;
      try {
        const image = await load(photo, viewerId);
        return new InputFile(image.content, "lot");
      } catch (cause) {
        // Фото украшает объявление, а не держит его: без байтов оно уходит
        // текстом (критерий PER-765).
        onUnavailable(cause);
        return undefined;
      }
    },
    remember(photo, fileId) {
      cache.set(keyOf(photo), fileId);
      // Порядок вставки — порядок старшинства: выпадает самое старое фото.
      if (cache.size > photoCacheLimit) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
    },
    forget(photo) {
      cache.delete(keyOf(photo));
    },
  };
}

/** Минимум Bot API, которым уходит объявление: текст или фото с подписью. */
export type AnnouncementApi = {
  sendMessage(
    chatId: number,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  sendPhoto(
    chatId: number,
    photo: InputFile | string,
    other?: Record<string, unknown>,
  ): Promise<{ message_id: number; photo?: { file_id: string }[] }>;
};

// Разметка кнопок как её собрала поверхность: grammY `InlineKeyboard` или
// готовый `inline_keyboard`.
export type AnnouncementMarkup = { inline_keyboard: readonly unknown[] };

/**
 * Отправка объявления одному человеку. С фото — сообщение-фотография с текстом
 * подписью; фото, которое не загрузилось или которое Telegram не принял, —
 * объявление уходит текстом. Отказ отправки текста бросается: его классифицирует
 * вызывающий — доставка своими классами, предпросмотр своим экраном сбоя.
 * Ответ — номер сообщения и ушло ли фото: предпросмотр без фото не должен
 * обещать фото рассылке.
 */
export async function sendOrganizerAnnouncement(
  api: AnnouncementApi,
  chatId: number,
  view: OrganizerAnnouncementView,
  options: {
    photos: AnnouncementPhotos;
    viewerId: string;
    markup?: AnnouncementMarkup | undefined;
    // Метка каталога экранов: линтер test kit видит и эту отправку.
    mark: Record<string, unknown>;
  },
): Promise<{ messageId: number; withPhoto: boolean }> {
  const keyboard =
    options.markup === undefined ? {} : { reply_markup: options.markup };
  if (view.photo !== undefined) {
    const file = await options.photos.file(view.photo, options.viewerId);
    if (file !== undefined) {
      try {
        const sent = await api.sendPhoto(chatId, file, {
          ...options.mark,
          caption: view.text,
          ...keyboard,
        });
        const largest = sent.photo?.at(-1)?.file_id;
        if (largest !== undefined) options.photos.remember(view.photo, largest);
        return { messageId: sent.message_id, withPhoto: true };
      } catch (cause) {
        // 400 у загрузки — отказ в самом изображении: объявление уходит
        // текстом. Прочий сбой — сеть, лимит или блокировка — общий исход
        // отправки: повтор решает вызывающий.
        if (!(cause instanceof GrammyError) || cause.error_code !== 400) {
          throw cause;
        }
        if (typeof file === "string") options.photos.forget(view.photo);
      }
    }
  }
  const sent = await api.sendMessage(chatId, view.text, {
    ...options.mark,
    ...keyboard,
    link_preview_options: { is_disabled: true },
  });
  return { messageId: sent.message_id, withPhoto: false };
}
