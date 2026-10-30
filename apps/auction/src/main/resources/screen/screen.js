// Страница экрана зала (ADR-040, дополнение 2026-10-19; PER-485): поток `state` поверх `fetch`, а не EventSource.
// EventSource не отдаёт странице комментарий `: heartbeat`, не замечает тихого обрыва и после отказа `503`
// не переподключается вовсе, а странице нужны и сторож тишины, и повтор с растущей паузой.

import {
  createSseParser,
  elapsedText,
  finaleText,
  growth,
  heartbeatOf,
  initial,
  MAX_RETRY_MS,
  onLost,
  onMissing,
  onSnapshot,
  retryDelay,
  silenceLimit,
} from "./connection.js";

const heartbeatMs = heartbeatOf(document.querySelector('meta[name="screen-heartbeat"]')?.getAttribute("content"));
const eventsUrl = `${location.pathname.replace(/\/+$/, "")}/events`;
const main = document.getElementById("screen");
const banner = document.getElementById("banner");

let current = initial;
let clock = null;

// Туман живёт поверх сцен и не пересоздаётся: каждый снимок рисует заново только сцену, и его движение не дёргается.
const mist = document.createElement("div");
mist.className = "fog";
const stage = document.createElement("div");
stage.className = "stage";
main.replaceChildren(mist, stage);

function show(...nodes) {
  stage.replaceChildren(...nodes);
}

/**
 * Снимок неожиданной формы не должен останавливать цикл подключения: отрисовка, которая упала, оставляет экран в
 * «Подключении», а следующий снимок рисуется заново.
 */
function apply(next) {
  current = next;
  try {
    render(current);
  } catch (error) {
    console.error("screen: state is not drawable", error);
    show(message("Подключение…"));
  }
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
        apply(onSnapshot(event.data));
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
  apply(current);
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    const outcome = await connect();
    // Аукциона нет: удалён, ещё не создан или сходка скрыта. Экран зала открывают заранее, а удалённый до торгов
    // аукцион рождается заново под тем же идентификатором, поэтому страница спрашивает дальше с той же паузой.
    if (outcome === "missing") apply(onMissing());
    else apply(onLost(current));
    // Паузу сбрасывает только соединение, которое дало снимок и продержалось дольше самой длинной паузы: обрыв
    // после часа торгов не ждёт как десятый отказ подряд, а узел, падающий сразу после снимка, не получает
    // переподключений каждую секунду от каждого экрана.
    if (outcome === "delivered" && Date.now() - startedAt >= MAX_RETRY_MS) attempt = 0;
    await new Promise((resume) => setTimeout(resume, retryDelay(attempt, Math.random())));
  }
}

// --- отрисовка ---------------------------------------------------------------
//
// Оформление «Граф Гуфовский» (PER-839): фото лота в монокле, крупно ставка лидера, под ней усы и имя, три ставки
// перед лидером — визитными карточками. Анимации запускает сама страница, сравнивая снимок с прошлым: новая цена того
// же лота — перебитие, новая фаза — смена сцены. Сервер о них не знает.

/** Что было на экране в прошлой отрисовке: по нему отличается перебитие от повторного снимка того же состояния. */
let shown = null;

function render(state) {
  // Часы лота живут, пока на экране лот в торгах: каждый снимок рисуется заново и заводит их снова.
  clearInterval(clock);
  clock = null;
  document.body.dataset.status = state.status;
  banner.hidden = state.status !== "stale";
  banner.textContent = state.status === "stale" ? "Нет связи — данные могут быть устаревшими" : "";
  if (state.status === "missing") {
    shown = null;
    show(message("Аукцион не найден"));
    return;
  }
  if (state.view === null) {
    show(message("Подключение…"));
    return;
  }
  const now = moment(state.view);
  show(...phase(state.view, change(shown, now)));
  shown = now;
  const elapsed = main.querySelector(".elapsed[data-started]");
  if (elapsed !== null) {
    const tick = () => {
      elapsed.textContent = elapsedText(elapsed.dataset.started, Date.now()) ?? "";
    };
    tick();
    clock = setInterval(tick, 1000);
  }
}

/** Отпечаток снимка для сравнения: фаза, лот на экране, цена и лидер лота в торгах. */
function moment(view) {
  switch (view.phase) {
    case "lot":
      return { phase: view.phase, lot: view.lot.id, price: view.lot.price.amount, leader: view.lot.leader };
    case "between":
      return { phase: view.phase, lot: view.closed.id, price: null, leader: null };
    default:
      return { phase: view.phase, lot: null, price: null, leader: null };
  }
}

/**
 * `bid` — перебитие того же лота: цена выросла, или первая ставка дала лидера по стартовой цене. Снижение цены
 * (снятие участника) перебитием не считается. `scene` — новая фаза или новый лот: печать перерыва. Первый снимок после
 * открытия страницы — не событие: экран просто рисуется.
 */
function change(before, now) {
  if (before === null) return { bid: false, scene: false };
  const sameLot = before.phase === now.phase && before.lot === now.lot;
  const raised = now.price > before.price || (now.price === before.price && before.leader === null && now.leader !== null);
  return { bid: sameLot && now.phase === "lot" && raised, scene: !sameLot };
}

function phase(view, change) {
  switch (view.phase) {
    case "upcoming":
      return [centered(mascot(0, ""), heading("Аукцион"), line("finale", view.final ? finalAt(view) : "Торги идут онлайн"))];
    case "lineup":
      return [centered(mascot(0, ""), heading("Состав финала"), lineup(view.lineup), line("finale", finalAt(view)))];
    case "lot":
      return live(view.lot, change);
    case "between":
      return between(view.closed, view.next, change);
    case "finished":
      return summary("Аукцион завершён", view.sold, view.totals);
    case "cancelled":
      return summary("Аукцион отменён", view.sold, view.totals);
    default:
      return [message("Подключение…")];
  }
}

/**
 * Ориентировочное время финала администратор выставляет как анонс трансляции, и поток приносит его полем `final_at`
 * (ADR-040, дополнение 2026-10-19). Экран пишет его по времени сообщества, а без времени — «Финал скоро» (`finaleText`).
 * Каждый снимок рисуется заново, поэтому смена и снятие времени меняют подпись без перезагрузки. Обратного отсчёта нет.
 */
function finalAt(view) {
  return finaleText(view.final_at, Date.now());
}

/**
 * Лот в торгах: главная цифра — ставка лидера (`price`), под ней имя лидера; время лота и шаг — подписи сверху, а
 * когда ведущий просит больше шага — ещё и его ask. Рост к стартовой здесь не показывается: он в итоге (PER-839).
 */
function live(lot, change) {
  const fresh = change.bid ? " fresh" : "";
  const side = el("div", "side");
  side.append(lotTitle(lot));

  const chips = el("ul", "chips");
  if (typeof lot.started_at === "string") {
    const elapsed = el("span", "elapsed");
    elapsed.dataset.started = lot.started_at;
    const item = el("li", "chip");
    item.append(el("span", "chip-label", "В торгах"), elapsed);
    chips.append(item);
  }
  if (lot.step) chips.append(chip("Шаг", `+${money(lot.step)}`));
  if (lot.ask !== null && lot.ask.amount > lot.price.amount) chips.append(chip("Ведущий просит", money(lot.ask), "ask"));
  side.append(chips);

  const lead = el("div", "lead");
  const hasLeader = lot.leader !== null;
  lead.append(
    el("div", "label", hasLeader ? "Ставка" : "Стартовая цена"),
    el("div", `price current-price${fresh}`, money(lot.price)),
    stache(fresh),
  );
  const leader = el("div", hasLeader ? "leader" : "leader none", hasLeader ? lot.leader : "Ставок пока нет");
  if (leaderBid(lot)) leader.append(channel(lot.bids[0].channel));
  lead.append(leader);
  side.append(lead, bids(lot.bids.slice(leaderBid(lot) ? 1 : 0).slice(0, 3), change.bid));

  return [lens(lot, `lens${fresh}`), el("div", "chain"), guest(lot, change.bid), side, ...(change.bid ? [bat()] : [])];
}

/**
 * Первая из последних ставок — ставка лидера, если её сделал лидер и она дала цену: тогда её канал идёт к имени
 * лидера, а в карточки — три ставки после неё. Прокси-ставка или снятый участник могут дать цену без такой строки.
 */
function leaderBid(lot) {
  const top = lot.bids[0];
  return top !== undefined && lot.leader !== null && top.name === lot.leader && top.amount.amount === lot.price.amount;
}

function chip(label, value, cls = "") {
  const item = el("li", cls === "" ? "chip" : `chip ${cls}`);
  item.append(el("span", "chip-label", label), el("span", "chip-value", value));
  return item;
}

function channelName(value) {
  return value === "hall" ? "зал" : "онлайн";
}

function channel(value) {
  return el("span", `channel ${value === "hall" ? "hall" : "online"}`, channelName(value));
}

function bids(list, fresh) {
  const items = el("ol", "bids");
  list.forEach((bid, index) => {
    const item = el("li", fresh && index === 0 ? "bid fresh" : "bid");
    item.append(
      el("span", "bid-name", bid.name),
      el("span", "bid-amount", money(bid.amount)),
      el("span", "bid-channel", channelName(bid.channel)),
    );
    items.append(item);
  });
  return items;
}

/** Перерыв: на монокль падает печать исхода, справа цена и покупатель, внизу следующий лот. */
function between(closed, next, change) {
  const enter = change.scene ? " fresh" : "";
  const seal = el("div", closed.outcome === "sold" ? `seal${enter}` : `seal muted${enter}`);
  seal.append(sealText(closed.outcome));
  if (closed.outcome === "sold") seal.append(stache(""));

  const side = el("div", "side settled");
  side.append(lotTitle(closed));
  const lead = el("div", "lead");
  if (closed.outcome === "sold") {
    lead.append(el("div", "label", "Забрал за"), el("div", "price", money(closed.price)), stache(""), el("div", "leader", closed.buyer));
  } else {
    lead.append(el("div", "outcome", closed.outcome === "unsold" ? "Лот не продан" : "Лот снят"));
  }
  side.append(lead);
  if (next !== null) {
    const card = el("div", "next");
    const text = el("div", "next-text");
    text.append(el("span", "next-label", "Следующий лот"), document.createTextNode(next.title ?? "Лот без названия"));
    card.append(smallLens(next), text);
    side.append(card);
  } else {
    side.append(el("div"));
  }
  return [lens(closed, "lens"), el("div", "chain"), seal, side];
}

function sealText(outcome) {
  switch (outcome) {
    case "sold":
      return "Продано";
    case "unsold":
      return "Не продан";
    default:
      return "Снят";
  }
}

/** Итог: слева общая сумма, справа гостевая книга — кто что забрал и за сколько, с ростом к стартовой. */
function summary(title, sold, totals) {
  const grand = el("div", "grand");
  grand.append(mascot(0, ""), heading(title), el("div", "label", "Собрано"));
  // Валюта суммы приходит только с продажами: без них суммы нет, и экран не выдумывает «0 ₽» в чужой валюте.
  if (totals.all.count > 0) grand.append(el("div", "price", sums(totals.all)), stache(""));
  grand.append(totalsLine(totals));
  const ledger = el("div", "ledger");
  ledger.append(el("h2", "ledger-title", "Кто что забрал"));
  const list = sold ?? [];
  if (list.length === 0) ledger.append(el("p", "ledger-empty", "Ничего не продано"));
  else ledger.append(soldLots(list));
  return [grand, ledger];
}

/** «3 лота · онлайн 2 на 4 000 ₽ · в финале 1 на 6 500 ₽»: сумм по валютам может быть несколько. */
function totalsLine(value) {
  const parts = [`${value.all.count} ${lots(value.all.count)}`];
  if (value.online.count > 0) parts.push(`онлайн ${value.online.count} на ${sums(value.online)}`);
  if (value.final.count > 0) parts.push(`в финале ${value.final.count} на ${sums(value.final)}`);
  return el("p", "totals", parts.join(" · "));
}

function sums(sales) {
  return sales.sums.map(money).join(" + ");
}

/**
 * Книга вмещает весь итог без прокрутки: до семи лотов — одной колонкой, дальше — двумя и тремя всё мельче. Самый
 * плотный вид прячет рост, чтобы строка осталась в одну высоту.
 */
function density(count) {
  if (count <= 7) return "sold";
  if (count <= 18) return "sold many";
  if (count <= 24) return "sold many dense";
  return "sold crowd";
}

function soldLots(list) {
  const items = el("ol", density(list.length));
  for (const lot of list) {
    const item = el("li", "sold-lot");
    item.append(ownImage(lot.image, "sold-photo") ?? el("span", "sold-photo"));
    const text = el("div", "sold-text");
    text.append(el("div", "sold-title", lot.title ?? "Лот без названия"), el("div", "sold-buyer", lot.in_final ? `${lot.buyer} · финал` : lot.buyer));
    const price = el("div", "sold-price");
    price.append(el("span", "sold-amount", money(lot.price)));
    // Рост к стартовой, а у лота финала ещё и к цене конца онлайн-торгов.
    const fromStart = growthText(lot.price, lot.start);
    if (fromStart !== null) price.append(el("span", "sold-growth", `к стартовой ${fromStart}`));
    const fromOnline = growthText(lot.price, lot.online_end);
    if (fromOnline !== null) price.append(el("span", "sold-growth", `к концу онлайн-торгов ${fromOnline}`));
    item.append(text, price);
    items.append(item);
  }
  return items;
}

/** «+500 ₽ (+25%)»; без базы — `null`, и строка не рисуется. */
function growthText(price, base) {
  const value = growth(price, base ?? null);
  // Цена не выросла: «+0 ₽ (+0%)» — шум, а не рост.
  if (value === null || value.delta === 0) return null;
  const sign = value.delta >= 0 ? "+" : "−";
  const amount = money({ amount: Math.abs(value.delta), currency: price.currency });
  return value.percent === null ? `${sign}${amount}` : `${sign}${amount} (${sign}${Math.abs(value.percent)}%)`;
}

function lineup(lots) {
  // Длинный состав — мельче, чтобы заголовок и время финала остались на сцене.
  const items = el("ol", lots.length > 10 ? "lineup dense" : "lineup");
  for (const lot of lots) {
    const item = el("li");
    item.append(smallLens(lot), el("span", "", lot.title ?? "Лот без названия"));
    items.append(item);
  }
  return items;
}

function lots(count) {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "лотов";
  if (ones === 1) return "лот";
  if (ones >= 2 && ones <= 4) return "лота";
  return "лотов";
}

// --- детали оформления ---------------------------------------------------------

/** Монокль с фото лота; лот без фото показывает в монокле самого Гуфовского. */
function lens(lot, cls) {
  const node = el("div", cls);
  node.append(ownImage(lot.image, "photo") ?? mascot(0, ""));
  return node;
}

function smallLens(lot) {
  const node = el("div", "next-lens");
  node.append(ownImage(lot.image, "photo") ?? mascot(0, ""));
  return node;
}

/** Адрес изображения строит сервер; страница берёт только свой маршрут, а не любой URL из данных. */
function ownImage(image, cls) {
  if (typeof image !== "string" || !image.startsWith("/screen/")) return null;
  const node = el("img", cls);
  node.src = image;
  node.alt = "";
  return node;
}

function guest(lot, fresh) {
  const node = el("div", "guest");
  node.append(mascot(lookOf(lot.price.amount, lot.step?.amount), fresh ? " fresh" : ""));
  return node;
}

function centered(...children) {
  const node = el("div", "center");
  node.append(...children);
  return node;
}

/**
 * Образ Гуфовского меняется с каждой ставкой (PER-839): его выбирает сама цена, поэтому все экраны зала в один момент
 * показывают один и тот же образ, а повторный снимок той же цены образ не меняет. Номер цены на сетке шага растёт на
 * единицу с каждой ставкой финала, поэтому соседние ставки получают разные образы; без шага образ берёт цена целиком.
 */
function lookOf(amount, step) {
  const position = step > 0 ? Math.floor(amount / step) : Math.floor(amount / 100);
  return ((position % LOOKS.length) + LOOKS.length) % LOOKS.length;
}

// Векторы — постоянная разметка страницы, а не данные потока: ввод людей в неё не попадает.
const STACHE = "M50 14 C44 4 30 2 22 10 C16 16 8 18 2 12 C4 26 18 34 32 30 C40 28 46 22 50 20 C54 22 60 28 68 30 C82 34 96 26 98 12 C92 18 84 16 78 10 C70 2 56 4 50 14 Z";

const LOOKS = [
  // Цилиндр
  '<rect x="30" y="4" width="40" height="40" rx="3" fill="#120a14"/><rect x="30" y="34" width="40" height="7" fill="#c9302c"/><ellipse cx="50" cy="46" rx="32" ry="6" fill="#120a14"/><rect x="34" y="8" width="6" height="24" fill="#ffffff22"/>',
  // Берет художника
  '<ellipse cx="52" cy="38" rx="32" ry="12" fill="#b3202a"/><rect x="50" y="20" width="4" height="8" rx="2" fill="#b3202a"/><ellipse cx="50" cy="46" rx="24" ry="4" fill="#7a121a"/>',
  // Колпак повара
  '<circle cx="36" cy="22" r="12" fill="#f4f4ff"/><circle cx="50" cy="14" r="14" fill="#f4f4ff"/><circle cx="64" cy="22" r="12" fill="#f4f4ff"/><rect x="34" y="22" width="32" height="20" fill="#f4f4ff"/><rect x="34" y="40" width="32" height="6" fill="#cfd0e0"/>',
  // Кабуто самурая
  '<path d="M16 48 Q50 2 84 48 Z" fill="#b3141f"/><path d="M36 22 L28 4 M64 22 L72 4" stroke="#e9b949" stroke-width="5" fill="none"/><rect x="12" y="44" width="76" height="7" rx="3" fill="#7c0b14"/>',
  // Ведьминская шляпа
  '<path d="M56 0 L72 40 L28 40 Z" fill="#3a1d5a"/><rect x="30" y="33" width="40" height="7" fill="#ff8a1f"/><ellipse cx="50" cy="45" rx="38" ry="6" fill="#3a1d5a"/>',
  // Мухомор
  '<path d="M10 46 Q50 -6 90 46 Z" fill="#c4121c"/><circle cx="34" cy="28" r="5" fill="#fff"/><circle cx="54" cy="16" r="4" fill="#fff"/><circle cx="68" cy="32" r="4.5" fill="#fff"/><circle cx="46" cy="38" r="3" fill="#fff"/><rect x="10" y="44" width="80" height="5" rx="2" fill="#8a0d14"/>',
  // Котелок
  '<path d="M24 44 Q24 10 50 10 Q76 10 76 44 Z" fill="#5b2a9a"/><rect x="24" y="36" width="52" height="6" fill="#c9302c"/><ellipse cx="50" cy="46" rx="36" ry="5" fill="#4a2080"/>',
  // Кепка стримера
  '<path d="M26 44 Q26 12 50 12 Q74 12 74 44 Z" fill="#a3202a"/><path d="M70 38 L97 45 L70 48 Z" fill="#7a121a"/><circle cx="50" cy="14" r="3" fill="#7a121a"/>',
];

function mascot(look, fresh) {
  return svg(
    `mascot${fresh}`,
    "0 0 100 124",
    '<circle cx="50" cy="76" r="29" fill="#c9a24a"/><circle cx="50" cy="76" r="24" fill="#f5f0ea"/>' +
      '<circle cx="50" cy="76" r="13" fill="#4f7fb8"/><circle cx="50" cy="76" r="6" fill="#0b0610"/>' +
      '<circle cx="45" cy="71" r="2.4" fill="#ffffff"/>' +
      `<path transform="translate(12 96) scale(0.76)" d="${STACHE}" fill="#2a1a10"/>` +
      `<g class="look">${LOOKS[look]}</g>`,
  );
}

function stache(fresh) {
  return svg(`stache${fresh}`, "0 0 100 36", `<path d="${STACHE}"/>`);
}

function bat() {
  return svg(
    "bat",
    "0 0 30 14",
    '<path d="M0 8 Q5 -1 10 5 Q12 1 15 4 Q18 1 20 5 Q25 -1 30 8 Q25 6 22 10 Q18 7 15 11 Q12 7 8 10 Q5 6 0 8Z"/>',
  );
}

function svg(cls, viewBox, markup) {
  const holder = document.createElement("div");
  holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" aria-hidden="true">${markup}</svg>`;
  const node = holder.firstElementChild;
  node.setAttribute("class", cls);
  return node;
}

function lotTitle(lot) {
  return el("h1", "lot-title", lot.title ?? "Лот без названия");
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
  if (cls !== undefined && cls !== "") node.className = cls;
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
