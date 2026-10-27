import { lotCurrency } from "../application/lot-form.js";
import { type LaunchDraft, launchLotLimit } from "../application/types.js";

// Черновик запуска окна едет в кнопке пульта (PER-615): состояния у пульта
// нет, а в 64 байта кнопки лот не помещается. Поэтому лоты — номерами в
// отсортированном реестре, а набор — битовой маской по этому реестру.
//
// Символы payload: base36 фиксированной ширины и маска base64url.
//
//   [0]      — «n» (начало — момент, в который сервис решил команду) или «t»
//               (начало задано);
//   [1..5]   — начало, минуты от эпохи;
//   [6..10]  — конец, минуты от эпохи;
//   [11..15] — шаг в целых рублях;
//   [16..26] — маска выбранных лотов: по биту на лот, от младшего бита.
//
// Минуты от эпохи, а не моменты: форма ответа — с точностью до минуты, и пять
// знаков base36 (60 466 176 минут) перекрывают время от эпохи на сто с лишним
// лет. Шаг — пять знаков: форма берёт до 9 999 999 рублей.
//
// Маска несёт 64 лота: кнопка с маской длиннее в 64 байта не помещается.
// Реестр больше — запускаемое окно накрывает первые 64 лота, и пульт говорит
// об этом на экране запуска.

const modeLength = 1;
const momentLength = 5;
const stepLength = 5;
const maskBytes = 8;
const maskLength = 11;
const payloadLength = modeLength + momentLength * 2 + stepLength + maskLength;

function base36(value: number, length: number): string {
  return value.toString(36).padStart(length, "0");
}

// Разбор поля base36: только знаки base36 и только целиком — «0001!» это
// битая кнопка, а не шаг в один рубль.
function fromBase36(text: string): number | undefined {
  if (!/^[0-9a-z]+$/.test(text)) return undefined;
  const value = Number.parseInt(text, 36);
  return Number.isFinite(value) ? value : undefined;
}

// Минуты от эпохи: форма ответа — с точностью до минуты, и секунды в маску
// не помещаются.
function minutesOf(instant: string): number {
  return Math.floor(Date.parse(instant) / 60_000);
}

function instantOf(minutes: number): string {
  return new Date(minutes * 60_000).toISOString().replace(".000Z", "Z");
}

/** Черновик запуска окна в символы кнопки пульта. */
export function encodeLaunchDraft(draft: LaunchDraft): string {
  const bytes = new Uint8Array(maskBytes);
  for (const lot of draft.lots) {
    if (lot < 0 || lot >= launchLotLimit) continue;
    const at = Math.floor(lot / 8);
    bytes[at] = (bytes[at] ?? 0) | (1 << (lot % 8));
  }
  return [
    draft.from === undefined ? "n" : "t",
    base36(draft.from === undefined ? 0 : minutesOf(draft.from), momentLength),
    base36(minutesOf(draft.until), momentLength),
    base36(Math.floor(draft.step.minorUnits / 100), stepLength),
    Buffer.from(bytes).toString("base64url"),
  ].join("");
}

/** Черновик запуска окна из символов кнопки пульта; битая кнопка — отказ. */
export function decodeLaunchDraft(payload: string): LaunchDraft | undefined {
  if (payload.length !== payloadLength) return undefined;
  const mode = payload.slice(0, modeLength);
  if (mode !== "n" && mode !== "t") return undefined;
  const from = fromBase36(payload.slice(1, 1 + momentLength));
  const until = fromBase36(
    payload.slice(1 + momentLength, 1 + momentLength * 2),
  );
  const step = fromBase36(
    payload.slice(1 + momentLength * 2, 1 + momentLength * 2 + stepLength),
  );
  if (from === undefined || until === undefined || step === undefined) {
    return undefined;
  }
  const mask = payload.slice(payloadLength - maskLength);
  if (!/^[A-Za-z0-9_-]+$/.test(mask)) return undefined;
  const bytes = Buffer.from(mask, "base64url");
  if (bytes.length !== maskBytes) return undefined;
  const lots: number[] = [];
  for (let lot = 0; lot < launchLotLimit; lot += 1) {
    const byte = bytes[Math.floor(lot / 8)] ?? 0;
    if ((byte & (1 << (lot % 8))) !== 0) lots.push(lot);
  }
  return {
    ...(mode === "n" ? {} : { from: instantOf(from) }),
    until: instantOf(until),
    step: { minorUnits: step * 100, currency: lotCurrency },
    lots,
  };
}
