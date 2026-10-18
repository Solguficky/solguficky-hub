import { truncate } from "../../core/format.js";

// Тексты бота поддержки — дизайн-код, «Бот поддержки» (ADR-068; PER-551).
// У человека — переписка: приветствие и ответы только на сбой, без клавиатур.
// У операторов — тема с карточкой и отказы доставки ответом в теме.

/** `/start`: первое предложение жирным в строке с остальным, как у кадра входа. */
export const welcomeText =
  "<b>Это поддержка сообщества солегуфиков.</b> Напиши сюда вопрос, ошибку в боте или идею — прочитают и ответят люди из организаторов. Ответ придёт в этот чат.";

/** Кадр блокировки — как у двух других ботов: одна жирная фраза без клавиатуры. */
export const blockedText = "<b>Доступ к поддержке закрыт.</b>";

export const notDeliveredText =
  "Сообщение не дошло до поддержки. Попробуй ещё раз чуть позже.";

export const notCopyableText =
  "Такое сообщение не передать. Пришли текстом, фото или файлом.";

export const rateLimitText =
  "Слишком много сообщений подряд. Подожди минуту и напиши снова.";

/** Отказы доставки ответа оператора — ответом бота в теме. */
export const operatorRefusals = {
  stopped: "Не доставлено: человек остановил бота.",
  rejected: "Не доставлено: Telegram отказал.",
  unpaired: "Не доставлено: тема не связана с человеком.",
  // Хранилище пар недоступно: кому отвечать, бот не знает, а сбой временный.
  unavailable: "Не доставлено: попробуй ещё раз чуть позже.",
} as const;

/** Откуда человек пришёл: метка `?start=` бота, который дал ссылку. */
export type Source = "hub" | "auction";

/**
 * Круг в карточке темы. `none` — Identity ответил, а круга нет: человек не
 * допущен; `unknown` — Identity не ответил (ADR-068, п. 3).
 */
export type CardCircle = "member" | "guest" | "none" | "unknown";

const circleWords: Record<CardCircle, string> = {
  member: "участник",
  guest: "гость",
  none: "без доступа",
  unknown: "неизвестен",
};

const sourceWords: Record<Source, string> = {
  hub: "бот хаба",
  auction: "бот аукциона",
};

export type Person = {
  firstName: string;
  lastName?: string;
  username?: string;
};

function displayName(person: Person): string {
  return person.lastName === undefined || person.lastName === ""
    ? person.firstName
    : `${person.firstName} ${person.lastName}`;
}

// Шапка темы и первая строка карточки: «Имя · @ник», без ника — «Имя».
function heading(person: Person): string {
  return person.username === undefined
    ? displayName(person)
    : `${displayName(person)} · @${person.username}`;
}

// Предел имени темы в Bot API — 128 символов.
const topicNameLimit = 128;

export function topicName(person: Person): string {
  return truncate(heading(person), topicNameLimit);
}

/**
 * Карточка темы — снимок на момент её заведения: имя и ник, круг, откуда
 * пришёл и дата в поясе сообщества. Telegram id в группу не выносится.
 * Простой текст без разметки: имя человека — недоверенный ввод.
 */
export function cardText(input: {
  person: Person;
  circle: CardCircle;
  source: Source | undefined;
  at: Date;
  timeZone: string;
}): string {
  const date = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: input.timeZone,
  }).format(input.at);
  return [
    heading(input.person),
    `Круг: ${circleWords[input.circle]}`,
    `Откуда: ${input.source === undefined ? "неизвестно" : sourceWords[input.source]}`,
    date,
  ].join("\n");
}
