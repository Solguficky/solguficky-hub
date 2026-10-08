import type { Update } from "grammy/types";
import { createClients } from "../../src/surfaces/auction/clients.js";
import type { Presentation } from "../../src/surfaces/auction/config.js";
import { createHarness, type LogRecord, type RecordedCall } from "./harness.js";

// Провод бота аукциона против настоящих Identity и Auction (уровень L2). Среду
// поднимает Contour.Host с флагом `--with-auction` (`just contour-bot-console`),
// а этот модуль ею не владеет: он читает адреса из окружения и закрывает
// только свои gRPC-сессии. Переменные — адреса и токен вызывающего бота
// аукциона, которые отдаёт контур, и ни одной переменной бота хаба.

export type AuctionContourEnvironment = {
  identityUrl: string;
  auctionUrl: string;
  /** Токен вызывающего Auction Bot (ADR-056): провод играет бота. */
  serviceToken: string;
};

const variables = {
  identityUrl: "IDENTITY_GRPC_URL",
  auctionUrl: "AUCTION_GRPC_URL",
  serviceToken: "AUCTION_BOT_SERVICE_TOKEN",
} as const;

/**
 * Нет переменной — отказ с её именем, а не пропуск. Контур без Auction
 * (`Contour.Host` без `--with-auction`) не отдаёт ни адреса, ни токена, и
 * отказ называет флаг, а не выглядит дефектом бота.
 */
export function readAuctionContourEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AuctionContourEnvironment {
  const missing = Object.values(variables).filter(
    (name) => env[name] === undefined || env[name] === "",
  );
  if (missing.length > 0) {
    throw new Error(
      `контур не передал ${missing.join(", ")}: Auction поднимается флагом ` +
        "`--with-auction` у Contour.Host (`just contour-bot-console`)",
    );
  }
  return {
    identityUrl: env[variables.identityUrl] ?? "",
    auctionUrl: env[variables.auctionUrl] ?? "",
    serviceToken: env[variables.serviceToken] ?? "",
  };
}

/**
 * Бот, собранный как в `main.ts`, но с записью вызовов Bot API вместо Telegram
 * и без потребителя уведомлений из шины: Notifications в контуре нет. Клиенты
 * сервисов — продакшн-код без подмен: транспорт, токен вызывающего, бюджет
 * действия и отображение кодов отказа выполняются по-настоящему.
 */
export function openAuctionBotWire(
  environment: AuctionContourEnvironment,
  options: { presentation?: Presentation; timeZone?: string } = {},
) {
  const calls: RecordedCall[] = [];
  // Логгер принадлежит процессу бота и меняется на рестарте; отказ имён
  // пишется в текущий, как это делает `main.ts`.
  let current: ReturnType<typeof createHarness>;
  const clients = createClients({
    identityUrl: environment.identityUrl,
    auctionUrl: environment.auctionUrl,
    serviceToken: environment.serviceToken,
    onNamesRefused: (cause, requestId) =>
      current.logger.warn("display names unavailable", {
        request_id: requestId,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  current = createHarness(clients.ports, calls, options);
  return {
    // Разговор держит этот вход, а не сам бот: после рестарта он говорит уже
    // с новым процессом, а история чата остаётся прежней.
    bot: {
      handleUpdate: (update: Update) => current.bot.handleUpdate(update),
    },
    calls,
    /** Записи лога текущего процесса бота; рестарт их обнуляет, как в продакшне. */
    get records(): readonly LogRecord[] {
      return current.records;
    },
    /**
     * Рестарт процесса бота: память об открытых вопросах и кэш `file_id`
     * теряются, Auction и история сообщений у человека остаются.
     */
    restart(): void {
      current = createHarness(clients.ports, calls, options);
    },
    close(): void {
      clients.close();
    },
  };
}
