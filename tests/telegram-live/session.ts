import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MemoryStorage, TelegramClient } from "@mtcute/node";

// Секреты живого контура лежат в user-secrets AppHost рядом с
// `telegram-bot-test-token` (ADR-046, «Граница данных»): второго хранилища
// репозиторий не заводит. Файл — единственная точка входа для Node
// (`just telegram-live-login`), поэтому относительных импортов в нём нет:
// type stripping не переписывает `.js` в `.ts`.

const appHostProject = fileURLToPath(
  new URL("../../infra/apphost/AppHost/AppHost.csproj", import.meta.url),
);

export const secretKeys = {
  apiId: "TelegramLive:ApiId",
  apiHash: "TelegramLive:ApiHash",
  session: "TelegramLive:Session",
  botUsername: "TelegramLive:BotUsername",
} as const;

export type LiveSecrets = {
  apiId: number;
  apiHash: string;
  session: string;
  botUsername: string;
};

export class MissingSecretError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `нет секрета ${key}: dotnet user-secrets --project ` +
        `infra/apphost/AppHost/AppHost.csproj set "${key}" "<значение>"` +
        (key === secretKeys.session
          ? "; строку сессии пишет just telegram-live-login"
          : ""),
    );
    this.name = "MissingSecretError";
    this.key = key;
  }
}

/**
 * Разбирает вывод `dotnet user-secrets list --json`: JSON между маркерами
 * `//BEGIN` и `//END`. Значения в сообщение об ошибке не попадают — в них
 * строка сессии.
 */
export function parseSecretsListing(output: string): Record<string, string> {
  const begin = output.indexOf("//BEGIN");
  const end = output.indexOf("//END");
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      "dotnet user-secrets list --json: нет маркеров //BEGIN и //END",
    );
  }
  const parsed: unknown = JSON.parse(
    output.slice(begin + "//BEGIN".length, end),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("dotnet user-secrets list --json: ожидался объект");
  }
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      secrets[key] = value;
    }
  }
  return secrets;
}

/** Выбирает секреты контура и называет первый отсутствующий. */
export function pickLiveSecrets(store: Record<string, string>): LiveSecrets {
  const read = (key: string): string => {
    const value = store[key];
    if (value === undefined || value === "") {
      throw new MissingSecretError(key);
    }
    return value;
  };
  const rawApiId = read(secretKeys.apiId);
  const apiId = Number(rawApiId);
  if (!Number.isSafeInteger(apiId) || apiId <= 0) {
    throw new Error(
      `секрет ${secretKeys.apiId} — не целое положительное число`,
    );
  }
  return {
    apiId,
    apiHash: read(secretKeys.apiHash),
    session: read(secretKeys.session),
    botUsername: read(secretKeys.botUsername).replace(/^@/, ""),
  };
}

function dotnetUserSecrets(args: string[], input?: string): string {
  const result = spawnSync(
    "dotnet",
    ["user-secrets", ...args, "--project", appHostProject],
    { encoding: "utf8", input },
  );
  if (result.error !== undefined) {
    throw new Error(
      `dotnet user-secrets не запустился: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    // stdout не печатается: у `list` в нём секреты.
    throw new Error(
      `dotnet user-secrets ${args[0]} вернул код ${result.status}`,
    );
  }
  return result.stdout;
}

export function readSecretStore(): Record<string, string> {
  return parseSecretsListing(dotnetUserSecrets(["list", "--json"]));
}

function writeSecret(key: string, value: string): void {
  // `set` без аргументов читает JSON из stdin: значение не попадает в argv,
  // а значит, и в список процессов.
  dotnetUserSecrets(["set"], JSON.stringify({ [key]: value }));
}

/**
 * Код подтверждения синтетического номера `99966XYYYY` — цифра дата-центра X,
 * повторённая пять раз (https://core.telegram.org/api/auth).
 */
export function syntheticLoginCode(phone: string): string {
  const match = /^99966(\d)\d{4}$/.exec(phone);
  if (match?.[1] === undefined) {
    throw new Error(
      "номер тестовой среды имеет вид 99966XYYYY, где X — цифра дата-центра",
    );
  }
  return match[1].repeat(5);
}

async function login(phone: string): Promise<void> {
  const code = syntheticLoginCode(phone);
  const store = readSecretStore();
  const apiId = Number(store[secretKeys.apiId]);
  const apiHash = store[secretKeys.apiHash];
  if (!Number.isSafeInteger(apiId) || apiId <= 0) {
    throw new MissingSecretError(secretKeys.apiId);
  }
  if (apiHash === undefined || apiHash === "") {
    throw new MissingSecretError(secretKeys.apiHash);
  }
  const client = new TelegramClient({
    apiId,
    apiHash,
    testMode: true,
    storage: new MemoryStorage(),
  });
  try {
    const user = await client.start({
      phone,
      code,
      codeSentCallback: () => {},
    });
    writeSecret(secretKeys.session, await client.exportSession());
    console.log(
      `telegram-live: сессия аккаунта ${user.id} записана в ${secretKeys.session}`,
    );
  } finally {
    await client.destroy();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, phone] = process.argv.slice(2);
  if (command !== "login" || phone === undefined) {
    console.error("использование: session.ts login <99966XYYYY>");
    process.exit(2);
  }
  login(phone).catch((error: unknown) => {
    console.error(
      `telegram-live: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
