import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MemoryStorage, TelegramClient } from "@mtcute/node";

// Секреты живого контура лежат в user-secrets AppHost рядом с
// `hub-bot-test-token` (ADR-046, «Граница данных»): второго хранилища
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
  publishedMeetup: "TelegramLive:PublishedMeetup",
  hiddenMeetup: "TelegramLive:HiddenMeetup",
} as const;

export type LiveSecrets = {
  apiId: number;
  apiHash: string;
  session: string;
  botUsername: string;
};

export type SecretProblem = "missing" | "invalid";

const secretProblems: Record<SecretProblem, string> = {
  missing: "нет секрета",
  invalid: "неверный секрет",
};

export class SecretError extends Error {
  readonly key: string;
  readonly problem: SecretProblem;

  constructor(key: string, problem: SecretProblem) {
    super(
      `${secretProblems[problem]} ${key}: dotnet user-secrets --project ` +
        `infra/apphost/AppHost/AppHost.csproj set "${key}" "<значение>"` +
        (key === secretKeys.session
          ? "; строку сессии пишет just telegram-live-login"
          : ""),
    );
    this.name = "SecretError";
    this.key = key;
    this.problem = problem;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(begin + "//BEGIN".length, end));
  } catch {
    // Сообщение SyntaxError цитирует разбираемый текст, а в нём секреты.
    throw new Error("dotnet user-secrets list --json: JSON не разбирается");
  }
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

function readSecret(store: Record<string, string>, key: string): string {
  const value = store[key];
  if (value === undefined || value === "") {
    throw new SecretError(key, "missing");
  }
  return value;
}

/** Пара приложения с my.telegram.org — общая у прогона и входа. */
export function pickApiCredentials(store: Record<string, string>): {
  apiId: number;
  apiHash: string;
} {
  const apiId = Number(readSecret(store, secretKeys.apiId));
  if (!Number.isSafeInteger(apiId) || apiId <= 0) {
    throw new SecretError(secretKeys.apiId, "invalid");
  }
  return { apiId, apiHash: readSecret(store, secretKeys.apiHash) };
}

/** Выбирает секреты контура и называет первый отсутствующий. */
export function pickLiveSecrets(store: Record<string, string>): LiveSecrets {
  return {
    ...pickApiCredentials(store),
    session: readSecret(store, secretKeys.session),
    botUsername: readSecret(store, secretKeys.botUsername).replace(/^@/, ""),
  };
}

export type MeetupPayloads = {
  published: string;
  hidden: string;
};

// Та же форма, что у регулярки бота
// (apps/hub-bot/src/presentation/schemas.ts): payload другой формы бот
// молча принимает за чистый `/start`, и отрицательный путь зеленел бы, не
// дойдя до Meetups.
const meetupPayload = /(?:^|\?start=)(m_[A-Za-z0-9_-]{22})$/;

function pickMeetupPayload(store: Record<string, string>, key: string): string {
  const payload = meetupPayload.exec(readSecret(store, key).trim())?.[1];
  if (payload === undefined) {
    throw new SecretError(key, "invalid");
  }
  return payload;
}

/**
 * Сходки кадра E-03 заводит владелец (local-development.md): значение —
 * «Ссылка для чата» из ответа бота на публикацию или payload `m_…` из неё.
 */
export function pickMeetupPayloads(
  store: Record<string, string>,
): MeetupPayloads {
  return {
    published: pickMeetupPayload(store, secretKeys.publishedMeetup),
    hidden: pickMeetupPayload(store, secretKeys.hiddenMeetup),
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
  const { apiId, apiHash } = pickApiCredentials(readSecretStore());
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

// Сравнение по realpath: дерево за junction или иной регистр диска дали бы
// разные строки, и вход молча завершился бы с кодом 0, не записав сессию.
function isEntryPoint(): boolean {
  const script = process.argv[1];
  return (
    script !== undefined &&
    realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
  );
}

if (isEntryPoint()) {
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
