// Язык пульта: одна строка — одно действие. Разбор отделён от исполнения,
// чтобы его держали L0-тесты без контура (`commands.test.ts`).
//
// У человека два чата — с ботом хаба и с ботом аукциона, — и действие всегда
// называет бота через собаку: `alice@hub say …`, `alice@auction press …`.
// Умолчания нет: нажать не в том боте молча нельзя.
//
//   new <имя> admin|member|guest     завести человека
//   <имя>@<бот> say <текст>          написать боту; висит вопрос формы — ответ на него
//   <имя>@<бот> answer <n> <текст>   ответить на n-й вопрос бота в чате
//   <имя>@<бот> press <подпись>      нажать кнопку по подписи
//   <имя>@<бот> pick <n> <подпись>   нажать n-ю из одинаковых кнопок экрана (списки одного дня)
//   <имя>@<бот> old <подпись>        нажать кнопку так, будто экран нарисован прошлым релизом
//   <имя>@<бот> raw <callback_data>  нажать на последнем экране кнопку с этими данными, которой бот не рисовал
//   <имя>@<бот> link <uuid сходки>   открыть ссылку на сходку из чата сообщества
//   <имя>@<бот> forward <канал> <пост>  переслать боту пост публичного канала
//   <имя>@<бот> document <имя файла> отправить боту документ
//   <имя>@<бот> photo [вид]          отправить боту фотографию: jpeg (по умолчанию), big, broken, lost
//   <имя>@<бот> look                 показать экраны чата, ничего не делая
//   people                           кто заведён
//   restart <бот>                    рестарт процесса бота: память о вопросах теряется
//   slow <сервис> <мс>               задержать запросы ботов к identity, meetups или auction; 0 снимает
//   down <сервис> | up <сервис>      оборвать соединения с сервисом и вернуть их
//   help                             эта справка
//   quit                             остановить пульт; контур снимет Contour.Host

export const roles = ["admin", "member", "guest"] as const;
export type Role = (typeof roles)[number];

export const bots = ["hub", "auction"] as const;
export type BotName = (typeof bots)[number];

export const slowServices = ["identity", "meetups", "auction"] as const;
export type SlowService = (typeof slowServices)[number];

// Виды фото повторяют `photoVariants` test kit пакета ботов; копия здесь держит разбор
// без импорта kit, а расхождение ловит L0-тест языка.
export const photoKinds = ["jpeg", "big", "broken", "lost"] as const;
export type PhotoKind = (typeof photoKinds)[number];

// Дольше минуты ждать нечего: дедлайн RPC у бота — секунды, и задержка выше
// него уже неотличима от сервиса, который не отвечает вовсе.
export const maxDelayMs = 60_000;

export type Command =
  | { kind: "new"; who: string; role: Role }
  | { kind: "say"; who: string; bot: BotName; text: string }
  | { kind: "answer"; who: string; bot: BotName; number: number; text: string }
  | { kind: "press"; who: string; bot: BotName; label: string }
  | {
      kind: "pick";
      who: string;
      bot: BotName;
      label: string;
      occurrence: number;
    }
  | { kind: "old"; who: string; bot: BotName; label: string }
  | { kind: "raw"; who: string; bot: BotName; data: string }
  | { kind: "link"; who: string; bot: BotName; meetupId: string }
  | {
      kind: "forward";
      who: string;
      bot: BotName;
      channel: string;
      postId: number;
    }
  | { kind: "document"; who: string; bot: BotName; fileName: string }
  | { kind: "photo"; who: string; bot: BotName; photo: PhotoKind }
  | { kind: "look"; who: string; bot: BotName }
  | { kind: "people" }
  | { kind: "restart"; bot: BotName }
  | { kind: "slow"; service: SlowService; delayMs: number }
  | { kind: "down"; service: SlowService }
  | { kind: "up"; service: SlowService }
  | { kind: "help" }
  | { kind: "quit" };

export const help = [
  "new <имя> admin|member|guest     завести человека (member — ник в whitelist первого admin)",
  "<имя>@hub|auction say <текст>    написать боту, например: alice@hub say /start",
  "<имя>@<бот> answer <n> <текст>   ответить на n-й вопрос бота в чате",
  "<имя>@<бот> press <подпись>      нажать кнопку по подписи",
  "<имя>@<бот> pick <n> <подпись>   нажать n-ю из одинаковых кнопок экрана: bob@auction pick 2 6 октября, вт · идут ставки · 1 лот",
  "<имя>@<бот> old <подпись>        нажать кнопку экрана, нарисованного прошлым релизом бота",
  "<имя>@<бот> raw <callback_data>  нажать на последнем экране кнопку с чужими данными: bob@auction raw v1:lot:new:abc",
  "<имя>@<бот> link <uuid>          открыть ссылку на сходку из чата сообщества",
  "<имя>@<бот> forward <канал> <пост>  переслать боту пост публичного канала: alice@hub forward solguficky 77",
  "<имя>@<бот> document <имя файла> отправить боту документ",
  "<имя>@<бот> photo [jpeg|big|broken|lost]  отправить боту фотографию; без вида — настоящий jpeg",
  "<имя>@<бот> look                 экраны чата без действия",
  "people                           кто заведён",
  "restart hub|auction              рестарт процесса бота",
  "slow <сервис> <мс>               задержать запросы ботов к identity, meetups или auction; 0 снимает задержку",
  "down <сервис> | up <сервис>      оборвать соединения с сервисом и вернуть их",
  "quit                             остановить пульт",
];

const globalWords = new Set([
  "new",
  "people",
  "restart",
  "slow",
  "down",
  "up",
  "help",
  "quit",
]);
const channelPattern = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const namePattern = /^[a-z][a-z0-9_-]{0,31}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CommandError extends Error {}

/**
 * Хвост после действия берётся как есть, без кавычек: подпись кнопки и текст
 * человека несут пробелы, эмодзи и знаки препинания, и экранирование заставило
 * бы агента угадывать правила оболочки дважды.
 */
export function parseCommand(line: string): Command {
  const trimmed = line.replace(/\r?\n$/, "").trim();
  if (trimmed === "") {
    throw new CommandError("пустая команда; help — справка");
  }
  const [head = "", rest] = splitWord(trimmed);

  switch (head) {
    case "people":
    case "help":
    case "quit":
      if (rest !== "") {
        throw new CommandError(`${head} не принимает аргументов`);
      }
      return { kind: head };
    case "restart": {
      const [bot, tail] = splitWord(rest);
      if (tail !== "") {
        throw new CommandError("restart принимает только имя бота");
      }
      return { kind: "restart", bot: checkBot(bot) };
    }
    case "new": {
      const [who, role] = splitWord(rest);
      checkName(who);
      if (!isRole(role)) {
        throw new CommandError(
          `роль «${role}» неизвестна; допустимы ${roles.join(", ")}`,
        );
      }
      return { kind: "new", who, role };
    }
    case "slow": {
      const [service, delay] = splitWord(rest);
      if (!/^\d+$/.test(delay) || Number(delay) > maxDelayMs) {
        throw new CommandError(
          `задержка «${delay}» — не целое число миллисекунд от 0 до ${maxDelayMs}`,
        );
      }
      return {
        kind: "slow",
        service: checkService(service),
        delayMs: Number(delay),
      };
    }
    case "down":
    case "up": {
      const [service, tail] = splitWord(rest);
      if (tail !== "") {
        throw new CommandError(`${head} принимает только имя сервиса`);
      }
      return { kind: head, service: checkService(service) };
    }
  }

  const { who, bot } = parseAddress(head);
  const [action, tail] = splitWord(rest);
  switch (action) {
    case "say":
      return { kind: "say", who, bot, text: nonEmpty(tail, "текст") };
    case "press":
      return {
        kind: "press",
        who,
        bot,
        label: nonEmpty(tail, "подпись кнопки"),
      };
    case "pick": {
      const [number, label] = splitWord(tail);
      if (!/^[1-9]\d*$/.test(number)) {
        throw new CommandError(`номер кнопки «${number}» — не целое от 1`);
      }
      return {
        kind: "pick",
        who,
        bot,
        label: nonEmpty(label, "подпись кнопки"),
        occurrence: Number(number),
      };
    }
    case "old":
      return { kind: "old", who, bot, label: nonEmpty(tail, "подпись кнопки") };
    case "raw":
      if (Buffer.byteLength(tail) > 64) {
        throw new CommandError(
          "callback_data длиннее 64 байт Telegram не примет",
        );
      }
      return { kind: "raw", who, bot, data: nonEmpty(tail, "callback_data") };
    case "answer": {
      const [number, text] = splitWord(tail);
      if (!/^[1-9]\d*$/.test(number)) {
        throw new CommandError(`номер вопроса «${number}» — не целое от 1`);
      }
      return {
        kind: "answer",
        who,
        bot,
        number: Number(number),
        text: nonEmpty(text, "текст"),
      };
    }
    case "link":
      if (!uuidPattern.test(tail)) {
        throw new CommandError(`«${tail}» — не UUID сходки`);
      }
      return { kind: "link", who, bot, meetupId: tail.toLowerCase() };
    case "forward": {
      const [channel, post] = splitWord(tail);
      if (!channelPattern.test(channel)) {
        throw new CommandError(
          `«${channel}» — не ник канала: латиница, цифры и _, от 4 знаков, без @`,
        );
      }
      // Номер уезжает в ссылку на пост числом: за пределом точных целых он
      // округлился бы до соседнего поста.
      if (!/^[1-9]\d*$/.test(post) || !Number.isSafeInteger(Number(post))) {
        throw new CommandError(`номер поста «${post}» — не целое от 1`);
      }
      return { kind: "forward", who, bot, channel, postId: Number(post) };
    }
    case "document":
      return {
        kind: "document",
        who,
        bot,
        fileName: nonEmpty(tail, "имя файла"),
      };
    case "photo": {
      const [photo, extra] = splitWord(tail);
      if (extra !== "") {
        throw new CommandError("photo принимает только вид фото");
      }
      if (photo === "") return { kind: "photo", who, bot, photo: "jpeg" };
      if (!isPhotoKind(photo)) {
        throw new CommandError(
          `вид фото «${photo}» неизвестен; допустимы ${photoKinds.join(", ")}`,
        );
      }
      return { kind: "photo", who, bot, photo };
    }
    case "look":
      if (tail !== "") {
        throw new CommandError("look не принимает аргументов");
      }
      return { kind: "look", who, bot };
    default:
      throw new CommandError(
        `действие «${action}» неизвестно; допустимы say, answer, press, pick, old, raw, link, forward, document, photo, look`,
      );
  }
}

/** `alice@hub` — человек и бот, с которым он говорит; без бота — отказ. */
function parseAddress(head: string): { who: string; bot: BotName } {
  const at = head.indexOf("@");
  if (at < 0) {
    checkName(head);
    throw new CommandError(
      `у «${head}» не назван бот: ${head}@hub или ${head}@auction`,
    );
  }
  const who = head.slice(0, at);
  checkName(who);
  return { who, bot: checkBot(head.slice(at + 1)) };
}

function splitWord(text: string): [string, string] {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(text);
  return [match?.[1] ?? "", match?.[2] ?? ""];
}

function checkName(who: string): void {
  if (!namePattern.test(who) || globalWords.has(who)) {
    throw new CommandError(
      `«${who}» не годится в имя: латиница в нижнем регистре, цифры, _ и -, не служебное слово`,
    );
  }
}

function checkBot(value: string): BotName {
  if (!(bots as readonly string[]).includes(value)) {
    throw new CommandError(
      `бот «${value}» неизвестен; допустимы ${bots.join(", ")}`,
    );
  }
  return value as BotName;
}

function checkService(value: string): SlowService {
  if (!(slowServices as readonly string[]).includes(value)) {
    throw new CommandError(
      `сервис «${value}» неизвестен; допустимы ${slowServices.join(", ")}`,
    );
  }
  return value as SlowService;
}

function isRole(value: string): value is Role {
  return (roles as readonly string[]).includes(value);
}

function isPhotoKind(value: string): value is PhotoKind {
  return (photoKinds as readonly string[]).includes(value);
}

function nonEmpty(value: string, what: string): string {
  if (value === "") {
    throw new CommandError(`не хватает: ${what}`);
  }
  return value;
}
