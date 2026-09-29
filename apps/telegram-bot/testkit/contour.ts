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
import { createDispatcher } from "../src/application/dispatcher.js";
import { communityDay } from "../src/community-time.js";
import { createIdentityClient } from "../src/identity/client.js";
import { createMeetupsClient } from "../src/meetups/client.js";
import { noopTracing } from "../src/tracing.js";
import { createHarness, type LogRecord, type RecordedCall } from "./harness.js";

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
};

const variables = {
  identityUrl: "IDENTITY_GRPC_URL",
  meetupsUrl: "MEETUPS_GRPC_URL",
  maintainerToken: "IDENTITY_MAINTAINER_TOKEN",
} as const;

/**
 * Нет переменной — отказ с её именем, а не пропуск: пропущенный сквозной набор
 * выглядел бы в отчёте как пройденный.
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
  return {
    identityUrl: env[variables.identityUrl] ?? "",
    meetupsUrl: env[variables.meetupsUrl] ?? "",
    maintainerToken: env[variables.maintainerToken] ?? "",
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
  const identity = createClient(
    IdentityService,
    createGrpcTransport({
      baseUrl: environment.identityUrl,
      defaultTimeoutMs: directCallTimeoutMs,
      sessionManager: identitySessions,
    }),
  );
  const meetups = createClient(
    MeetupsService,
    createGrpcTransport({
      baseUrl: environment.meetupsUrl,
      defaultTimeoutMs: directCallTimeoutMs,
      sessionManager: meetupsSessions,
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
        () => identity.checkGlobalRole({}),
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
      const resolved = await identity.resolveIdentity({ telegramUserId });
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
      await identity.addAllowedUsername({
        actor: { identityId: adminId, globalRoles: [GlobalRole.ADMIN] },
        username,
      });
    },
    /** Профиль, который Identity уже завёл для этого Telegram id. */
    async identityOf(telegramUserId: bigint): Promise<string> {
      const resolved = await identity.resolveIdentity({ telegramUserId });
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
     * Таблицы журнала контур наружу не отдаёт, а RPC её не читает. Счёт
     * выводится из служебного `ListMeetupStates`, который отдаёт полные снимки
     * без фильтра видимости: состояние и событие пишутся одной транзакцией
     * (ADR-024), а `meetup_events` держит `UNIQUE (meetup_id, version)` с
     * версиями от 1, поэтому сумма версий сходок автора равна числу его строк
     * в журнале. Число сходок ловит второй объект, которого версия одной
     * сходки не видит. Событие, не поднимающее версию, этот счёт пропустил бы:
     * такого события в модели Meetups сейчас нет.
     */
    async journalOf(authorId: string): Promise<AuthorJournal> {
      const own: { id: string; version: bigint }[] = [];
      let pageToken = "";
      do {
        const page = await meetups.listMeetupStates({
          pageToken,
          pageSize: 100,
        });
        own.push(
          ...page.meetups.filter((meetup) => meetup.author === authorId),
        );
        pageToken = page.nextPageToken;
      } while (pageToken !== "");
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
 */
export function openBotWire(endpoints: {
  identityUrl: string;
  meetupsUrl: string;
}) {
  // Контур проверяет провод, а не трассировку: спаны здесь не записываются.
  const tracing = noopTracing();
  const identity = createIdentityClient(endpoints.identityUrl, { tracing });
  const meetups = createMeetupsClient(endpoints.meetupsUrl, {
    communityTimeZone: contourTimeZone,
    tracing,
  });
  const dispatcher = createDispatcher(meetups, undefined, () =>
    communityDay(new Date(), contourTimeZone),
  );
  const calls: RecordedCall[] = [];
  let current = createHarness(identity, dispatcher, calls);
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
      current = createHarness(identity, dispatcher, calls);
    },
    close(): void {
      identity.close();
      meetups.close();
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
