// Логика подключения экрана зала без DOM, таймеров и сети: разбор SSE, переходы состояния и пауза повтора, — и
// подпись времени финала. Таблица «Потеря актуальности» ADR-040 живёт здесь, а `screen.js` только исполняет её по
// событиям сети и рисует.

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

/**
 * Пояс сообщества. Страница его ни от кого не получает: поток отдаёт момент без пояса, а Auction пояса не знает. Это
 * тот же пояс, что AppHost раздаёт ботам и Meetups (`CommunityTime.Zone`).
 */
export const COMMUNITY_TIME_ZONE = "Europe/Moscow";

/**
 * Подпись ориентировочного времени финала (`final_at`, ADR-040, дополнение 2026-10-19) по времени сообщества:
 * «Финал в 19:00» в тот же день, что `now`, иначе «Финал 24 октября в 19:00». Без времени или с моментом, который не
 * разбирается, — «Финал скоро». `now` — мгновение в миллисекундах.
 */
export function finaleText(finalAt, now, timeZone = COMMUNITY_TIME_ZONE) {
  if (typeof finalAt !== "string") return "Финал скоро";
  const at = new Date(finalAt);
  if (Number.isNaN(at.getTime())) return "Финал скоро";
  const time = new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const day = new Intl.DateTimeFormat("ru-RU", { timeZone, year: "numeric", month: "numeric", day: "numeric" });
  if (day.format(at) === day.format(new Date(now))) return `Финал в ${time.format(at)}`;
  const date = new Intl.DateTimeFormat("ru-RU", { timeZone, day: "numeric", month: "long" });
  return `Финал ${date.format(at)} в ${time.format(at)}`;
}

/**
 * Сколько лот уже в торгах (`started_at`, PER-819): «м:сс», с часами от часа. Без времени или с моментом, который не
 * разбирается, — `null`: экран не показывает то, чего не знает. Момент из будущего (часы страницы и сервиса
 * расходятся) даёт ноль, а не отрицательное время. `now` — мгновение в миллисекундах.
 */
export function elapsedText(startedAt, now) {
  if (typeof startedAt !== "string") return null;
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return null;
  const total = Math.max(0, Math.floor((now - started) / 1000));
  const pad = (value) => String(value).padStart(2, "0");
  const seconds = pad(total % 60);
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${pad(minutes)}:${seconds}` : `${pad(minutes)}:${seconds}`;
}

/**
 * Рост цены к базе (`start`, `online_end`): разница в минорных единицах и процент, округлённый до целого. Нет базы или
 * база в другой валюте — `null`, чужую валюту не вычитают; от нулевой базы процент не определён — он `null`, а разница
 * остаётся.
 */
export function growth(price, base) {
  if (base === null || base === undefined || base.currency !== price.currency) return null;
  const delta = price.amount - base.amount;
  const percent = base.amount > 0 ? Math.round((delta / base.amount) * 100) : null;
  return { delta, percent };
}
