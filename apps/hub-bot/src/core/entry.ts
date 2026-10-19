// Вход в бот, общий у двух поверхностей (PER-592; дополнения ADR-060 и
// ADR-064 от 2026-10-12). `/start` заявку не ставит: он разрешает личность, и
// человеку без права поверхности приходит приветствие с кнопкой «Подать
// заявку» — заявку ставит только она. Тексты приветствия у ботов свои, а
// подпись кнопки, строка о том, кто даёт допуск, и подсказка на сообщение вне
// вопроса — одни.

/** Кнопка приветствия: единственное действие, которое ставит заявку. */
export const applyLabel = "Подать заявку";

/** Кто рассматривает заявку: строка приветствия и кадра ожидания. */
export const admittersLine = "Доступ выдаёт администратор или мейнтейнер.";

/** Вход в бот поддержки: ряд «Помощи» и кнопка кадра ожидания (ADR-068). */
export const supportLabel = "Написать в поддержку ↗";

/**
 * Ссылка в бот поддержки с меткой поверхности (ADR-068, п. 2): по ней бот
 * поддержки помнит, откуда пришёл человек, пока тот не написал первое
 * сообщение.
 */
export function supportBotLink(
  botUsername: string,
  source: "hub" | "auction",
): string {
  return `https://t.me/${botUsername}?start=${source}`;
}

// Имя бота без «@»: 5–32 символа, латиница, цифры и «_», в конце «bot».
// Telegram требует того же при создании бота. Общее у обеих поверхностей:
// имя бота аукциона проверяет хаб, имя бота поддержки — оба.
export function isTelegramBotUsername(value: string): boolean {
  return telegramBotUsernamePattern.test(value);
}

const telegramBotUsernamePattern = /^[A-Za-z][A-Za-z0-9_]{1,28}bot$/i;

/** Заголовок и имя возврата корневого меню — общего родителя разделов. */
export const menuTitle = "Меню";

/**
 * Код канала прихода едет в кнопке «Подать заявку» после префикса её данных,
 * пока данные укладываются в 64 байта `callback_data`. Длиннее — кнопка
 * несёт только префикс, и заявка уходит без канала: вход дороже атрибуции.
 */
export function withSourceCode(
  prefix: string,
  sourceCode: string | undefined,
): string {
  if (sourceCode === undefined) return prefix;
  const data = `${prefix}:${sourceCode}`;
  return Buffer.byteLength(data, "utf8") <= 64 ? data : prefix;
}

// Поля сообщения, которые несут то, что человек прислал сам. Служебные
// сообщения — закрепление, таймер автоудаления, смена фото чата — их не несут
// и подсказки не получают: человек ничего боту не писал.
const personContent = [
  "text",
  "caption",
  "photo",
  "document",
  "video",
  "animation",
  "audio",
  "voice",
  "video_note",
  "sticker",
  "contact",
  "location",
  "venue",
  "poll",
  "dice",
] as const;

/** Прислал ли человек содержимое, а не служебное событие чата. */
export function carriesPersonContent(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    personContent.some((field) => field in message)
  );
}

/**
 * Память альбомов, на которые подсказка уже ушла: альбом приходит отдельным
 * сообщением на каждый снимок, а подсказка нужна одна. Память ограничена
 * `limit` альбомами: самый давний вытесняется.
 */
export function createHintedAlbums(limit = 1_000): {
  first(group: string): boolean;
} {
  const hinted = new Set<string>();
  return {
    first(group) {
      if (hinted.has(group)) return false;
      hinted.add(group);
      if (hinted.size > limit) {
        const [oldest] = hinted;
        if (oldest !== undefined) hinted.delete(oldest);
      }
      return true;
    },
  };
}

/**
 * Подсказка на сообщение, которое бот не может прочитать: текст без ответа на
 * вопрос, незнакомая команда, файл вне вопроса (PER-592). Без неё бот молчал,
 * а ответ, у которого клиент потерял реплай, пропадал. Есть открытый вопрос —
 * подсказка говорит, как на него ответить; нет — куда идти. Первое
 * предложение — жирное, как у кадра отказа.
 */
export function strayHintText(openQuestion: boolean): {
  lead: string;
  rest: string;
} {
  return openQuestion
    ? {
        lead: "Ответ не дошёл до вопроса.",
        rest: "Нажми на вопрос бота, выбери «Ответить» и пришли ответ ещё раз.",
      }
    : {
        lead: "Я отвечаю на кнопки и команды.",
        rest: "Разделы — в меню ниже и в кнопке меню рядом с полем ввода.",
      };
}
