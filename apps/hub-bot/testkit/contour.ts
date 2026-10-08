import { randomBytes, randomInt } from "node:crypto";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import type { Update } from "grammy/types";
import { IdentityService } from "../gen/identity/v1/identity_service_pb.js";
import { GlobalRole } from "../gen/identity/v1/roles_pb.js";
import { MeetupVisibility } from "../gen/meetups/v1/meetups_pb.js";
import { MeetupsService } from "../gen/meetups/v1/meetups_service_pb.js";
import { presentServiceToken } from "../src/core/rpc-metadata.js";
import { noopTracing } from "../src/core/tracing.js";
import { createDispatcher } from "../src/surfaces/hub/application/dispatcher.js";
import { createAuctionClient } from "../src/surfaces/hub/auction/client.js";
import { communityDay } from "../src/surfaces/hub/community-time.js";
import { createIdentityClient } from "../src/surfaces/hub/identity/client.js";
import { createMeetupsClient } from "../src/surfaces/hub/meetups/client.js";
import type { TelegramFiles } from "../src/surfaces/hub/presentation/telegram-files.js";
import { type PhotoVariant, photoVariantOf } from "./conversation.js";
import {
  createHarness,
  type HarnessOptions,
  type LogRecord,
  type RecordedCall,
} from "./harness.js";

// Провод бота против настоящих Identity и Meetups (уровень L2). Среду поднимает
// Contour.Host (`just contour-bot-test`), а этот модуль ею не владеет: он
// читает адреса из окружения и закрывает только свои gRPC-сессии.

// Тот же пояс, что AppHost отдаёт Meetups (`CommunityTime.Zone`): иначе граница
// «прошедшей» даты у бота и у Meetups разъедется.
export const contourTimeZone = "Europe/Moscow";

const readinessBudgetMs = 60_000;
const readinessPauseMs = 500;
const directCallTimeoutMs = 10_000;

export type ContourEnvironment = {
  identityUrl: string;
  meetupsUrl: string;
  maintainerToken: string;
  /** Токен вызывающего Hub Bot (ADR-056): провод играет бота. */
  botServiceToken: string;
  /**
   * Адрес Auction, когда контур поднят с ним (`Contour.Host --with-auction`).
   * Без него провод собирает бота без ряда аукциона, как процесс без
   * `AUCTION_GRPC_URL`: аукцион — расширение хаба, а не часть контура.
   */
  auctionUrl?: string;
};

const variables = {
  identityUrl: "IDENTITY_GRPC_URL",
  meetupsUrl: "MEETUPS_GRPC_URL",
  maintainerToken: "IDENTITY_MAINTAINER_TOKEN",
  botServiceToken: "HUB_BOT_SERVICE_TOKEN",
} as const;

const auctionVariable = "AUCTION_GRPC_URL";

/**
 * Нет переменной — отказ с её именем, а не пропуск: пропущенный сквозной набор
 * выглядел бы в отчёте как пройденный. Адрес Auction необязателен и читается,
 * только если контур его отдал.
 */
export function readContourEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ContourEnvironment {
  const missing = Object.values(variables).filter(
    (name) => env[name] === undefined || env[name] === "",
  );
  if (missing.length > 0) {
    throw new Error(
      `контур не передал ${missing.join(", ")}: набор запускается через ` +
        "`just contour-bot-test` или в среде `just contour-up`",
    );
  }
  const auctionUrl = env[auctionVariable];
  return {
    identityUrl: env[variables.identityUrl] ?? "",
    meetupsUrl: env[variables.meetupsUrl] ?? "",
    maintainerToken: env[variables.maintainerToken] ?? "",
    botServiceToken: env[variables.botServiceToken] ?? "",
    ...(auctionUrl === undefined || auctionUrl === "" ? {} : { auctionUrl }),
  };
}

/**
 * Прямые клиенты сервисов мимо бота: готовность, выдача роли и независимая
 * проверка итога. Итог сценария читается отсюда, а не из ответа бота — иначе
 * провод проверял бы сам себя.
 */
export function openDirectClients(environment: ContourEnvironment) {
  const identitySessions = new Http2SessionManager(environment.identityUrl);
  const meetupsSessions = new Http2SessionManager(environment.meetupsUrl);
  // Токен бота Identity — заголовком вызова, а не интерцептором транспорта, как
  // у Meetups: тот же клиент шлёт maintainer-RPC, и интерцептор перетёр бы их
  // секрет ADR-037 токеном бота.
  const identity = createClient(
    IdentityService,
    createGrpcTransport({
      baseUrl: environment.identityUrl,
      defaultTimeoutMs: directCallTimeoutMs,
      sessionManager: identitySessions,
    }),
  );
  const asBot = {
    headers: { authorization: `Bearer ${environment.botServiceToken}` },
  };
  const meetups = createClient(
    MeetupsService,
    createGrpcTransport({
      baseUrl: environment.meetupsUrl,
      defaultTimeoutMs: directCallTimeoutMs,
      sessionManager: meetupsSessions,
      interceptors: [presentServiceToken(environment.botServiceToken)],
    }),
  );
  async function asMaintainer(
    call: (options: { headers: Record<string, string> }) => Promise<unknown>,
  ): Promise<void> {
    try {
      await call({
        headers: { authorization: `Bearer ${environment.maintainerToken}` },
      });
    } catch (cause) {
      // Токен чеканится на каждый подъём контура: dotenv от прошлого
      // `just contour-up` несёт чужой, и без этой строки отказ читался бы
      // как дефект Identity.
      if (ConnectError.from(cause).code === Code.Unauthenticated) {
        throw new Error(
          "Identity не принял токен maintainer'а: переменные окружения от другого подъёма контура",
          { cause },
        );
      }
      throw cause;
    }
  }
  return {
    identity,
    meetups,
    /** Готовность — настоящий RPC, а не health: health-контракт в `contracts/proto/` не входит. */
    async waitUntilReachable(): Promise<void> {
      // Пустой запрос: любой ответ, кроме «не дозвонился», значит, что сервис
      // принял вызов. Состояние от этого не меняется — сервис отвергает
      // запрос до хранилища. Бюджет общий на оба сервиса, чтобы он заведомо
      // укладывался в hookTimeout и отказ называл адрес, а не хук vitest.
      const deadline = Date.now() + readinessBudgetMs;
      await retryWhileUnreachable(
        "Identity",
        environment.identityUrl,
        deadline,
        // Метод бота с токеном бота: проба проходит гейт вызывающих (ADR-056)
        // и получает отказ обработчика, а не запись authorization на каждом
        // подъёме контура.
        () => identity.resolveTelegramUserId({}, asBot),
      );
      await retryWhileUnreachable(
        "Meetups",
        environment.meetupsUrl,
        deadline,
        () => meetups.getMeetup({}),
      );
    },
    /**
     * Роль выдаётся настоящим `GrantAdminRole`, а не подставляется в запрос:
     * иначе сценарий остался бы зелёным при сломанном хранении ролей.
     */
    async grantAdmin(telegramUserId: bigint): Promise<string> {
      const resolved = await identity.resolveIdentity(
        { telegramUserId },
        asBot,
      );
      await asMaintainer((options) =>
        identity.grantAdminRole({ identityId: resolved.identityId }, options),
      );
      return resolved.identityId;
    },
    /**
     * Отзыв роли настоящим `RevokeAdminRole`: экран, отрисованный
     * администратору, остаётся у человека в чате и после отзыва.
     */
    async revokeAdmin(identityId: string): Promise<void> {
      await asMaintainer((options) =>
        identity.revokeAdminRole({ identityId }, options),
      );
    },
    /**
     * Человек из сценария среза: ник заранее внесён администратором в
     * whitelist, и роль `member` он получает на первом `/start` сам — тем же
     * путём, что в продукте, а не выдачей в обход Identity.
     */
    async allowUsername(adminId: string, username: string): Promise<void> {
      await identity.addAllowedUsername(
        {
          actor: { identityId: adminId, globalRoles: [GlobalRole.ADMIN] },
          username,
        },
        asBot,
      );
    },
    /** Профиль, который Identity уже завёл для этого Telegram id. */
    async identityOf(telegramUserId: bigint): Promise<string> {
      const resolved = await identity.resolveIdentity(
        { telegramUserId },
        asBot,
      );
      return resolved.identityId;
    },
    async readAsAdmin(identityId: string, meetupId: string) {
      const snapshot = await meetups.getMeetup({
        viewer: asAdmin(identityId),
        id: meetupId,
      });
      return {
        title: snapshot.title,
        venue: snapshot.venue,
        description: snapshot.description,
        visible: snapshot.visibility === MeetupVisibility.VISIBLE,
      };
    },
    /** Названия материалов сходки в порядке карточки, прочитанные мимо бота. */
    async materialsAsAdmin(
      identityId: string,
      meetupId: string,
    ): Promise<string[]> {
      const snapshot = await meetups.getMeetup({
        viewer: asAdmin(identityId),
        id: meetupId,
      });
      return snapshot.materials.map((material) => material.title);
    },
    /** Прямой вызов Meetups с ключом, как его передал бы бот. */
    async createDraftAsAdmin(identityId: string, meetupId: string) {
      const snapshot = await meetups.createMeetupDraft({
        viewer: asAdmin(identityId),
        id: meetupId,
      });
      return { id: snapshot.id, version: snapshot.version };
    },
    /** Правка мимо бота: экран, отрисованный до неё, устаревает. */
    async renameAsAdmin(
      identityId: string,
      meetupId: string,
      title: string,
    ): Promise<void> {
      const viewer = asAdmin(identityId);
      const current = await meetups.getMeetup({ viewer, id: meetupId });
      await meetups.changeMeetupAttributes({
        viewer,
        id: meetupId,
        title,
        description: current.description,
        venue: current.venue,
        kind: current.kind,
        calendarLink: current.calendarLink,
        expectedVersion: current.version,
      });
    },
    /** Снятие с публикации мимо бота: E-03, сходку сняли между списком и нажатием. */
    async unpublishAsAdmin(identityId: string, meetupId: string) {
      const viewer = asAdmin(identityId);
      const current = await meetups.getMeetup({ viewer, id: meetupId });
      await meetups.unpublishMeetup({
        viewer,
        id: meetupId,
        expectedVersion: current.version,
      });
    },
    /**
     * Журнал событий автора, прочитанный из состояния Meetups мимо бота:
     * двойное нажатие и успех снаружи неотличимы, поэтому идемпотентность
     * проверяется здесь, а не по экрану.
     *
     * Таблицы журнала контур наружу не отдаёт, а RPC её не читает. Автор видит
     * все свои сходки, включая скрытые и архивные, без роли администратора.
     * Берём оба viewer-aware списка, читаем снимки через `GetMeetup` и оставляем
     * только сходки автора. `ListMeetupStates` закрыт для всех (ADR-056).
     * Состояние и событие пишутся одной транзакцией
     * (ADR-024), а `meetup_events` держит `UNIQUE (meetup_id, version)` с
     * версиями от 1, поэтому сумма версий сходок автора равна числу его строк
     * в журнале. Число сходок ловит второй объект, которого версия одной
     * сходки не видит. Событие, не поднимающее версию, этот счёт пропустил бы:
     * такого события в модели Meetups сейчас нет.
     */
    async journalOf(authorId: string): Promise<AuthorJournal> {
      const viewer = { identityId: authorId, globalRoles: [] };
      const [current, archived] = await Promise.all([
        meetups.listVisibleMeetups({ viewer }),
        meetups.listArchivedMeetups({ viewer }),
      ]);
      const ids = new Set(
        [...current.meetups, ...archived.meetups].map((meetup) => meetup.id),
      );
      const snapshots = await Promise.all(
        [...ids].map((id) => meetups.getMeetup({ viewer, id })),
      );
      const own = snapshots.filter((meetup) => meetup.author === authorId);
      return {
        // Сортировка даёт сравнимый набор, а не порядок создания: два ключа
        // одной миллисекунды UUIDv7 друг от друга не упорядочивает.
        meetupIds: own.map((meetup) => meetup.id).sort(),
        events: own.reduce((sum, meetup) => sum + Number(meetup.version), 0),
      };
    },
    close(): void {
      identitySessions.abort();
      meetupsSessions.abort();
    },
  };
}

export type AuthorJournal = {
  /** Сходки автора, отсортированные по идентификатору. */
  meetupIds: string[];
  /** Число записей журнала по этим сходкам. */
  events: number;
};

function asAdmin(identityId: string) {
  return { identityId, globalRoles: [GlobalRole.ADMIN] };
}

// DEADLINE_EXCEEDED тоже не ответ: вызов не дождался сервиса, и засчитать его
// готовностью значило бы уронить набор дальше с посторонней причиной.
const unreachableCodes: ReadonlySet<Code> = new Set([
  Code.Unavailable,
  Code.DeadlineExceeded,
]);

async function retryWhileUnreachable(
  service: string,
  url: string,
  deadline: number,
  call: () => Promise<unknown>,
): Promise<void> {
  for (;;) {
    try {
      await call();
      return;
    } catch (cause) {
      const error = ConnectError.from(cause);
      if (!unreachableCodes.has(error.code)) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${service} по ${url} недоступен дольше ${readinessBudgetMs / 1_000} с: ${Code[error.code]}`,
          { cause },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, readinessPauseMs));
    }
  }
}

/**
 * Бот, собранный как в `main.ts`, но с записью вызовов Bot API вместо
 * Telegram. Клиенты сервисов — продакшн-код без подмен: транспорт, заголовки,
 * кодирование Protobuf и отображение кодов отказа выполняются по-настоящему.
 *
 * С `auctionUrl` бот получает и Auction во всех трёх ролях процесса —
 * оболочка сходки, форма лота, пульт — и имя бота аукциона для ссылки
 * человеку с `public` (PER-455). Фото лота бот скачивает у Telegram по пути из
 * `getFile`, которого в проводе нет: оба подменяются здесь, байты выбирает вид
 * фото из `file_id` (`sendsPhoto`).
 */
export function openBotWire(endpoints: {
  identityUrl: string;
  meetupsUrl: string;
  botServiceToken: string;
  auctionUrl?: string;
  auctionBotUsername?: string;
}) {
  // Контур проверяет провод, а не трассировку: спаны здесь не записываются.
  const tracing = noopTracing();
  // Провод играет бота и предъявляет его токен (ADR-056) тем же транспортом,
  // что и процесс: сервисы, которые начнут его проверять, примут провод как бота.
  const serviceToken = endpoints.botServiceToken;
  const identity = createIdentityClient(endpoints.identityUrl, {
    communityTimeZone: contourTimeZone,
    tracing,
    serviceToken,
  });
  const meetups = createMeetupsClient(endpoints.meetupsUrl, {
    communityTimeZone: contourTimeZone,
    tracing,
    serviceToken,
  });
  const calls: RecordedCall[] = [];
  // Логгер принадлежит процессу бота и меняется на рестарте: отказ имён
  // пишется в записи текущего, как это делает `main.ts`.
  let current: ReturnType<typeof createHarness>;
  const auction =
    endpoints.auctionUrl === undefined
      ? undefined
      : createAuctionClient(endpoints.auctionUrl, {
          tracing,
          serviceToken,
          onNamesRefused: (cause, meta) =>
            current.records.push({
              level: "warn",
              message: "auction display names unavailable",
              fields: {
                ...(meta?.requestId === undefined
                  ? {}
                  : { request_id: meta.requestId }),
                error: cause instanceof Error ? cause.message : String(cause),
              },
            }),
        });
  const dispatcher = createDispatcher(
    meetups,
    undefined,
    () => communityDay(new Date(), contourTimeZone),
    auction,
    auction,
    auction === undefined
      ? undefined
      : { auctions: auction, timeZone: contourTimeZone },
  );
  const telegram = fakeTelegram(calls);
  const options: HarnessOptions = {
    communityTimeZone: contourTimeZone,
    files: telegram.files,
    respond: telegram.respond,
    ...(auction === undefined ? {} : { auction }),
    ...(endpoints.auctionBotUsername === undefined
      ? {}
      : { auctionBotUsername: endpoints.auctionBotUsername }),
  };
  const spawn = () =>
    createHarness(
      identity,
      dispatcher,
      calls,
      tracing,
      undefined,
      undefined,
      options,
    );
  current = spawn();
  return {
    // Разговор держит этот вход, а не сам бот: после рестарта он говорит уже
    // с новым процессом, а история чата остаётся прежней.
    bot: {
      handleUpdate: (update: Update) => current.bot.handleUpdate(update),
    },
    calls,
    /**
     * Записи лога текущего процесса бота — вход оракулов исследующего прогона
     * (`explore/`). В отличие от `calls`, рестарт их обнуляет: у нового
     * процесса свой логгер, как и в продакшне.
     */
    get records(): readonly LogRecord[] {
      return current.records;
    },
    /**
     * Рестарт процесса бота: память о висящих вопросах теряется, Meetups и
     * история сообщений у человека остаются.
     */
    restart(): void {
      current = spawn();
    },
    close(): void {
      identity.close();
      meetups.close();
      auction?.close();
    },
  };
}

// Наименьший настоящий JPEG, 1×1: Auction проверяет сигнатуру файла и предел
// размера (ADR-057), заглушка из нулей отказ получила бы и на хорошем пути.
const tinyJpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

/** Байты фото по его виду; `lost` байтов не отдаёт — скачивание отказывает. */
export function photoBytesOf(variant: PhotoVariant): Uint8Array | undefined {
  switch (variant) {
    case "jpeg":
      return new Uint8Array(tinyJpeg);
    case "big": {
      // Сигнатура настоящая, размер — больше предела Auction
      // (`LotImage.MaxBytes`, 1 МБ): отказ должен прийти от сервиса с его
      // числом, а не от проверки формата.
      const bytes = new Uint8Array(2_500_000);
      bytes.set(tinyJpeg.subarray(0, 3));
      return bytes;
    }
    case "broken":
      return new TextEncoder().encode("это не картинка");
    case "lost":
      return undefined;
    default: {
      const _exhaustive: never = variant;
      return _exhaustive;
    }
  }
}

// Блок фото в ответе на rich-сообщение с загрузкой: из него бот берёт
// `file_id` в кэш `lotPhotos`, и второй показ карточки идёт без `GetLotImage`.
// Без блока кэш в проводе не грелся бы, и путь по `file_id` оставался бы
// непройденным. Та же форма, что у харнесса бота аукциона.
const photoBlock = {
  type: "photo",
  photo: [
    { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
    { file_id: "large", file_unique_id: "l", width: 800, height: 800 },
  ],
};

/**
 * Telegram в проводе за пределами ответа `true`: `getFile` отвечает путём по
 * `file_id` фотографии из `sendsPhoto`, скачивание отдаёт байты по виду фото,
 * а rich-сообщение и его правка отвечают сообщением с блоком фото. Чужой
 * `file_id` — отказ Bot API, как у файла, которого Telegram не знает. Номер
 * отправленного сообщения — `100 + порядковый номер вызова`, как у харнесса:
 * `respond` зовётся после записи вызова, и `calls.length` уже его считает.
 */
function fakeTelegram(calls: readonly RecordedCall[]): {
  files: TelegramFiles;
  respond: NonNullable<HarnessOptions["respond"]>;
} {
  return {
    files: {
      async download(path) {
        const variant = photoVariantOf(path.replace(/^photos\//, ""));
        const bytes = variant === undefined ? undefined : photoBytesOf(variant);
        return bytes === undefined
          ? {
              kind: "failed",
              reason: "unavailable",
              cause: new Error("file is not available"),
            }
          : { kind: "ok", bytes };
      },
    },
    respond: (method, payload) => {
      const rich = (payload as { rich_message?: { media?: unknown[] } })
        .rich_message;
      if (rich !== undefined) {
        const edited = (payload as { message_id?: unknown }).message_id;
        const chatId = (payload as { chat_id?: unknown }).chat_id;
        return {
          message_id: typeof edited === "number" ? edited : 100 + calls.length,
          date: 0,
          chat: {
            id: typeof chatId === "number" ? chatId : 42,
            type: "private",
            first_name: "tester",
          },
          rich_message: {
            blocks: rich.media === undefined ? [] : [photoBlock],
          },
        };
      }
      if (method !== "getFile") return undefined;
      const fileId = (payload as { file_id?: unknown }).file_id;
      return typeof fileId === "string" && photoVariantOf(fileId) !== undefined
        ? {
            file_id: fileId,
            file_unique_id: `u-${fileId}`,
            file_path: `photos/${fileId}`,
          }
        : {
            ok: false,
            error_code: 400,
            description: "Bad Request: invalid file_id",
          };
    },
  };
}

/**
 * Свой Telegram id на прогон: в режиме `just contour-up` база живёт дольше
 * одного прогона, и повтор не должен встретить профиль, оставленный прошлым.
 * Диапазон выше настоящих id, чтобы не совпасть с человеком.
 */
export function freshTelegramUserId(): bigint {
  return 7_000_000_000n + BigInt(randomInt(0, 2 ** 31));
}

/** Ник Telegram, свой на каждый id: запись whitelist гасится первым `/start`. */
export function usernameFor(telegramUserId: bigint): string {
  return `contour${telegramUserId}`;
}

/**
 * UUIDv7, которого Meetups ещё не видел: ключ новой сходки или ссылка на
 * несуществующую. Форма та же, что у настоящего ключа, иначе ответ на
 * несуществующую сходку отличался бы разбором, а не видимостью.
 */
export function unusedMeetupId(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Порт, на котором заведомо никто не слушает: Meetups «упал». */
export const unreachableUrl = "http://127.0.0.1:1";
