// Страница экрана зала (ADR-040, дополнение 2026-10-19; PER-485): поток `state` поверх `fetch`, а не EventSource.
// EventSource не отдаёт странице комментарий `: heartbeat`, не замечает тихого обрыва и после отказа `503`
// не переподключается вовсе, а странице нужны и сторож тишины, и повтор с растущей паузой.

import { createSseParser, initial, onLost, onMissing, onSnapshot, retryDelay, silenceLimit } from "./connection.js";

const heartbeatMs = Number(document.querySelector('meta[name="screen-heartbeat"]')?.getAttribute("content"));
const eventsUrl = `${location.pathname.replace(/\/+$/, "")}/events`;
const main = document.getElementById("screen");
const banner = document.getElementById("banner");

let current = initial;

function apply(next) {
  current = next;
  render(current);
}

/**
 * Одно подключение до его конца: `missing`, если аукциона нет, `delivered`, если оно успело дать снимок, иначе
 * `lost`. Сторож взводится до ответа и перевзводится каждым куском потока, heartbeat тоже кусок, — поэтому истёкший
 * сторож значит тишину дольше предела.
 */
async function connect() {
  const abort = new AbortController();
  let delivered = false;
  let watchdog;
  const watch = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => abort.abort(), silenceLimit(heartbeatMs));
  };
  watch();
  try {
    const response = await fetch(eventsUrl, {
      signal: abort.signal,
      cache: "no-store",
      headers: { Accept: "text/event-stream" },
    });
    if (response.status === 404) return "missing";
    if (!response.ok || response.body === null) return "lost";
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const parser = createSseParser();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      watch();
      for (const event of parser.push(value)) {
        if (event.event !== "state") continue;
        apply(onSnapshot(current, event.data));
        delivered = true;
      }
    }
  } catch {
    // Обрыв, отказ сети или сторож: исход тот же, что у конца потока.
  } finally {
    clearTimeout(watchdog);
    abort.abort();
  }
  return delivered ? "delivered" : "lost";
}

async function run() {
  render(current);
  for (let attempt = 0; ; attempt++) {
    const outcome = await connect();
    if (outcome === "missing") {
      // Аукциона нет: удалён, не существует или сходка скрыта. Ссылку обновит человек, а не страница.
      apply(onMissing());
      return;
    }
    // Подключение, давшее снимок, сбрасывает паузу: обрыв после часа торгов не ждёт как десятый отказ подряд.
    if (outcome === "delivered") attempt = 0;
    apply(onLost(current));
    await new Promise((resume) => setTimeout(resume, retryDelay(attempt, Math.random())));
  }
}

// --- отрисовка ---------------------------------------------------------------

function render(state) {
  document.body.dataset.status = state.status;
  banner.hidden = state.status !== "stale";
  banner.textContent = state.status === "stale" ? "Нет связи — данные могут быть устаревшими" : "";
  if (state.status === "missing") {
    main.replaceChildren(message("Аукцион не найден"));
    return;
  }
  if (state.view === null) {
    main.replaceChildren(message("Подключение…"));
    return;
  }
  main.replaceChildren(...phase(state.view));
}

function phase(view) {
  switch (view.phase) {
    case "upcoming":
      return [heading("Аукцион"), line("finale", view.final ? finalAt(view.final_at) : "Торги идут онлайн")];
    case "lineup":
      return [heading("Состав финала"), lineup(view.lineup), line("finale", finalAt(view.final_at))];
    case "lot":
      return [live(view.lot)];
    case "between":
      return [between(view.closed, view.next)];
    case "finished":
      return [heading("Аукцион завершён"), totals(view.totals)];
    case "cancelled":
      return [heading("Аукцион отменён"), totals(view.totals)];
    default:
      return [message("Подключение…")];
  }
}

/** Ориентировочного времени финала у аукциона пока нет: поток всегда отдаёт `null`, и экран пишет «скоро». */
function finalAt(_value) {
  return "Финал скоро";
}

function live(lot) {
  const info = el("div", "info");
  info.append(title(lot), el("div", "price", money(lot.price)));
  if (lot.ask !== null) info.append(line("ask", `Ведущий просит ${money(lot.ask)}`));
  info.append(line("leader", lot.leader === null ? "Ставок пока нет" : `Лидирует ${lot.leader}`));
  info.append(bids(lot.bids));
  return card(lot, info);
}

function between(closed, next) {
  const info = el("div", "info");
  info.append(title(closed), line("outcome", outcome(closed)));
  if (next !== null) info.append(line("next", `Следующий лот: ${next.title ?? "без названия"}`));
  return card(closed, info);
}

function outcome(lot) {
  switch (lot.outcome) {
    case "sold":
      return `Продано за ${money(lot.price)} — ${lot.buyer}`;
    case "unsold":
      return "Не продан";
    default:
      return "Снят";
  }
}

function bids(list) {
  const items = el("ol", "bids");
  for (const bid of list) {
    const item = el("li", "bid");
    item.append(
      el("span", "bid-name", bid.name),
      el("span", "bid-amount", money(bid.amount)),
      el("span", `bid-channel ${bid.channel}`, bid.channel === "hall" ? "зал" : "онлайн"),
    );
    items.append(item);
  }
  return items;
}

function lineup(lots) {
  const items = el("ol", "lineup");
  for (const lot of lots) items.append(el("li", "", lot.title ?? "Лот без названия"));
  return items;
}

function totals(value) {
  const table = el("dl", "totals");
  for (const [label, sales] of [
    ["Всего", value.all],
    ["Онлайн", value.online],
    ["В финале", value.final],
  ]) {
    table.append(el("dt", "", label), el("dd", "", sold(sales)));
  }
  return table;
}

function sold(sales) {
  const sums = sales.sums.map(money).join(" + ");
  return sales.count === 0 ? "ничего не продано" : `${sales.count} ${lots(sales.count)} на ${sums}`;
}

function lots(count) {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "лотов";
  if (ones === 1) return "лот";
  if (ones >= 2 && ones <= 4) return "лота";
  return "лотов";
}

function card(lot, info) {
  const node = el("section", "card");
  // Адрес изображения строит сервер; страница берёт только свой маршрут, а не любой URL из данных.
  if (typeof lot.image === "string" && lot.image.startsWith("/screen/")) {
    const image = el("img", "photo");
    image.src = lot.image;
    image.alt = "";
    node.append(image);
  }
  node.append(info);
  return node;
}

function title(lot) {
  return el("h1", "title", lot.title ?? "Лот без названия");
}

function heading(text) {
  return el("h1", "title", text);
}

function message(text) {
  return el("p", "message", text);
}

function line(cls, text) {
  return el("p", cls, text);
}

// Тексты из потока — названия лотов и имена участников — ставятся только через textContent: это ввод людей.
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls !== "") node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Тот же вид, что у ботов (`apps/hub-bot/src/core/format.ts`): копейки — только когда они есть.
function money(value) {
  const whole = value.amount % 100 === 0;
  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: value.currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value.amount / 100);
  } catch {
    return `${value.amount / 100} ${value.currency}`;
  }
}

run();
