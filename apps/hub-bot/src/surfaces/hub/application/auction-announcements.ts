import {
  type AnnouncementButton,
  type AnnouncementButtonKind,
  type AnnouncementPhoto,
  type AnnouncementPost,
  checkAnnouncementText,
} from "../../../core/notifications/organizer-announcement.js";
import { type RpcMetadata, rpcMeta } from "../../../core/rpc-metadata.js";
import type { AuctionConsoles, AuctionFailure } from "../auction/port.js";
import type { NotificationFailure } from "../notifications/port.js";
import type {
  AuctionConsoleSnapshot,
  ExecuteResult,
  Person,
  StepWindow,
} from "./types.js";

// Объявление аукциона в пульте (PER-765, эпик PER-763): держатель права вести
// аукцион выбирает своё объявление или шаблон, пишет текст ответом, выбирает
// кнопку и фото лота, смотрит предпросмотр со счётчиком получателей и
// отправляет. Своего состояния нет, как у пульта: шаблон, лот и фото едут в
// кнопках и в шаге вопроса номерами, текст — в сообщении бота, а ключ
// рождается на «Отправить». Каждый шаг читает пульт заново: так право решает
// Auction, а лот и его фото — сейчас, а не в момент вопроса. Приём, право и
// рассылку держит Notifications (PER-764), и адресует она объявление сходкой:
// связи «аукцион — сходка» у неё нет, поэтому шаги, которые зовут
// Notifications, несут сходку — её край берёт из памяти процесса.
// Своё фото или видео (PER-776) приходит сюда уже постом чата медиа ботов —
// номером поста: публикует его представление, потому что это вызов Telegram.
// Аудитория (PER-779, решение PER-768) — шаг любого объявления: шаблон её
// предвыбирает, подтверждение её меняет, а считает и сужает Notifications по
// Auction. Список людей край не получает.

/** Порт приёма объявления; адаптер — клиент Notifications хаба. */
export type AuctionAnnouncements = {
  // Сколько человек получит объявление аукциона сейчас.
  previewAuctionAnnouncement(
    person: Person,
    meetupId: string,
    audience: AnnouncementAudience,
    meta?: RpcMetadata,
  ): Promise<AnnouncementAudienceResult>;
  // Приём: `created` ложен на повторе того же ключа.
  announceAuction(
    person: Person,
    command: AnnouncementCommand,
    meta?: RpcMetadata,
  ): Promise<AnnouncementAcceptResult>;
};

export type AnnouncementCommand = {
  meetupId: string;
  announcementId: string;
  text: string;
  audience: AnnouncementAudience;
  button?: AnnouncementButton;
  photo?: AnnouncementPhoto;
  post?: AnnouncementPost;
};

export type AnnouncementAudienceResult =
  | { kind: "ok"; recipientCount: number }
  | NotificationFailure;

export type AnnouncementAcceptResult =
  | { kind: "ok"; created: boolean }
  | NotificationFailure;

/**
 * Кому из держателей права ставок уходит объявление (PER-768): все или те,
 * кто ещё не в розыгрыше, без прогноза открытого раунда или то либо другое.
 */
export type AnnouncementAudience =
  | "all"
  | "not-in-raffle"
  | "without-predictions"
  | "not-in-raffle-or-without-predictions";

/** Шаблоны эпика и своё объявление. */
export type AnnouncementTemplate =
  | "own"
  | "raffle"
  | "windows"
  | "lot"
  | "chronicle";

/** Выбор кнопки: вид или «Без кнопки». */
export type ButtonChoice = AnnouncementButtonKind | "none";

// Кнопка, которую шаблон предлагает первой: её ведёт текст черновика. После
// закрытия регистрации шаблон розыгрыша говорит только о прогнозах.
function templateButton(
  template: AnnouncementTemplate,
  raffleOpen: boolean,
): AnnouncementButtonKind | undefined {
  switch (template) {
    case "own":
      return undefined;
    case "raffle":
      return raffleOpen ? "raffle" : "predictions";
    case "windows":
      return "lots";
    case "lot":
      return "lot";
    case "chronicle":
      return "chronicle";
    default: {
      const _exhaustive: never = template;
      return _exhaustive;
    }
  }
}

/**
 * Откуда черновик берёт слова. Сам текст черновика — представления: моменты
 * пишутся по времени сообщества, а слова — дизайн-код бота.
 */
export type AnnouncementDraft =
  | { kind: "own" }
  // `raffle` ложен после закрытия регистрации: шаблон тогда — «Прогнозы».
  | {
      kind: "raffle";
      raffle: boolean;
      prize?: string;
      closesAt?: string;
      predictions: boolean;
    }
  | { kind: "windows"; window: StepWindow; lotTitles: readonly string[] }
  | { kind: "lot"; title: string }
  | { kind: "chronicle" };

export type AnnouncementTextError = "empty" | "too-long" | "nul";

/** Лот в выборе: номер в реестре по порядку заведения и название. */
export type AnnouncementLot = { index: number; lotId: string; title: string };

type Call = {
  identity: Person;
  auctionId: string;
  requestId?: string;
  useCase?: string;
  deadlineAt?: number;
};

// `ref` — номер окна у «Счастливых часов» и номер лота в реестре у «Истории
// лота»; `lot` и `photo` — номер лота в реестре и номер его фото с нуля: в
// 64 байта кнопки идентификаторы с аукционом и отпечатком не помещаются.
export type AuctionAnnouncementRequest =
  | (Call & { intent: "open-announcement" })
  | (Call & { intent: "list-announcement-windows" })
  | (Call & { intent: "list-announcement-lots" })
  | (Call & {
      intent: "ask-announcement";
      template: AnnouncementTemplate;
      ref?: number;
    })
  | (Call & {
      intent: "answer-announcement";
      template: AnnouncementTemplate;
      ref?: number;
      value: string;
    })
  // `audience` — предвыбор шаблона или выбор в подтверждении (PER-779).
  | (Call & {
      intent: "pick-announcement-button";
      meetupId: string;
      button: ButtonChoice;
      audience: AnnouncementAudience;
      lot?: number;
    })
  // Вопрос о своём фото или видео (PER-776): шаг тот же, что у выбора фото.
  | (Call & {
      intent: "ask-announcement-media";
      button: ButtonChoice;
      audience: AnnouncementAudience;
      lot?: number;
    })
  // Шаг «Кому» (PER-779): после кнопки и фото, а из подтверждения — «Нет».
  | (Call & {
      intent: "ask-announcement-audience";
      meetupId: string;
      button: ButtonChoice;
      audience: AnnouncementAudience;
      lot?: number;
      photo?: number;
      post?: AnnouncementPost;
    })
  | (Call & {
      intent: "preview-announcement";
      meetupId: string;
      button: ButtonChoice;
      audience: AnnouncementAudience;
      lot?: number;
      photo?: number;
      post?: AnnouncementPost;
    })
  | (Call & {
      intent: "send-announcement";
      meetupId: string;
      announcementId: string;
      text: string;
      button: ButtonChoice;
      audience: AnnouncementAudience;
      lot?: number;
      photo?: number;
      post?: AnnouncementPost;
    });

export type AuctionAnnouncementResult =
  | {
      kind: "announcement-menu";
      auctionId: string;
      // Шаблон розыгрыша: до закрытия регистрации — «Розыгрыш и прогнозы»,
      // после — «Прогнозы», пока открыт раунд; иначе его нет.
      raffle: "raffle" | "predictions" | undefined;
      windows: number;
      lots: number;
      chronicle: boolean;
    }
  | {
      kind: "announcement-windows";
      auctionId: string;
      windows: readonly StepWindow[];
    }
  | {
      kind: "announcement-lots";
      auctionId: string;
      lots: readonly AnnouncementLot[];
    }
  | {
      kind: "announcement-ask";
      auctionId: string;
      template: AnnouncementTemplate;
      ref?: number;
      draft: AnnouncementDraft;
      error?: AnnouncementTextError;
    }
  | {
      kind: "announcement-button-ask";
      auctionId: string;
      text: string;
      // Кнопки, которые аукцион сейчас может нести, — первой та, что ведёт
      // текст шаблона.
      buttons: readonly AnnouncementButtonKind[];
      // Предвыбор шаблона: его шаги несут дальше до подтверждения.
      audience: AnnouncementAudience;
      lot?: AnnouncementLot;
    }
  // Фото лота шаблона и, при включённом чате медиа, своё фото или видео
  // (PER-776): без лота шаг предлагает только своё медиа.
  | {
      kind: "announcement-photo-ask";
      auctionId: string;
      button: ButtonChoice;
      audience: AnnouncementAudience;
      lot?: AnnouncementLot;
      photos: number;
      media: boolean;
    }
  | {
      kind: "announcement-media-ask";
      auctionId: string;
      button: ButtonChoice;
      audience: AnnouncementAudience;
      lot?: AnnouncementLot;
    }
  // Шаг «Кому»: аудитории, которые аукцион может назвать сейчас, и та, что
  // выбрана, — предвыбор шаблона или выбор до «Нет» подтверждения.
  | {
      kind: "announcement-audience-ask";
      auctionId: string;
      button: ButtonChoice;
      lot?: AnnouncementLot;
      photo?: number;
      post?: AnnouncementPost;
      audience: AnnouncementAudience;
      audiences: readonly AnnouncementAudience[];
    }
  | {
      kind: "announcement-preview";
      auctionId: string;
      button: ButtonChoice;
      lot?: AnnouncementLot;
      photo?: { index: number } & AnnouncementPhoto;
      post?: AnnouncementPost;
      // Выбранная аудитория и те, что аукцион может назвать сейчас: на них
      // подтверждение предлагает её сменить.
      audience: AnnouncementAudience;
      audiences: readonly AnnouncementAudience[];
      recipientCount: number;
    }
  | { kind: "announcement-sent"; auctionId: string; repeated: boolean }
  // Шаг устарел: окна, лота или фото, на которые он ссылался, в пульте больше
  // нет, либо объявлять аукцион уже некому. Своё медиа (PER-776): чат медиа
  // выключен — `media-off`, пост не опубликовался — `media-failed`. Аудиторию
  // шага аукцион больше назвать не может — `audience-gone` (PER-779).
  | {
      kind: "announcement-outcome";
      auctionId: string;
      note: AnnouncementOutcomeNote;
    };

export type AnnouncementOutcomeNote =
  | "window-gone"
  | "lot-gone"
  | "photo-gone"
  | "closed"
  | "media-off"
  | "media-failed"
  | "audience-gone";

const notAdministrator: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "not-administrator",
};
const auctionNotFound: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "auction-not-found",
};

function failed(failure: AuctionFailure | NotificationFailure): ExecuteResult {
  switch (failure.kind) {
    case "invalid":
      return {
        kind: "dependency-rejected",
        reason: "invalid",
        cause: failure.cause,
      };
    // Отказ по праву у Notifications — тот же отказ пульта: право вести
    // аукцион решает сервис, а не край.
    case "forbidden":
      return notAdministrator;
    case "conflict":
      return { kind: "dependency-rejected", reason: "invalid", cause: failure };
    default:
      return { kind: "dependency-rejected", reason: failure.kind };
  }
}

/** Объявление уместно, пока участники видят аукцион и он не кончился. */
export function announceable(console: AuctionConsoleSnapshot): boolean {
  switch (console.status) {
    case "scheduled":
      return !console.hidden;
    case "prebidding":
    case "break":
      return true;
    default:
      return false;
  }
}

// Регистрация в розыгрыше закрыта: момент T прошёл (ADR-066).
function raffleClosed(console: AuctionConsoleSnapshot, now: Date): boolean {
  const closesAt = console.week?.raffleClosesAt;
  return closesAt !== undefined && Date.parse(closesAt) <= now.getTime();
}

// Регистрация идёт: розыгрыш открывается с онлайн-торгами, а T впереди.
function raffleOpen(console: AuctionConsoleSnapshot, now: Date): boolean {
  return (
    console.status !== "scheduled" &&
    console.week?.raffleClosesAt !== undefined &&
    !raffleClosed(console, now)
  );
}

// Раунд прогнозов открыт: каталог — всю онлайн-неделю (PER-723). Раунд финала
// открывается с составом, когда объявление пульт уже не предлагает.
function predictionRoundOpen(console: AuctionConsoleSnapshot): boolean {
  return (
    console.status === "prebidding" && console.predictionTally !== undefined
  );
}

/**
 * Аудитории, которые аукцион может назвать сейчас, в порядке подтверждения.
 * Фильтр розыгрыша живёт до T, фильтр прогнозов — пока открыт раунд, а
 * смешанный — пока открыты оба: иначе Notifications откажет.
 */
export function announcementAudiences(
  console: AuctionConsoleSnapshot,
  now: Date,
): AnnouncementAudience[] {
  const raffle = raffleOpen(console, now);
  const predictions = predictionRoundOpen(console);
  return [
    "all",
    ...(raffle ? (["not-in-raffle"] as const) : []),
    ...(predictions ? (["without-predictions"] as const) : []),
    ...(raffle && predictions
      ? (["not-in-raffle-or-without-predictions"] as const)
      : []),
  ];
}

// Предвыбор шаблона: «Розыгрыш и прогнозы» зовёт тех, кто ещё не в розыгрыше
// или без прогнозов, — самым широким из открытых сейчас фильтров; остальные
// шаблоны — всех.
function templateAudience(
  template: AnnouncementTemplate,
  available: readonly AnnouncementAudience[],
): AnnouncementAudience {
  if (template !== "raffle") return "all";
  const preferred: readonly AnnouncementAudience[] = [
    "not-in-raffle-or-without-predictions",
    "not-in-raffle",
    "without-predictions",
  ];
  return preferred.find((audience) => available.includes(audience)) ?? "all";
}

/** Лоты реестра по порядку заведения — идентификатор лота UUIDv7. */
export function announcementLots(
  console: AuctionConsoleSnapshot,
): AnnouncementLot[] {
  return [...console.lots]
    .sort((a, b) => (a.lot.lotId < b.lot.lotId ? -1 : 1))
    .map((entry, index) => ({
      index,
      lotId: entry.lot.lotId,
      title: entry.lot.card?.title ?? "Лот без названия",
    }));
}

/** Окна «Счастливых часов» пульта: объявленные, затем запущенные. */
export function announcementWindows(
  console: AuctionConsoleSnapshot,
): readonly StepWindow[] {
  return [...(console.week?.windows ?? []), ...console.launchedWindows];
}

/** Кнопки, которые объявление этого аукциона может нести сейчас. */
export function availableButtons(
  console: AuctionConsoleSnapshot,
  first: AnnouncementButtonKind | undefined,
  withLot: boolean,
): AnnouncementButtonKind[] {
  const all: AnnouncementButtonKind[] = [
    "auction",
    "lots",
    ...(withLot ? (["lot"] as const) : []),
    // Розыгрыш открывается вместе с онлайн-торгами (ADR-066): до них кнопке
    // вести некуда.
    ...(console.week?.raffleClosesAt === undefined ||
    console.status === "scheduled"
      ? []
      : (["raffle"] as const)),
    ...(console.predictionTally === undefined
      ? []
      : (["predictions"] as const)),
    // «Хроники дня» участник видит в онлайн-торгах (PER-725).
    ...(console.status === "prebidding" ? (["chronicle"] as const) : []),
  ];
  return first !== undefined && all.includes(first)
    ? [first, ...all.filter((kind) => kind !== first)]
    : all;
}

type Picked =
  | {
      ok: true;
      lot?: AnnouncementLot;
      button?: AnnouncementButton;
      photo?: { index: number } & AnnouncementPhoto;
      photos: number;
    }
  | { ok: false; result: ExecuteResult };

// Лот, кнопка и фото шага по номерам из кнопки — из пульта, прочитанного
// сейчас. Лот, который выпал из реестра, или фото, которого у лота больше нет,
// — устаревший шаг, а не команда с чужим лотом.
function pick(
  console: AuctionConsoleSnapshot,
  auctionId: string,
  choice: { button: ButtonChoice; lot?: number; photo?: number },
): Picked {
  const outcome = (note: "lot-gone" | "photo-gone"): Picked => ({
    ok: false,
    result: { kind: "announcement-outcome", auctionId, note },
  });
  const lot =
    choice.lot === undefined
      ? undefined
      : announcementLots(console)[choice.lot];
  if (choice.lot !== undefined && lot === undefined) return outcome("lot-gone");
  if (choice.button === "lot" && lot === undefined) return outcome("lot-gone");
  const photos =
    lot === undefined
      ? []
      : (console.lots.find((entry) => entry.lot.lotId === lot.lotId)?.lot.card
          ?.photos ?? []);
  const photo = choice.photo === undefined ? undefined : photos[choice.photo];
  if (choice.photo !== undefined && photo === undefined) {
    return outcome("photo-gone");
  }
  const button: AnnouncementButton | undefined =
    choice.button === "none"
      ? undefined
      : choice.button === "lot" && lot !== undefined
        ? { kind: "lot", lotId: lot.lotId }
        : choice.button === "lot"
          ? undefined
          : { kind: choice.button };
  return {
    ok: true,
    photos: photos.length,
    ...(lot === undefined ? {} : { lot }),
    ...(button === undefined ? {} : { button }),
    ...(photo === undefined || lot === undefined || choice.photo === undefined
      ? {}
      : {
          photo: {
            index: choice.photo,
            lotId: lot.lotId,
            photoId: photo.photoId,
          },
        }),
  };
}

export function createAuctionAnnouncements(
  consoles: Pick<AuctionConsoles, "getAuctionConsole" | "consoleRaffle">,
  announcements: AuctionAnnouncements,
  // Чат медиа ботов включён (PER-776): шаг фото предлагает своё медиа.
  // Часы решают, прошёл ли момент T розыгрыша; тест их подменяет.
  options: { media?: boolean; now?: () => Date } = {},
) {
  const media = options.media === true;
  const clock = options.now ?? (() => new Date());
  type Read =
    | { kind: "ok"; console: AuctionConsoleSnapshot }
    | { kind: "refused"; result: ExecuteResult };

  async function read(request: Call): Promise<Read> {
    const found = await consoles.getAuctionConsole(
      request.identity,
      request.auctionId,
      rpcMeta(request),
    );
    switch (found.kind) {
      case "ok":
        break;
      case "not-administrator":
      case "meetup-not-found":
        return { kind: "refused", result: notAdministrator };
      case "auction-not-found":
        return { kind: "refused", result: auctionNotFound };
      default:
        return { kind: "refused", result: failed(found) };
    }
    // Аукцион, который участники не видят или который кончился, объявлять
    // некому: кнопка устарела.
    if (!announceable(found.console)) {
      return {
        kind: "refused",
        result: {
          kind: "announcement-outcome",
          auctionId: request.auctionId,
          note: "closed",
        },
      };
    }
    return { kind: "ok", console: found.console };
  }

  // Черновик шаблона: что назвать. Розыгрыш после открытия недели держит приз
  // сам (PER-737), поэтому приз читается у него, а сроки — у недели.
  async function draftOf(
    request: Call,
    console: AuctionConsoleSnapshot,
    template: AnnouncementTemplate,
    ref: number | undefined,
  ): Promise<
    | { ok: true; draft: AnnouncementDraft }
    | { ok: false; result: ExecuteResult }
  > {
    const gone = (note: "window-gone" | "lot-gone") => ({
      ok: false as const,
      result: {
        kind: "announcement-outcome" as const,
        auctionId: request.auctionId,
        note,
      },
    });
    const ok = (draft: AnnouncementDraft) => ({ ok: true as const, draft });
    switch (template) {
      case "own":
        return ok({ kind: "own" });
      case "chronicle":
        return ok({ kind: "chronicle" });
      case "lot": {
        const lot =
          ref === undefined ? undefined : announcementLots(console)[ref];
        return lot === undefined
          ? gone("lot-gone")
          : ok({ kind: "lot", title: lot.title });
      }
      case "windows": {
        const window =
          ref === undefined ? undefined : announcementWindows(console)[ref];
        if (window === undefined) return gone("window-gone");
        const titles = new Map(
          announcementLots(console).map((lot) => [lot.lotId, lot.title]),
        );
        return ok({
          kind: "windows",
          window,
          lotTitles: window.lotIds.flatMap((lotId) => {
            const title = titles.get(lotId);
            return title === undefined ? [] : [title];
          }),
        });
      }
      case "raffle": {
        const raffle = await consoles.consoleRaffle(
          request.identity,
          request.auctionId,
          rpcMeta(request),
        );
        // Отказ чтения розыгрыша черновик не роняет: приз тогда — из сроков.
        const prize =
          (raffle.kind === "ok" ? raffle.raffle?.prize : undefined) ??
          console.week?.rafflePrize;
        const closesAt = console.week?.raffleClosesAt;
        return ok({
          kind: "raffle",
          raffle: !raffleClosed(console, clock()),
          ...(prize === undefined ? {} : { prize }),
          ...(closesAt === undefined ? {} : { closesAt }),
          predictions: console.predictionTally !== undefined,
        });
      }
      default: {
        const _exhaustive: never = template;
        return _exhaustive;
      }
    }
  }

  async function preview(
    request: Call & {
      meetupId: string;
      button: ButtonChoice;
      audience: AnnouncementAudience;
      lot?: number;
      photo?: number;
      post?: AnnouncementPost;
    },
  ): Promise<ExecuteResult> {
    const [found, counted] = await Promise.all([
      read(request),
      announcements.previewAuctionAnnouncement(
        request.identity,
        request.meetupId,
        request.audience,
        rpcMeta(request),
      ),
    ]);
    if (found.kind === "refused") return found.result;
    const picked = pick(found.console, request.auctionId, request);
    if (!picked.ok) return picked.result;
    const audiences = announcementAudiences(found.console, clock());
    if (!audiences.includes(request.audience)) return audienceGone(request);
    if (counted.kind !== "ok") return failed(counted);
    return {
      kind: "announcement-preview",
      auctionId: request.auctionId,
      button: request.button,
      ...(picked.lot === undefined ? {} : { lot: picked.lot }),
      ...(picked.photo === undefined ? {} : { photo: picked.photo }),
      ...(request.post === undefined ? {} : { post: request.post }),
      audience: request.audience,
      audiences,
      recipientCount: counted.recipientCount,
    };
  }

  // Шаг «Кому». Выбирать не из чего — до розыгрыша и прогнозов или после них
  // — шаг ведёт сразу к предпросмотру «всем». Выбор, которого аукцион больше
  // не назовёт, шаг не держит: первой тогда стоит «всем».
  async function askAudience(
    request: Call & {
      meetupId: string;
      button: ButtonChoice;
      audience: AnnouncementAudience;
      lot?: number;
      photo?: number;
      post?: AnnouncementPost;
    },
    console: AuctionConsoleSnapshot,
  ): Promise<ExecuteResult> {
    const picked = pick(console, request.auctionId, request);
    if (!picked.ok) return picked.result;
    const audiences = announcementAudiences(console, clock());
    if (audiences.length === 1) return preview({ ...request, audience: "all" });
    return {
      kind: "announcement-audience-ask",
      auctionId: request.auctionId,
      button: request.button,
      ...(picked.lot === undefined ? {} : { lot: picked.lot }),
      ...(picked.photo === undefined ? {} : { photo: picked.photo.index }),
      ...(request.post === undefined ? {} : { post: request.post }),
      audience: audiences.includes(request.audience) ? request.audience : "all",
      audiences,
    };
  }

  // Аудитория шага устарела — T прошёл или раунд закрылся: объявление не
  // уходит ни ей, ни молча всем.
  function audienceGone(request: Call): ExecuteResult {
    return {
      kind: "announcement-outcome",
      auctionId: request.auctionId,
      note: "audience-gone",
    };
  }

  async function send(
    request: Extract<
      AuctionAnnouncementRequest,
      { intent: "send-announcement" }
    >,
  ): Promise<ExecuteResult> {
    const found = await read(request);
    if (found.kind === "refused") return found.result;
    const picked = pick(found.console, request.auctionId, request);
    if (!picked.ok) return picked.result;
    const audiences = announcementAudiences(found.console, clock());
    if (!audiences.includes(request.audience)) return audienceGone(request);
    const accepted = await announcements.announceAuction(
      request.identity,
      {
        meetupId: request.meetupId,
        announcementId: request.announcementId,
        text: request.text,
        audience: request.audience,
        ...(picked.button === undefined ? {} : { button: picked.button }),
        ...(picked.photo === undefined
          ? {}
          : {
              photo: {
                lotId: picked.photo.lotId,
                photoId: picked.photo.photoId,
              },
            }),
        ...(request.post === undefined ? {} : { post: request.post }),
      },
      rpcMeta(request),
    );
    if (accepted.kind !== "ok") return failed(accepted);
    return {
      kind: "announcement-sent",
      auctionId: request.auctionId,
      repeated: !accepted.created,
    };
  }

  return async (
    request: AuctionAnnouncementRequest,
  ): Promise<ExecuteResult> => {
    switch (request.intent) {
      case "open-announcement": {
        const found = await read(request);
        if (found.kind === "refused") return found.result;
        const { console } = found;
        const raffle =
          console.week?.raffleClosesAt === undefined
            ? undefined
            : !raffleClosed(console, clock())
              ? ("raffle" as const)
              : predictionRoundOpen(console)
                ? ("predictions" as const)
                : undefined;
        return {
          kind: "announcement-menu",
          auctionId: request.auctionId,
          raffle,
          windows: announcementWindows(console).length,
          lots: console.lots.length,
          chronicle: console.status === "prebidding",
        };
      }
      case "list-announcement-windows": {
        const found = await read(request);
        if (found.kind === "refused") return found.result;
        return {
          kind: "announcement-windows",
          auctionId: request.auctionId,
          windows: announcementWindows(found.console),
        };
      }
      case "list-announcement-lots": {
        const found = await read(request);
        if (found.kind === "refused") return found.result;
        return {
          kind: "announcement-lots",
          auctionId: request.auctionId,
          lots: announcementLots(found.console),
        };
      }
      case "ask-announcement":
      case "answer-announcement": {
        const found = await read(request);
        if (found.kind === "refused") return found.result;
        const { console } = found;
        const { template, ref } = request;
        const drafted = await draftOf(request, console, template, ref);
        if (!drafted.ok) return drafted.result;
        const asked = {
          kind: "announcement-ask" as const,
          auctionId: request.auctionId,
          template,
          ...(ref === undefined ? {} : { ref }),
          draft: drafted.draft,
        };
        if (request.intent === "ask-announcement") return asked;
        const checked = checkAnnouncementText(request.value);
        if (checked.kind !== "ok") return { ...asked, error: checked.kind };
        const lot =
          template === "lot" && ref !== undefined
            ? announcementLots(console)[ref]
            : undefined;
        return {
          kind: "announcement-button-ask",
          auctionId: request.auctionId,
          text: checked.text,
          buttons: availableButtons(
            console,
            templateButton(template, !raffleClosed(console, clock())),
            lot !== undefined,
          ),
          audience: templateAudience(
            template,
            announcementAudiences(console, clock()),
          ),
          ...(lot === undefined ? {} : { lot }),
        };
      }
      case "pick-announcement-button": {
        const found = await read(request);
        if (found.kind === "refused") return found.result;
        const picked = pick(found.console, request.auctionId, request);
        if (!picked.ok) return picked.result;
        // Фото — одно из фото выбранного лота или своё фото или видео через
        // чат медиа (PER-776); выбирать нечего — шаг сразу ведёт к «Кому».
        if (media || (picked.lot !== undefined && picked.photos > 0)) {
          return {
            kind: "announcement-photo-ask",
            auctionId: request.auctionId,
            button: request.button,
            audience: request.audience,
            ...(picked.lot === undefined ? {} : { lot: picked.lot }),
            photos: picked.photos,
            media,
          };
        }
        return askAudience(request, found.console);
      }
      case "ask-announcement-audience": {
        const found = await read(request);
        if (found.kind === "refused") return found.result;
        return askAudience(request, found.console);
      }
      case "ask-announcement-media": {
        // Подделанная кнопка при выключенном чате медиа вопроса не задаёт.
        if (!media) {
          return {
            kind: "announcement-outcome",
            auctionId: request.auctionId,
            note: "media-off",
          };
        }
        const found = await read(request);
        if (found.kind === "refused") return found.result;
        const picked = pick(found.console, request.auctionId, request);
        if (!picked.ok) return picked.result;
        return {
          kind: "announcement-media-ask",
          auctionId: request.auctionId,
          button: request.button,
          audience: request.audience,
          ...(picked.lot === undefined ? {} : { lot: picked.lot }),
        };
      }
      case "preview-announcement":
        return preview(request);
      case "send-announcement":
        return send(request);
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
