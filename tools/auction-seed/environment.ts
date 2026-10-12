// Переменные наполнения. Умолчаний нет ни у одной: адрес или токен по
// умолчанию привёл бы наполнение не в ту среду. Имена адресов и токена — те,
// что отдаёт Contour.Host с `--with-auction`, поэтому против контура команда
// идёт без переименований; на stage их значения задаёт владелец из файла
// секретов хоста, а туннель до сервисов — ops-репозиторий (ADR-055).

export type SeedEnvironment = {
  catalogPath: string;
  identityUrl: string;
  meetupsUrl: string;
  auctionUrl: string;
  serviceToken: string;
  administratorTelegramUserId: bigint;
  communityTimeZone: string;
};

const variables = {
  catalogPath: "AUCTION_SEED_CATALOG",
  identityUrl: "IDENTITY_GRPC_URL",
  meetupsUrl: "MEETUPS_GRPC_URL",
  auctionUrl: "AUCTION_GRPC_URL",
  // Токен вызывающего бота хаба (ADR-056): Auction открывает команды каталога
  // только ему, бот аукциона их не получает.
  serviceToken: "HUB_BOT_SERVICE_TOKEN",
  administratorTelegramUserId: "AUCTION_SEED_ADMIN_TELEGRAM_ID",
  // Пояс, в котором записана дата сходки в каталоге: тот же, что у бота.
  communityTimeZone: "BOT_COMMUNITY_TIME_ZONE",
} as const;

export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentError";
  }
}

export function readSeedEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): SeedEnvironment {
  const missing = Object.values(variables).filter(
    (name) => (env[name] ?? "") === "",
  );
  if (missing.length > 0) {
    throw new EnvironmentError(
      `не заданы переменные: ${missing.join(", ")} — наполнение не начато`,
    );
  }
  const value = (name: string) => env[name] ?? "";
  const rawTelegramId = value(variables.administratorTelegramUserId);
  if (!/^[1-9]\d*$/.test(rawTelegramId)) {
    throw new EnvironmentError(
      `${variables.administratorTelegramUserId}: нужен числовой Telegram id администратора`,
    );
  }
  const communityTimeZone = value(variables.communityTimeZone);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: communityTimeZone });
  } catch {
    throw new EnvironmentError(
      `${variables.communityTimeZone}: нужен IANA-пояс, например Europe/Moscow`,
    );
  }
  return {
    catalogPath: value(variables.catalogPath),
    identityUrl: value(variables.identityUrl),
    meetupsUrl: value(variables.meetupsUrl),
    auctionUrl: value(variables.auctionUrl),
    serviceToken: value(variables.serviceToken),
    administratorTelegramUserId: BigInt(rawTelegramId),
    communityTimeZone,
  };
}
