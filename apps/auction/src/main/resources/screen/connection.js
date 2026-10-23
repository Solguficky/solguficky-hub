// Логика подключения экрана зала без DOM, таймеров и сети: разбор SSE, переходы состояния и пауза повтора.
// Таблица «Потеря актуальности» ADR-040 живёт здесь, а `screen.js` только исполняет её по событиям сети.

/** Схема `data`, которую страница умеет рисовать (поле `schema`, integration.md, «Экран зала»). */
export const SCHEMA = 1;

/**
 * Разбор потока по кускам: кусок сети режет кадр где угодно, в том числе посреди строки. Сервер пишет `\n`, а не
 * `\r\n`, поэтому граница кадра — пустая строка `\n\n`. Комментарий `: heartbeat` кадром события не считается.
 */
export function createSseParser() {
  let buffer = "";
  return {
    push(text) {
      buffer += text;
      const events = [];
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const event = parseFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event !== null) events.push(event);
      }
      return events;
    },
  };
}

function parseFrame(frame) {
  let name = "message";
  const data = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  }
  return data.length === 0 ? null : { event: name, data: data.join("\n") };
}

/**
 * Состояние страницы: `status` — `connecting` (снимка не было), `live`, `stale` (снимок был, связь потеряна) или
 * `missing` (аукцион не найден); `view` — последний принятый снимок или `null`.
 */
export const initial = Object.freeze({ status: "connecting", view: null });

/**
 * Пришёл снимок: он заменяет представление целиком и снимает предупреждение. Схему, которой страница не знает, она
 * не рисует и остаётся в «Подключении»: новая форма после выкладки сервера требует новой страницы.
 */
export function onSnapshot(data) {
  let view;
  try {
    view = JSON.parse(data);
  } catch {
    return initial;
  }
  if (view === null || typeof view !== "object" || view.schema !== SCHEMA) return initial;
  return { status: "live", view };
}

/**
 * Связь потеряна: обрыв, отказ, тишина дольше предела. Последний снимок остаётся на экране под предупреждением, а
 * новое открытие соединения предупреждения не снимает — его снимает только следующий снимок.
 */
export function onLost(current) {
  return current.view === null ? initial : { status: "stale", view: current.view };
}

/** Аукцион не найден: одинаково для удалённого, несуществующего и аукциона скрытой сходки. */
export function onMissing() {
  return { status: "missing", view: null };
}

/** Период heartbeat по умолчанию — тот же, что в `application.conf` сервиса. */
export const DEFAULT_HEARTBEAT_MS = 5000;

/**
 * Период heartbeat из разметки страницы. Нечисло или неположительное значение дало бы сторожу `NaN`, а `setTimeout`
 * с `NaN` срабатывает сразу и рвал бы каждое подключение, поэтому такое значение заменяется умолчанием.
 */
export function heartbeatOf(content) {
  const value = Number(content);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_HEARTBEAT_MS;
}

/**
 * Предел тишины: heartbeat приходит после периода тишины, а не по часам, поэтому живой поток молчит до одного
 * периода и сетевой задержки. Три периода не путают тишину торгов с обрывом.
 */
export function silenceLimit(heartbeatMs) {
  return heartbeatMs * 3;
}

/** Самая длинная пауза перед повтором без случайной добавки. */
export const MAX_RETRY_MS = 30000;

/**
 * Пауза перед повтором: растёт вдвое до `MAX_RETRY_MS`, и к ней прибавляется случайная доля до половины паузы, чтобы
 * отказанные по пределу подключения не вернулись разом (ADR-040, «Нагрузка»). `random` — число из [0, 1).
 */
export function retryDelay(attempt, random) {
  const base = Math.min(1000 * 2 ** Math.min(attempt, 15), MAX_RETRY_MS);
  return base + Math.floor((random * base) / 2);
}
