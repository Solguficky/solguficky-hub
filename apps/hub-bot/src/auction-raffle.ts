import type { RaffleView } from "./auction-ui/index.js";

// Тексты экрана розыгрыша среди участников (ADR-066, п. 11) общие у обеих
// поверхностей, как FAQ: правила и пересчёт не должны расходиться между
// ботами. Навигацию и формат момента задаёт оболочка. Язык — «розыгрыш среди
// участников» (RFC-007, инвариант 8): слова из запретного списка держит
// линтер экранов.

export const raffleTitle = "Розыгрыш среди участников";
export const raffleButtonLabel = "Розыгрыш";
export const raffleBackName = "Розыгрыш";
export const registerLabel = "Зарегистрироваться";
export const cancelRegistrationLabel = "Отменить регистрацию";

// Сеть drand `quicknet` (ADR-066, п. 7): по этой ссылке раунд открывает любой.
const DRAND_CHAIN =
  "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
export const drandRoundUrl = (round: number) =>
  `https://drand.cloudflare.com/${DRAND_CHAIN}/public/${round}`;

// Строк списка «номер — имя» на экране: дальше текст упёрся бы в предел
// сообщения Telegram. Свой номер и выигравший билет называются отдельной
// строкой при любом размере пула.
export const TICKETS_SHOWN = 40;

export type RaffleTextOptions = {
  // Момент RFC 3339 для чтения в поясе сообщества.
  moment: (instant: string) => string;
};

// Экран «Как проверить честность» (PER-618): техника розыгрыша за кнопкой с
// экрана участника, возврат — «‹ Розыгрыш».
export const raffleProofTitle = "Как проверить честность";
export const raffleProofLabel = "Как проверить честность";

// Строка экрана участника до жеребьёвки вместо отпечатка: техника — на экране
// проверки, а здесь только то, что она есть.
const provableLine = "Итог проверяемый: как его проверить — по кнопке ниже.";

/** Абзацы тела экрана под заголовком, уже экранированные. */
export function raffleParagraphs(
  raffle: RaffleView | undefined,
  options: RaffleTextOptions,
): string[] {
  if (raffle === undefined) return ["У этого аукциона розыгрыша нет."];
  const closesAt = escapeHtml(options.moment(raffle.closesAt));
  switch (raffle.status) {
    case "open":
      return [
        rules,
        `Регистрация до ${closesAt}. Итог — через пару минут после закрытия регистрации.`,
        raffle.registered
          ? "<b>Ты зарегистрирован.</b> Отменить регистрацию можно до её закрытия."
          : "Ты пока не зарегистрирован.",
        provableLine,
      ];
    case "closing":
      return [
        `Регистрация закрыта ${closesAt}: билеты получают номера.`,
        raffle.registered
          ? "Ты зарегистрирован: номер билета появится, когда пул зафиксируют."
          : "Ты не зарегистрирован.",
        provableLine,
      ];
    case "awaiting-beacon":
      return [
        `Регистрация закрыта ${closesAt}.`,
        poolLine(raffle),
        ticketList(raffle),
        "Жеребьёвка идёт: итог — через пару минут.",
        provableLine,
      ];
    case "drawn":
      return [winnerLine(raffle), poolLine(raffle), ticketList(raffle)];
    case "no-tickets":
      return [
        `Розыгрыш не состоялся: к закрытию регистрации ${closesAt} никто не зарегистрировался.`,
      ];
    case "not-held":
      return [
        "Розыгрыш не проводится: онлайн-торги открылись не раньше момента закрытия регистрации.",
      ];
    default: {
      const _exhaustive: never = raffle.status;
      return _exhaustive;
    }
  }
}

/**
 * Абзацы экрана «Как проверить честность» (PER-618), уже экранированные:
 * отпечаток seed и раунд маяка с открытия регистрации, после жеребьёвки — seed,
 * значение раунда, V и пересчёт с командой.
 */
export function raffleProofParagraphs(
  raffle: RaffleView | undefined,
): string[] {
  if (raffle === undefined) return ["У этого аукциона розыгрыша нет."];
  switch (raffle.status) {
    case "open":
    case "closing":
      return [
        commitmentLines(raffle),
        "Seed раскроется после жеребьёвки: по нему любой пересчитает итог сам.",
      ];
    case "awaiting-beacon":
      return [
        commitmentLines(raffle),
        `Жеребьёвка ждёт значение маяка drand, раунд ${roundLink(raffle)}. Seed раскроется после неё.`,
      ];
    case "drawn":
      return [
        commitmentLines(raffle),
        revealLines(raffle),
        raffle.reveal === undefined ? "" : recomputeSteps(raffle),
      ].filter((line) => line !== "");
    case "no-tickets":
      return [
        commitmentLines(raffle),
        raffle.reveal === undefined
          ? ""
          : `Seed: <code>${escapeHtml(raffle.reveal.seed)}</code>`,
        "Билетов не было: пересчитывать нечего.",
      ].filter((line) => line !== "");
    case "not-held":
      return ["Розыгрыш не проводился: проверять нечего."];
    default: {
      const _exhaustive: never = raffle.status;
      return _exhaustive;
    }
  }
}

const rules =
  "Один билет каждому участнику аукциона за бесплатную регистрацию. Ставки и покупки на билет не влияют, проигрыш ничего не стоит. Приз предоставляет организатор.";

function roundLink(raffle: RaffleView): string {
  return raffle.beaconRound === undefined
    ? "—"
    : `<a href="${drandRoundUrl(raffle.beaconRound)}">${raffle.beaconRound}</a>`;
}

// Опубликованное с открытия регистрации: отпечаток seed и раунд маяка.
function commitmentLines(raffle: RaffleView): string {
  return [
    `Отпечаток seed (SHA-256): <code>${escapeHtml(raffle.commitment ?? "—")}</code>`,
    `Раунд маяка drand: ${roundLink(raffle)}`,
  ].join("\n");
}

// Поля пула — строки «ключ: значение» без точки (дизайн-код, «Формат»).
function poolLine(raffle: RaffleView): string {
  return [
    `Билетов: ${raffle.tickets.length}`,
    raffle.myTicket === undefined
      ? "Твой билет: нет"
      : `Твой билет: №${raffle.myTicket}`,
  ].join("\n");
}

/** Текст выбора имени перед регистрацией: тот же экран, что перед ставкой. */
export function raffleNameChoiceText(username: string | undefined): string {
  return [
    "Имя видно всем участникам аукциона в списке розыгрыша и рядом с твоими ставками. После первой ставки его не поменять.",
    username === undefined
      ? "Ника в Telegram у тебя нет: возьми псевдоним."
      : `Зарегистрируйся под ником @${escapeHtml(username)} или возьми псевдоним.`,
  ].join("\n");
}

function ticketName(ticket: { number: number; displayName?: string }): string {
  return ticket.displayName === undefined
    ? `№${ticket.number}`
    : `№${ticket.number} — ${escapeHtml(ticket.displayName)}`;
}

function ticketList(raffle: RaffleView): string {
  const shown = raffle.tickets.slice(0, TICKETS_SHOWN);
  const rest = raffle.tickets.length - shown.length;
  return [
    ...shown.map((ticket) => `• ${ticketName(ticket)}`),
    ...(rest > 0 ? [`… и ещё ${rest}`] : []),
  ].join("\n");
}

function winnerLine(raffle: RaffleView): string {
  const number = raffle.reveal?.winningTicket;
  const ticket = raffle.tickets.find((each) => each.number === number);
  if (number === undefined) return "<b>Жеребьёвка прошла.</b>";
  return `<b>Выиграл билет ${ticketName(ticket ?? { number })}.</b>${
    number === raffle.myTicket ? " Это твой билет." : ""
  }`;
}

function revealLines(raffle: RaffleView): string {
  const { reveal } = raffle;
  if (reveal === undefined) return "";
  return [
    `Seed: <code>${escapeHtml(reveal.seed)}</code>`,
    `Значение раунда ${roundLink(raffle)}: <code>${escapeHtml(reveal.randomness ?? "—")}</code>`,
    `V: <code>${escapeHtml(reveal.value ?? "—")}</code>`,
  ].join("\n");
}

// Пересчёт без доступа к базе (ADR-066, «Пересчёт участником»): четыре шага и
// однострочник на Python для четвёртого.
function recomputeSteps(raffle: RaffleView): string {
  const seed = raffle.reveal?.seed ?? "";
  const randomness = raffle.reveal?.randomness ?? "";
  const count = raffle.tickets.length;
  const python = `python3 -c "import hashlib;v=hashlib.sha256(b'${seed}:${count}:${randomness}').hexdigest();print(int(v,16)%${count}+1)"`;
  return [
    "<b>Как проверить итог</b>",
    "1. SHA-256 от seed совпадает с отпечатком, который висел с открытия регистрации: seed не подменили.",
    `2. Значение раунда совпадает с тем, что публикует drand по ссылке на раунд: маяк взят не у нас.`,
    "3. Число билетов совпадает с тем, что экран показал после закрытия регистрации: пул не дописали.",
    "4. V = SHA-256 строки «seed:число билетов:значение раунда», номер выигравшего билета — V mod число билетов + 1:",
    `<code>${escapeHtml(python)}</code>`,
  ].join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
