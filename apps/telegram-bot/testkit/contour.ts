import { randomInt } from "node:crypto";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import { IdentityService } from "../gen/identity/v1/identity_service_pb.js";
import { GlobalRole } from "../gen/identity/v1/roles_pb.js";
import { MeetupVisibility } from "../gen/meetups/v1/meetups_pb.js";
import { MeetupsService } from "../gen/meetups/v1/meetups_service_pb.js";
import { createDispatcher } from "../src/application/dispatcher.js";
import { communityDay } from "../src/community-time.js";
import { createIdentityClient } from "../src/identity/client.js";
import { createMeetupsClient } from "../src/meetups/client.js";
import { createHarness } from "./harness.js";

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
      try {
        await identity.grantAdminRole(
          { identityId: resolved.identityId },
          {
            headers: {
              authorization: `Bearer ${environment.maintainerToken}`,
            },
          },
        );
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
      return resolved.identityId;
    },
    async readAsAdmin(identityId: string, meetupId: string) {
      const snapshot = await meetups.getMeetup({
        viewer: { identityId, globalRoles: [GlobalRole.ADMIN] },
        id: meetupId,
      });
      return {
        title: snapshot.title,
        venue: snapshot.venue,
        description: snapshot.description,
        visible: snapshot.visibility === MeetupVisibility.VISIBLE,
      };
    },
    close(): void {
      identitySessions.abort();
      meetupsSessions.abort();
    },
  };
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
  const identity = createIdentityClient(endpoints.identityUrl);
  const meetups = createMeetupsClient(endpoints.meetupsUrl, contourTimeZone);
  const dispatcher = createDispatcher(meetups, undefined, () =>
    communityDay(new Date(), contourTimeZone),
  );
  const harness = createHarness(identity, dispatcher);
  return {
    ...harness,
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

/** Порт, на котором заведомо никто не слушает: Meetups «упал». */
export const unreachableUrl = "http://127.0.0.1:1";
