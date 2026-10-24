import { createHash } from "node:crypto";
import type { LotPhotoView, LotView } from "../../../auction-ui/index.js";
import { rpcMeta } from "../../../core/rpc-metadata.js";
import { uuidV7Of } from "../../../core/uuid-v7.js";
import type {
  AddLotResult,
  AuctionConsoles,
  AuctionFailure,
  LotAdministration,
  LotCardResult,
  LotPhotoResult,
  LotReadResult,
  LotStepPolicyInput,
  RemoveLotResult,
  SaveLotSetResult,
  ScheduleLotResult,
} from "../auction/port.js";
import { acceptsLots } from "./auction-console.js";
import { fingerprint } from "./fingerprint.js";
import { lotSetLimit } from "./lot-sets.js";
import type {
  AuctionConsoleSnapshot,
  ExecuteResult,
  LotAmount,
  LotAskError,
  LotFormPhoto,
  LotFormRequest,
  LotFormView,
  LotQuestion,
  LotRegistryView,
  LotSet,
  LotSetField,
  LotSetMiss,
  LotStepMode,
  LotTermsView,
  LotTierView,
} from "./types.js";

// Форма лота администратора (PER-319; ADR-047, дополнение 2026-10-05). Каждый
// принятый ответ сразу уходит в Auction: название и описание — в карточку
// каталога, цена и шаг — условиями торгов, фото (PER-452) — байтами в ту же
// карточку. Своего состояния у формы нет.
// Право здесь не решается: его проверяют Auction и Meetups на каждой команде,
// а край только не показывает вход тому, кто не администратор.

/** Валюта формы: платформа одновалютна, и другую Auction отклонит. */
export const lotCurrency = "RUB";

/** Верхняя граница суммы в рублях: семь цифр помещаются в кнопку вопроса. */
export const maxLotRubles = 9_999_999;

/** Сколько форма ждёт лот, которого read model Auction ещё не знает. */
export const lotReadWindowMs = 1_500;
/** Шаг повторного чтения: чаще проекция лот всё равно не покажет. */
const lotReadStepMs = 250;
/**
 * Остаток бюджета действия, который перечитывание не трогает: после чтения
 * идёт команда — правка карточки или условия, — и ей нужно время на ответ.
 */
const lotCommandReserveMs = 1_000;

export type RublesResult =
  | { kind: "ok"; rubles: number }
  | { kind: "rejected"; reason: "amount-format" | "amount-range" };

// Пробел, неразрывный и узкий неразрывный: так сумму пишут с клавиатуры и так
// её показывает сам бот — «5 000 ₽» можно вставить обратно без знака валюты.
const groupSeparators = /[   ]/g;

/**
 * Сумма в целых рублях. Копейки, знак, буквы и экспонента — не число формы:
 * сумма уходит в Auction в минорных единицах, и округление здесь придумало бы
 * цену за человека.
 */
export function parseRubles(raw: string): RublesResult {
  const digits = raw.trim().replace(groupSeparators, "");
  if (!/^\d+$/.test(digits)) {
    return { kind: "rejected", reason: "amount-format" };
  }
  // Ведущие нули длину не раздувают: «0005000» — те же пять тысяч.
  const significant = digits.replace(/^0+/, "");
  if (significant === "" || significant.length > String(maxLotRubles).length) {
    return { kind: "rejected", reason: "amount-range" };
  }
  return { kind: "ok", rubles: Number(significant) };
}

function rubles(amount: number): LotAmount {
  return { minorUnits: amount * 100, currency: lotCurrency };
}

// Целое число рублей, где ноль допустим (первая граница порога). Отличается от
// `parseRubles` только этим: цена ноль не бывает, а граница «от 0» обязана.
function parseWholeRubles(raw: string): number | undefined {
  const digits = raw.trim().replace(groupSeparators, "");
  if (!/^\d+$/.test(digits)) return undefined;
  const significant = digits.replace(/^0+/, "");
  const value = significant === "" ? 0 : Number(significant);
  return value > maxLotRubles ? undefined : value;
}

type StepParse =
  | {
      kind: "ok";
      policy: LotStepPolicyInput;
      terms: { step: LotAmount } | { tiers: readonly LotTierView[] };
    }
  | { kind: "rejected"; reason: LotAskError; suggestion?: LotTierView[] };

/**
 * Сколько порогов отказ `step-start` повторяет исправленными строками: эхо
 * ввода длиннее самого ввода, и текст отказа не должен упереться в предел
 * сообщения Telegram. Длиннее — отказ показывает образец.
 */
const maxSuggestedTiers = 20;

type TierOrder = "ordered" | "step-order" | "step-decreasing";

// Соседние пороги: возрастание границ (И-15) Auction проверит и сам, а
// неубывание шага — правило только формы (PER-709, решение владельца 24.10):
// Auction убывающий шаг принимает, и И-15 его не запрещает.
function tierOrder(tiers: LotTierView[]): TierOrder {
  const pairs = tiers.slice(1).map((tier, i) => [tiers[i], tier] as const);
  for (const [lower, upper] of pairs) {
    if (lower === undefined) continue;
    if (upper.lowerBound.minorUnits <= lower.lowerBound.minorUnits) {
      return "step-order";
    }
  }
  for (const [lower, upper] of pairs) {
    if (lower === undefined) continue;
    if (upper.step.minorUnits < lower.step.minorUnits) return "step-decreasing";
  }
  return "ordered";
}

// Шаг из ответа (PER-491): одно число — `fixed`, строки «от цены — шаг» —
// `tiered`. Пороги проверяются здесь, до Auction, чтобы человек получил
// причину текстом формы. Первый порог не с нуля — обычно стартовая цена
// (прогон dev 24.10): отказ предлагает те же строки с первой границей 0, если
// сами строки идут по порядку (PER-709). Порядок проверяется до замены: иначе
// прежняя первая граница выпала бы из сравнения, и подсказка поменяла бы смысл
// ввода, который нарушал порядок.
function parseStep(mode: LotStepMode, raw: string): StepParse {
  if (mode === "single") {
    const step = parseRubles(raw);
    if (step.kind === "rejected")
      return { kind: "rejected", reason: step.reason };
    const amount = rubles(step.rubles);
    return {
      kind: "ok",
      policy: { kind: "fixed", step: amount },
      terms: { step: amount },
    };
  }
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return { kind: "rejected", reason: "step-format" };
  const tiers: LotTierView[] = [];
  for (const line of lines) {
    // Разделитель — тире любое из трёх; в сумме тире не бывает.
    const parts = line.split(/[—–-]/);
    if (parts.length !== 2) return { kind: "rejected", reason: "step-format" };
    const bound = parseWholeRubles(parts[0] ?? "");
    const step = parseWholeRubles(parts[1] ?? "");
    if (bound === undefined || step === undefined || step <= 0) {
      return { kind: "rejected", reason: "step-format" };
    }
    tiers.push({ lowerBound: rubles(bound), step: rubles(step) });
  }
  const order = tierOrder(tiers);
  const [first, ...rest] = tiers;
  if (first === undefined || first.lowerBound.minorUnits !== 0) {
    return first !== undefined &&
      order === "ordered" &&
      tiers.length <= maxSuggestedTiers
      ? {
          kind: "rejected",
          reason: "step-start",
          suggestion: [{ lowerBound: rubles(0), step: first.step }, ...rest],
        }
      : { kind: "rejected", reason: "step-start" };
  }
  if (order !== "ordered") return { kind: "rejected", reason: order };
  return { kind: "ok", policy: { kind: "tiered", tiers }, terms: { tiers } };
}

/** Шаг, который сохраняется вместе с ценой: из ответа или прежний у лота. */
export type KeptStep = Extract<StepParse, { kind: "ok" }>;

/**
 * Прежний шаг лота для «Оставить шаг» (PER-714): один шаг или пороги из
 * чтения. Одно правило у кнопки экрана и у команды, чтобы подпись и
 * сохранённый шаг не разошлись. Шага в чтении нет — снимок нёс политику,
 * которой форма не знает, или пустые пороги, которые Auction не примет, — и
 * оставлять нечего.
 */
export function keptStep(terms: LotTermsView): KeptStep | undefined {
  if (terms.kind !== "set") return undefined;
  if (terms.tiers !== undefined && terms.tiers.length > 0) {
    return {
      kind: "ok",
      policy: { kind: "tiered", tiers: terms.tiers },
      terms: { tiers: terms.tiers },
    };
  }
  if (terms.step !== undefined) {
    return {
      kind: "ok",
      policy: { kind: "fixed", step: terms.step },
      terms: { step: terms.step },
    };
  }
  return undefined;
}

// Сколько копий заводится одновременно: Auction и Meetups за ним держат
// несколько вызовов сразу, а бюджет действия — пять секунд на всё.
const copyConcurrency = 4;

/** Сколько всего лотов могут дать копии вместе с исходным (PER-716). */
export const minLotCopies = 2;
export const maxLotCopies = 20;

/** Число лотов из ответа на вопрос о копиях; не целое от 2 до 20 — нет. */
export function parseLotCopies(raw: string): number | undefined {
  const digits = raw.trim();
  if (!/^\d{1,2}$/.test(digits)) return undefined;
  const count = Number(digits);
  return count >= minLotCopies && count <= maxLotCopies ? count : undefined;
}

// Хвост номера лота в сете: «Ваза | 3 из 7». Его пишет бот, а человек мог
// прислать название уже с хвостом — второй хвост к нему не дописывается.
const setNumberTail = /\s*\|\s*\d+\s+из\s+\d+\s*$/u;

/** Название без хвоста номера в сете (PER-716): оно же — имя сета копий. */
export function baseTitle(title: string): string {
  return title.replace(setNumberTail, "").trim();
}

/** Название лота сета по его месту: «Ваза | 3 из 7» (PER-716). */
export function numberedTitle(
  base: string,
  position: number,
  total: number,
): string {
  return `${base} | ${position} из ${total}`;
}

// Время UUIDv7 — первые 48 бит, миллисекунды.
function uuidTime(uuid: string): number {
  return Number.parseInt(uuid.replaceAll("-", "").slice(0, 12), 16);
}

/**
 * Идентификатор копии лота по месту в сете (PER-716): тот же исходный лот и
 * место дают тот же лот, поэтому повторный ответ дозаводит копии, а не
 * рождает новые. Время — исходного лота плюс место: лента упорядочена по
 * `lot_id`, и копии встают за исходным по порядку.
 */
export function lotCopyId(sourceLotId: string, position: number): string {
  return uuidV7Of(
    `hub-bot:lot-copy:${sourceLotId}:${position}`,
    uuidTime(sourceLotId) + position - 1,
  );
}

/** Идентификатор сета копий: один на исходный лот (PER-716). */
export function lotCopySetId(sourceLotId: string): string {
  return uuidV7Of(`hub-bot:lot-copy-set:${sourceLotId}`, uuidTime(sourceLotId));
}

// Ключ команды одного лота из ключа ответа: у каждой команды свой, а повтор
// того же ответа даёт те же.
function opIdFor(opId: string, purpose: string): string {
  return uuidV7Of(`${opId}:${purpose}`, uuidTime(opId));
}

// Версия фото у Auction — SHA-256 содержимого: одинаковое фото у лотов сета
// узнаётся без повторной загрузки.
function imageVersion(image: Uint8Array): string {
  return createHash("sha256").update(image).digest("hex");
}

/**
 * Идентификатор фото лота из самого лота и байтов фото (PER-721, как `op_id`
 * из сообщения у PER-699): повторная доставка того же update, повтор после
 * неясного ответа Auction и то же фото, присланное заново, приходят в Auction
 * повтором команды, а не вторым фото. Так же выводят его правка сета и копии
 * (PER-716) для каждого лота. Время UUIDv7 — время рождения лота из его же
 * идентификатора: оно постоянно, как и ключ.
 */
export function lotPhotoIdOf(lotId: string, bytes: Uint8Array): string {
  return uuidV7Of(`lot-photo:${lotId}:${imageVersion(bytes)}`, uuidTime(lotId));
}

// Версии фото лота в порядке показа; у Auction до списка фото — обложка.
function photoVersions(card: LotView["card"]): string[] {
  if (card?.photos !== undefined && card.photos.length > 0) {
    return card.photos.map((photo) => photo.version);
  }
  return card?.image === undefined ? [] : [card.image.version];
}

// Те же ли условия у лота: цена и шаг, одним шагом или порогами.
function sameTerms(
  terms: LotTermsView,
  startingPrice: LotAmount,
  step: KeptStep,
): boolean {
  if (terms.kind !== "set") return false;
  if (terms.startingPrice.minorUnits !== startingPrice.minorUnits) return false;
  if (step.policy.kind === "fixed") {
    return (
      terms.tiers === undefined &&
      terms.step?.minorUnits === step.policy.step.minorUnits
    );
  }
  const tiers = terms.tiers ?? [];
  return (
    tiers.length === step.policy.tiers.length &&
    step.policy.tiers.every(
      (tier, index) =>
        tiers[index]?.lowerBound.minorUnits === tier.lowerBound.minorUnits &&
        tiers[index]?.step.minorUnits === tier.step.minorUnits,
    )
  );
}

// Сет лота для правки сета: только полный — в неполном править вместе нечего.
function fullSetOf(
  console: AuctionConsoleSnapshot,
  lotId: string,
): LotSet | undefined {
  const set = console.lotSets.find((each) => each.lotIds.includes(lotId));
  return set !== undefined && set.lotIds.length >= 2 ? set : undefined;
}

function registryOf(
  console: AuctionConsoleSnapshot,
  lotId: string,
): LotRegistryView {
  const set = console.lotSets.find((each) => each.lotIds.includes(lotId));
  return {
    open: acceptsLots(console.status),
    ...(set === undefined
      ? {}
      : { set: { name: set.name, size: set.lotIds.length } }),
  };
}

// Что правка сета разносит по лотам: значение уже принято у исходного лота.
type SetEdit =
  | { field: "title"; base: string }
  | { field: "description"; description: string }
  | { field: "image"; image: Uint8Array; version: string }
  // Ключ правки цены — ключ ответа: из него выводится ключ команды каждого лота.
  | { field: "price"; startingPrice: LotAmount; step: KeptStep; opId: string };

function termsClosed(lotId: string): ExecuteResult {
  return { kind: "lot-refused", reason: "terms-closed", lotId };
}

function termsOf(lot: LotView): LotTermsView {
  switch (lot.status.kind) {
    case "draft":
      return { kind: "unset" };
    case "scheduled":
      return {
        kind: "set",
        startingPrice: lot.status.startingPrice,
        ...(lot.fixedStep === undefined ? {} : { step: lot.fixedStep }),
        ...(lot.tiers === undefined ? {} : { tiers: lot.tiers }),
      };
    case "sold":
      return { kind: "closed", soldFor: lot.status.price };
    case "trading":
    case "held":
    case "unsold":
    case "withdrawn":
      return { kind: "closed" };
    default: {
      const _exhaustive: never = lot.status;
      return _exhaustive;
    }
  }
}

/** Лот продан: его название, описание и фото больше не меняются. */
export function isSold(
  terms: LotTermsView,
): terms is { kind: "closed"; soldFor: LotAmount } {
  return terms.kind === "closed" && terms.soldFor !== undefined;
}

function viewOf(lot: LotView): LotFormView {
  return {
    lotId: lot.lotId,
    auctionId: lot.auctionId,
    ...(lot.card === undefined ? {} : { title: lot.card.title }),
    description: lot.card?.description ?? "",
    photos: formPhotos(lot.card),
    terms: termsOf(lot),
  };
}

// Фото лота на форме (PER-721): список из чтения, а у Auction до списка —
// одна обложка без идентификатора.
function formPhotos(card: LotView["card"]): LotFormPhoto[] {
  if (card?.photos !== undefined && card.photos.length > 0) {
    return card.photos.map(photoOf);
  }
  return card?.image === undefined
    ? []
    : [{ print: fingerprint(card.image.version) }];
}

function photoOf(photo: LotPhotoView): LotFormPhoto {
  return { print: fingerprint(photo.photoId), photoId: photo.photoId };
}

function failed(failure: AuctionFailure): ExecuteResult {
  return failure.kind === "invalid"
    ? { kind: "dependency-rejected", reason: "invalid", cause: failure.cause }
    : { kind: "dependency-rejected", reason: failure.kind };
}

/**
 * Пульт аукциона для формы (PER-716): реестр и сеты — из агрегата аукциона,
 * того же, по которому Auction проверяет копии и сет.
 */
export type LotFormSets = Pick<
  AuctionConsoles,
  "getAuctionConsole" | "saveLotSet"
>;

export function createLotForm(lots: LotAdministration, sets?: LotFormSets) {
  type Read =
    | { kind: "ok"; raw: LotView; lot: LotFormView }
    | { kind: "refused"; result: ExecuteResult };
  type Known = Extract<Read, { kind: "ok" }>;
  // Место лота в сете для правки «Все лоты сета»: название нумеруется по нему.
  type Slot = { position: number; total: number };

  // Read model Auction отстаёт от команды на сотни миллисекунд, а нажатие поля
  // и ответ на вопрос приходят сразу после «Лот добавлен» (PER-471). Поэтому
  // `not-found` читается заново, пока не выйдет окно или бюджет действия:
  // лот, которого правда нет, получает тот же отказ, только позже. У шага с
  // командой после чтения остаток бюджета под неё перечитывание не трогает —
  // ни ожиданием, ни медленным ответом повторного чтения: иначе найденный лот
  // упёрся бы в дедлайн на правке.
  async function readVisible(
    request: LotFormRequest & { lotId: string },
  ): Promise<LotReadResult> {
    const meta = rpcMeta(request);
    const commandFollows =
      request.intent !== "view-lot-form" &&
      request.intent !== "check-lot-price";
    const readsUntil =
      meta?.deadlineAt === undefined
        ? undefined
        : meta.deadlineAt - (commandFollows ? lotCommandReserveMs : 0);
    const until = Math.min(
      Date.now() + lotReadWindowMs,
      readsUntil ?? Number.POSITIVE_INFINITY,
    );
    const again =
      readsUntil === undefined ? meta : { ...meta, deadlineAt: readsUntil };
    let found = await lots.getLot(request.identity, request.lotId, meta);
    // Повтор начинается, только если после ожидания чтению остаётся хотя бы
    // шаг: вызов без остатка бюджета отказал бы таймаутом, а не `not-found`.
    while (
      found.kind === "not-found" &&
      Date.now() + 2 * lotReadStepMs <= until
    ) {
      await new Promise((resolve) => setTimeout(resolve, lotReadStepMs));
      found = await lots.getLot(request.identity, request.lotId, again);
    }
    return found;
  }

  async function read(
    request: LotFormRequest & { lotId: string },
  ): Promise<Read> {
    const found = await readVisible(request);
    switch (found.kind) {
      case "ok":
        return { kind: "ok", raw: found.lot, lot: viewOf(found.lot) };
      case "not-found":
        return {
          kind: "refused",
          result: {
            kind: "lot-refused",
            reason: "lot-not-found",
            lotId: request.lotId,
          },
        };
      default:
        return { kind: "refused", result: failed(found) };
    }
  }

  // Отказ карточки, общий для создания и правки. `card-conflict` и
  // `card-not-found` у каждой команды свои, и вызывающий разбирает их сам.
  function cardRefused(
    card: Exclude<
      LotCardResult,
      { kind: "ok" | "card-conflict" | "card-not-found" }
    >,
    question: LotQuestion,
    lot: LotFormView | undefined,
  ): ExecuteResult {
    switch (card.kind) {
      case "empty-title":
        return {
          kind: "lot-ask",
          question,
          ...(lot === undefined ? {} : { lot }),
          error: "empty-title",
        };
      case "not-admin":
        return {
          kind: "lot-refused",
          reason: "not-administrator",
          lotId: question.lotId,
        };
      // Фото не прошло, лот прежний: тот же вопрос заново, с пределом Auction.
      case "image-too-large":
        return {
          kind: "lot-ask",
          question,
          ...(lot === undefined ? {} : { lot }),
          error: "image-too-large",
          maxImageBytes: card.maxBytes,
        };
      case "unsupported-image":
        return {
          kind: "lot-ask",
          question,
          ...(lot === undefined ? {} : { lot }),
          error: "unsupported-image",
        };
      case "card-closed":
        return {
          kind: "lot-refused",
          reason: "card-closed",
          lotId: question.lotId,
        };
      default:
        return failed(card);
    }
  }

  async function create(
    request: Extract<LotFormRequest, { intent: "create-lot" }>,
  ): Promise<ExecuteResult> {
    const question: LotQuestion = {
      kind: "new",
      auctionId: request.auctionId,
      lotId: request.lotId,
    };
    const title = request.title.trim();
    const card = { lotId: request.lotId, title, description: "" };
    let written = await lots.createLotCard(
      request.identity,
      card,
      rpcMeta(request),
    );
    // Карточка с этим `lot_id` уже есть с другим названием: прошлый ответ на
    // этот же вопрос оборвался между карточкой и реестром. Новый ответ —
    // правка той карточки, а не отказ: человек отвечает на тот же вопрос.
    // Оборваться мог только ответ боту: тогда лот уже в аукционе, и человек
    // мог дозаполнить его с экрана правки. Описание и условия такого лота
    // берутся из чтения, иначе правка названия стёрла бы описание.
    let known: LotFormView | undefined;
    if (written.kind === "card-conflict") {
      const stored = await lots.getLot(
        request.identity,
        request.lotId,
        rpcMeta(request),
      );
      known = stored.kind === "ok" ? viewOf(stored.lot) : undefined;
      written = await lots.editLotCard(
        request.identity,
        { ...card, description: known?.description ?? "" },
        rpcMeta(request),
      );
    }
    if (written.kind === "card-conflict" || written.kind === "card-not-found") {
      return failed({
        kind: "invalid",
        cause: new Error(`lot card of a new lot answered ${written.kind}`),
      });
    }
    if (written.kind !== "ok") return cardRefused(written, question, undefined);
    const added = await lots.addLot(
      request.identity,
      {
        auctionId: request.auctionId,
        lotId: request.lotId,
        opId: request.opId,
      },
      rpcMeta(request),
    );
    switch (added.kind) {
      case "ok":
        // Экран собран из ответа команд: read model Auction лот ещё не знает.
        // Лот, который она уже знает, заведён прошлым ответом: это правка.
        return known === undefined
          ? {
              kind: "lot-form",
              lot: {
                lotId: request.lotId,
                auctionId: request.auctionId,
                title,
                description: "",
                photos: [],
                terms: { kind: "unset" },
              },
              saved: "created",
            }
          : { kind: "lot-form", lot: { ...known, title }, saved: "text" };
      case "not-administrator":
      case "meetup-not-found":
        return {
          kind: "lot-refused",
          reason: "not-administrator",
          auctionId: request.auctionId,
        };
      case "lots-frozen":
        return {
          kind: "lot-refused",
          reason: "lots-frozen",
          auctionId: request.auctionId,
        };
      case "auction-not-found":
        return { kind: "lot-refused", reason: "auction-not-found" };
      case "meetup-cancelled":
        return {
          kind: "lot-refused",
          reason: "meetup-cancelled",
          auctionId: request.auctionId,
        };
      default:
        return failed(added);
    }
  }

  // Проданный лот покупатель купил под этим названием, описанием и фото:
  // их правку бот не пропускает и из вопроса, заданного до продажи (решение
  // владельца 15 октября 2026 года). Гонку «продан между чтением и записью»
  // закрывает отказ Auction `CardClosed` (PER-638).
  function soldRefusal(lot: LotFormView): ExecuteResult | undefined {
    return isSold(lot.terms)
      ? { kind: "lot-refused", reason: "lot-sold", lotId: lot.lotId }
      : undefined;
  }

  async function setText(
    request: Extract<LotFormRequest, { intent: "set-lot-text" }>,
    current: Known,
    slot?: Slot,
  ): Promise<ExecuteResult> {
    const sold = soldRefusal(current.lot);
    if (sold !== undefined) return sold;
    const question: LotQuestion = {
      kind: "text",
      field: request.field,
      lotId: request.lotId,
      ...(request.set === true ? { set: true as const } : {}),
    };
    // Правка заменяет оба текста, а второй берётся из карточки. Лот без
    // карточки форма не заводила, и править в нём нечего.
    const stored = current.raw.card;
    if (stored === undefined) {
      return {
        kind: "lot-refused",
        reason: "lot-not-found",
        lotId: request.lotId,
      };
    }
    const value = request.value.trim();
    // Пустое название отклоняет Auction, а пустое описание он принял бы и стёр
    // заданное: стирать описание форма не умеет, поэтому вопрос задаётся заново.
    if (request.field === "description" && value === "") {
      return {
        kind: "lot-ask",
        question,
        lot: current.lot,
        error: "empty-description",
      };
    }
    // Правка всего сета нумерует название по месту лота (PER-716): пустое
    // без хвоста — то же пустое название.
    if (request.field === "title" && slot !== undefined) {
      const base = baseTitle(value);
      if (base === "") {
        return {
          kind: "lot-ask",
          question,
          lot: current.lot,
          error: "empty-title",
        };
      }
    }
    const title =
      request.field !== "title"
        ? stored.title
        : slot === undefined
          ? value
          : numberedTitle(baseTitle(value), slot.position, slot.total);
    const description =
      request.field === "description" ? value : stored.description;
    const written = await lots.editLotCard(
      request.identity,
      { lotId: request.lotId, title, description },
      rpcMeta(request),
    );
    if (written.kind === "ok") {
      return {
        kind: "lot-form",
        lot: { ...current.lot, title, description },
        saved: "text",
      };
    }
    if (written.kind === "card-not-found") {
      return {
        kind: "lot-refused",
        reason: "lot-not-found",
        lotId: request.lotId,
      };
    }
    if (written.kind === "card-conflict") {
      return failed({
        kind: "invalid",
        cause: new Error("lot card edit answered card-conflict"),
      });
    }
    return cardRefused(written, question, current.lot);
  }

  // Фото, как название и описание, бот не шлёт у проданного лота. У закрытого
  // без продажи ряд остаётся, а Auction отвечает `CardClosed` (ADR-057). Фото
  // добавляется в конец списка (PER-721): ответ команды несёт список после
  // неё, и форма называет число фото по нему, а не по отстающему чтению.
  // Правка «Все лоты сета» (PER-716) добавляет то же фото в конец каждого лота
  // сета через `overSet`.
  async function addPhoto(
    request: Extract<LotFormRequest, { intent: "add-lot-photo" }>,
    current: Known,
  ): Promise<ExecuteResult> {
    const sold = soldRefusal(current.lot);
    if (sold !== undefined) return sold;
    const written = await lots.addLotPhoto(
      request.identity,
      { lotId: request.lotId, photoId: request.photoId, image: request.image },
      rpcMeta(request),
    );
    return photoWritten(
      written,
      current.lot,
      "photo-added",
      request.set === true,
    );
  }

  // Снимается то фото, которое подтвердили (PER-715, PER-721): кнопка несёт
  // его отпечаток. Фото с этим отпечатком уже нет — итог тот, о котором
  // просили, и команда не нужна. Обложку Auction до списка фото снимает
  // правкой карточки.
  async function removePhoto(
    request: Extract<LotFormRequest, { intent: "remove-lot-photo" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const sold = soldRefusal(current.lot);
    if (sold !== undefined) return sold;
    // «Да» до PER-721 несёт отпечаток версии обложки, а не идентификатора:
    // такая кнопка снимает обложку, если та не сменилась.
    const cover = current.raw.card?.photos?.[0];
    const photo =
      current.lot.photos.find((each) => each.print === request.photoPrint) ??
      (cover !== undefined && fingerprint(cover.version) === request.photoPrint
        ? current.lot.photos[0]
        : undefined);
    if (photo === undefined) {
      return { kind: "lot-form", lot: current.lot, saved: "photo-missing" };
    }
    if (photo.photoId !== undefined) {
      const written = await lots.removeLotPhoto(
        request.identity,
        { lotId: request.lotId, photoId: photo.photoId },
        rpcMeta(request),
      );
      return photoWritten(written, current.lot, "photo-removed");
    }
    const stored = current.raw.card;
    if (stored === undefined) {
      return {
        kind: "lot-refused",
        reason: "lot-not-found",
        lotId: request.lotId,
      };
    }
    const written = await lots.editLotCard(
      request.identity,
      {
        lotId: request.lotId,
        title: stored.title,
        description: stored.description,
        removeImage: true,
      },
      rpcMeta(request),
    );
    if (written.kind === "ok") {
      return {
        kind: "lot-form",
        lot: { ...current.lot, photos: [] },
        saved: "photo-removed",
      };
    }
    if (written.kind === "card-not-found") {
      return {
        kind: "lot-refused",
        reason: "lot-not-found",
        lotId: request.lotId,
      };
    }
    if (written.kind === "card-conflict") {
      return failed({
        kind: "invalid",
        cause: new Error("lot card edit answered card-conflict"),
      });
    }
    return cardRefused(
      written,
      { kind: "image", lotId: request.lotId },
      current.lot,
    );
  }

  function photoWritten(
    written: LotPhotoResult,
    lot: LotFormView,
    saved: "photo-added" | "photo-removed",
    set = false,
  ): ExecuteResult {
    const question: LotQuestion = {
      kind: "image",
      lotId: lot.lotId,
      ...(set ? { set: true as const } : {}),
    };
    switch (written.kind) {
      case "ok":
        return {
          kind: "lot-form",
          lot: { ...lot, photos: written.photos.map(photoOf) },
          saved,
        };
      case "card-not-found":
        return {
          kind: "lot-refused",
          reason: "lot-not-found",
          lotId: lot.lotId,
        };
      // У лота уже предел фото: тот же вопрос заново не поможет — сначала
      // убрать одно.
      case "photo-limit":
        return {
          kind: "lot-refused",
          reason: "photo-limit",
          lotId: lot.lotId,
          maxPhotos: written.maxPhotos,
        };
      // `photoId` рождается на каждое сообщение, и конфликт с другими
      // байтами значит дефект края, а не ответ человека.
      case "photo-conflict":
        return failed({
          kind: "invalid",
          cause: new Error("lot photo answered photo-conflict"),
        });
      default:
        return cardRefused(written, question, lot);
    }
  }

  async function checkPrice(
    request: Extract<LotFormRequest, { intent: "check-lot-price" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    if (current.lot.terms.kind === "closed") {
      return {
        kind: "lot-refused",
        reason: "terms-closed",
        lotId: request.lotId,
      };
    }
    const price = parseRubles(request.value);
    return price.kind === "rejected"
      ? {
          kind: "lot-ask",
          question: { kind: "price", lotId: request.lotId },
          lot: current.lot,
          error: price.reason,
        }
      : // Цена принята — спрашивается способ шага (PER-491), а не шаг сразу.
        {
          kind: "lot-step-mode",
          lot: current.lot,
          priceRubles: price.rubles,
        };
  }

  async function setTerms(
    request: Extract<LotFormRequest, { intent: "set-lot-terms" }>,
    current: Known,
  ): Promise<ExecuteResult> {
    if (current.lot.terms.kind === "closed") return termsClosed(request.lotId);
    const question: LotQuestion = {
      kind: "step",
      lotId: request.lotId,
      priceRubles: request.priceRubles,
      mode: request.mode,
      ...(request.set === true ? { set: true as const } : {}),
    };
    const step = parseStep(request.mode, request.value);
    if (step.kind === "rejected") {
      return {
        kind: "lot-ask",
        question,
        lot: current.lot,
        error: step.reason,
        ...(step.suggestion === undefined
          ? {}
          : { suggestedTiers: step.suggestion }),
      };
    }
    return schedule(request, current.lot, step, question);
  }

  // Новая цена с прежним шагом лота (PER-714). Шаг берётся из чтения, а не из
  // кнопки: пороги в 64 байта не помещаются, а сохраняется тот шаг, что у лота
  // сейчас. Шага у лота нет — снова выбор способа: кнопку старого экрана могли
  // нажать после того, как шаг пропал из чтения.
  async function keepStep(
    request: Extract<LotFormRequest, { intent: "keep-lot-step" }>,
    current: Known,
  ): Promise<ExecuteResult> {
    const { terms } = current.lot;
    if (terms.kind === "closed") return termsClosed(request.lotId);
    const step = keptStep(terms);
    if (step === undefined) {
      return {
        kind: "lot-step-mode",
        lot: current.lot,
        priceRubles: request.priceRubles,
      };
    }
    return schedule(request, current.lot, step, {
      kind: "step",
      lotId: request.lotId,
      priceRubles: request.priceRubles,
      mode: step.policy.kind === "fixed" ? "single" : "tiered",
      ...(request.set === true ? { set: true as const } : {}),
    });
  }

  // Условия торгов в Auction: цена и шаг одной командой `ScheduleLot`.
  async function schedule(
    request: Extract<
      LotFormRequest,
      { intent: "set-lot-terms" | "keep-lot-step" }
    >,
    lot: LotFormView,
    step: KeptStep,
    question: LotQuestion,
  ): Promise<ExecuteResult> {
    const startingPrice = rubles(request.priceRubles);
    const scheduled = await lots.scheduleLot(
      request.identity,
      {
        // Аукцион лота называет сам лот: кнопке вопроса он не нужен.
        auctionId: lot.auctionId,
        lotId: request.lotId,
        opId: request.opId,
        startingPrice,
        stepPolicy: step.policy,
      },
      rpcMeta(request),
    );
    switch (scheduled.kind) {
      case "ok":
        return {
          kind: "lot-form",
          lot: {
            ...lot,
            terms: { kind: "set", startingPrice, ...step.terms },
          },
          saved: "terms",
        };
      case "lots-frozen":
      case "scheduling-closed":
        return termsClosed(request.lotId);
      case "step-policy-invalid":
        return {
          kind: "lot-ask",
          question,
          lot,
          error: "step-refused",
        };
      case "lot-not-in-auction":
        return {
          kind: "lot-refused",
          reason: "lot-not-in-auction",
          lotId: request.lotId,
        };
      case "not-administrator":
      case "meetup-not-found":
        return {
          kind: "lot-refused",
          reason: "not-administrator",
          lotId: request.lotId,
        };
      case "auction-not-found":
        return { kind: "lot-refused", reason: "auction-not-found" };
      case "meetup-cancelled":
        return {
          kind: "lot-refused",
          reason: "meetup-cancelled",
          lotId: request.lotId,
        };
      case "currency-mismatch":
        // Аукцион ведётся не в рублях: человек это не исправит, а форма другой
        // валюты не знает.
        return failed({
          kind: "invalid",
          cause: new Error(`auction does not trade in ${lotCurrency}`),
        });
      default:
        return failed(scheduled);
    }
  }

  type ConsoleRead =
    | { kind: "ok"; console: AuctionConsoleSnapshot }
    | { kind: "refused"; result: ExecuteResult };

  // Пульт аукциона лота: реестр и сеты (PER-716). Без порта пульта форма
  // реестра не знает — копий, удаления и правки сета у неё нет.
  async function readConsole(
    request: LotFormRequest,
    auctionId: string,
  ): Promise<ConsoleRead> {
    if (sets === undefined) {
      return {
        kind: "refused",
        result: { kind: "rejected", reason: "auction-not-configured" },
      };
    }
    const found = await sets.getAuctionConsole(
      request.identity,
      auctionId,
      rpcMeta(request),
    );
    switch (found.kind) {
      case "ok":
        return found;
      case "not-administrator":
      case "meetup-not-found":
        return {
          kind: "refused",
          result: {
            kind: "lot-refused",
            reason: "not-administrator",
            auctionId,
          },
        };
      case "auction-not-found":
        return {
          kind: "refused",
          result: { kind: "lot-refused", reason: "auction-not-found" },
        };
      default:
        return { kind: "refused", result: failed(found) };
    }
  }

  // Экран правки читает и реестр, когда он нужен: открыт ли он и сет лота
  // (PER-716). Пульт не прочитался — экран остаётся экраном одного лота, без
  // копий и удаления.
  async function viewForm(
    request: Extract<LotFormRequest, { intent: "view-lot-form" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    if (sets === undefined || request.registry !== true) {
      return { kind: "lot-form", lot: current.lot };
    }
    const console = await readConsole(request, current.lot.auctionId);
    return {
      kind: "lot-form",
      lot:
        console.kind === "ok"
          ? {
              ...current.lot,
              registry: registryOf(console.console, request.lotId),
            }
          : current.lot,
    };
  }

  // Почему правка не дошла до лота сета: отказ команды словами исхода.
  function missOf(
    result:
      | Exclude<LotCardResult, { kind: "ok" }>
      | Exclude<ScheduleLotResult, { kind: "ok" }>
      | Exclude<LotPhotoResult, { kind: "ok" }>,
  ): LotSetMiss {
    switch (result.kind) {
      case "card-closed":
        return "card-closed";
      case "photo-limit":
        return "photo-limit";
      case "lots-frozen":
      case "scheduling-closed":
        return "terms-closed";
      case "card-not-found":
      case "lot-not-in-auction":
        return "not-in-auction";
      case "timeout":
      case "unavailable":
        return "unavailable";
      default:
        return "refused";
    }
  }

  // Правка одного лота сета значением, уже принятым у исходного. Лот, у
  // которого значение уже такое, команды не получает: повтор безопасен и
  // идёт только к оставшимся.
  async function applyTo(
    request: LotFormRequest,
    lot: LotView,
    edit: SetEdit,
    slot: Slot,
  ): Promise<"ok" | LotSetMiss> {
    const view = viewOf(lot);
    if (edit.field === "price") {
      // Условия Auction принимает только до торгов лота.
      if (view.terms.kind === "closed") return "terms-closed";
      if (sameTerms(view.terms, edit.startingPrice, edit.step)) return "ok";
      const scheduled = await lots.scheduleLot(
        request.identity,
        {
          auctionId: lot.auctionId,
          lotId: lot.lotId,
          opId: opIdFor(edit.opId, `terms:${lot.lotId}`),
          startingPrice: edit.startingPrice,
          stepPolicy: edit.step.policy,
        },
        rpcMeta(request),
      );
      return scheduled.kind === "ok" ? "ok" : missOf(scheduled);
    }
    if (isSold(view.terms)) return "sold";
    const card = lot.card;
    if (card === undefined) return "not-in-auction";
    // Фото сета (PER-721) — то же фото в конец галереи лота. Лот, у которого
    // такое фото уже есть, команды не получает, а идентификатор фото выведен
    // из лота и байтов: повтор Auction узнаёт и второго фото не заводит.
    if (edit.field === "image") {
      if (photoVersions(card).includes(edit.version)) return "ok";
      const added = await lots.addLotPhoto(
        request.identity,
        {
          lotId: lot.lotId,
          photoId: lotPhotoIdOf(lot.lotId, edit.image),
          image: edit.image,
        },
        rpcMeta(request),
      );
      return added.kind === "ok" ? "ok" : missOf(added);
    }
    const title =
      edit.field === "title"
        ? numberedTitle(edit.base, slot.position, slot.total)
        : card.title;
    const description =
      edit.field === "description" ? edit.description : card.description;
    if (card.title === title && card.description === description) return "ok";
    const written = await lots.editLotCard(
      request.identity,
      { lotId: lot.lotId, title, description },
      rpcMeta(request),
    );
    return written.kind === "ok" ? "ok" : missOf(written);
  }

  // Правка сета по лоту за раз (PER-716): лоты по порядку сета, `done` — те,
  // до которых правка уже дошла. Лот, которого пульт ещё не отдаёт, читается
  // отдельно: сеты пульт читает с агрегатом, а лоты — с read model.
  async function spread(
    request: LotFormRequest,
    console: AuctionConsoleSnapshot,
    set: LotSet,
    edit: SetEdit,
    done: ReadonlySet<string>,
  ): Promise<{
    applied: number;
    missed: { title: string; reason: LotSetMiss }[];
  }> {
    const snapshots = new Map(
      console.lots.map((each) => [each.lot.lotId, each.lot]),
    );
    const total = set.lotIds.length;
    let applied = 0;
    const missed: { title: string; reason: LotSetMiss }[] = [];
    for (const [index, lotId] of set.lotIds.entries()) {
      if (done.has(lotId)) {
        applied += 1;
        continue;
      }
      let lot = snapshots.get(lotId);
      if (lot === undefined) {
        const found = await lots.getLot(
          request.identity,
          lotId,
          rpcMeta(request),
        );
        if (found.kind === "ok") lot = found.lot;
        else {
          missed.push({
            title: `лот ${index + 1} из ${total}`,
            reason:
              found.kind === "not-found"
                ? "not-in-auction"
                : found.kind === "timeout" || found.kind === "unavailable"
                  ? "unavailable"
                  : "refused",
          });
          continue;
        }
      }
      const outcome = await applyTo(request, lot, edit, {
        position: index + 1,
        total,
      });
      if (outcome === "ok") applied += 1;
      else {
        missed.push({
          title: lot.card?.title ?? `лот ${index + 1} из ${total}`,
          reason: outcome,
        });
      }
    }
    return { applied, missed };
  }

  // Правка «Все лоты сета» (PER-716): сначала сам лот — его отказ форма
  // показывает так же, как у одного лота, — затем остальные лоты сета тем же
  // значением. Лот вне полного сета правится один: сет могли разобрать, пока
  // висел вопрос.
  async function overSet(
    request: Extract<
      LotFormRequest,
      {
        intent:
          | "set-lot-text"
          | "add-lot-photo"
          | "set-lot-terms"
          | "keep-lot-step";
      }
    >,
    field: LotSetField,
    single: (current: Known, slot?: Slot) => Promise<ExecuteResult>,
    editOf: (saved: LotFormView) => SetEdit | undefined,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    if (request.set !== true || sets === undefined) return single(current);
    const console = await readConsole(request, current.lot.auctionId);
    if (console.kind === "refused") return console.result;
    const set = fullSetOf(console.console, request.lotId);
    if (set === undefined) return single(current);
    const total = set.lotIds.length;
    const result = await single(current, {
      position: set.lotIds.indexOf(request.lotId) + 1,
      total,
    });
    if (result.kind !== "lot-form" || result.saved === undefined) return result;
    const edit = editOf(result.lot);
    if (edit === undefined) return result;
    const { applied, missed } = await spread(
      request,
      console.console,
      set,
      edit,
      new Set([request.lotId]),
    );
    return {
      kind: "lot-set-applied",
      lot: result.lot,
      field,
      applied,
      total,
      missed,
    };
  }

  // Условия, сохранённые у лота, — то, что правка цены разносит по сету.
  function termsEdit(saved: LotFormView, opId: string): SetEdit | undefined {
    const step = keptStep(saved.terms);
    return saved.terms.kind === "set" && step !== undefined
      ? {
          field: "price",
          startingPrice: saved.terms.startingPrice,
          step,
          opId,
        }
      : undefined;
  }

  // «Повторить для оставшихся» (PER-716): значение берётся у самого лота —
  // его правка прошла, — и разносится по сету заново. Лоты, у которых оно
  // уже такое, команды не получают.
  async function retrySet(
    request: Extract<LotFormRequest, { intent: "retry-lot-set" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const console = await readConsole(request, current.lot.auctionId);
    if (console.kind === "refused") return console.result;
    const set = fullSetOf(console.console, request.lotId);
    // Сет разобрали — разносить некуда: экран правки одного лота.
    if (set === undefined) {
      return {
        kind: "lot-form",
        lot: {
          ...current.lot,
          registry: registryOf(console.console, request.lotId),
        },
      };
    }
    if (request.field !== "price") {
      const sold = soldRefusal(current.lot);
      if (sold !== undefined) return sold;
    }
    const card = current.raw.card;
    let edit: SetEdit | undefined;
    switch (request.field) {
      case "title":
        edit =
          card === undefined
            ? undefined
            : { field: "title", base: baseTitle(card.title) || card.title };
        break;
      case "description":
        edit =
          card === undefined
            ? undefined
            : { field: "description", description: card.description };
        break;
      // Фото сета — последнее фото галереи лота (PER-721): его добавила
      // правка, которую повторяют.
      case "image": {
        const last = card?.photos?.at(-1);
        if (last === undefined && card?.image === undefined) break;
        const image =
          last === undefined
            ? await lots.getLotImage(
                request.identity,
                request.lotId,
                rpcMeta(request),
              )
            : await lots.getLotPhoto(
                request.identity,
                { lotId: request.lotId, photoId: last.photoId },
                rpcMeta(request),
              );
        if (image.kind === "not-found") break;
        if (image.kind !== "ok") return failed(image);
        edit = { field: "image", image: image.content, version: image.version };
        break;
      }
      case "price":
        if (current.lot.terms.kind === "closed") {
          return termsClosed(request.lotId);
        }
        edit = termsEdit(current.lot, request.opId);
        break;
      default: {
        const _exhaustive: never = request.field;
        return _exhaustive;
      }
    }
    // Разносить нечего — у лота нет значения поля: экран правки.
    if (edit === undefined) return { kind: "lot-form", lot: current.lot };
    const { applied, missed } = await spread(
      request,
      console.console,
      set,
      edit,
      new Set(),
    );
    return {
      kind: "lot-set-applied",
      lot: current.lot,
      field: request.field,
      applied,
      total: set.lotIds.length,
      missed,
    };
  }

  // Отказ команды копий: реестр закрыли, права нет, сходку отменили. Сбой
  // Auction оставляет вопрос открытым — повторный ответ дозаводит копии.
  function copyRefused(
    result:
      | Exclude<LotCardResult, { kind: "ok" }>
      | Exclude<AddLotResult, { kind: "ok" }>
      | Exclude<ScheduleLotResult, { kind: "ok" }>
      | Exclude<SaveLotSetResult, { kind: "ok" }>
      | Exclude<RemoveLotResult, { kind: "ok" }>
      | Exclude<LotPhotoResult, { kind: "ok" }>,
    lotId: string,
  ): ExecuteResult {
    switch (result.kind) {
      case "timeout":
      case "unavailable":
      case "forbidden":
      case "invalid":
        return failed(result);
      case "not-admin":
      case "not-administrator":
      case "meetup-not-found":
        return { kind: "lot-refused", reason: "not-administrator", lotId };
      case "lots-frozen":
      case "scheduling-closed":
        return { kind: "lot-refused", reason: "lots-frozen", lotId };
      case "meetup-cancelled":
        return { kind: "lot-refused", reason: "meetup-cancelled", lotId };
      case "auction-not-found":
        return { kind: "lot-refused", reason: "auction-not-found" };
      default:
        return failed({
          kind: "invalid",
          cause: new Error(`lot copy answered ${result.kind}`),
        });
    }
  }

  // Байты фото исходного лота для копий по порядку галереи (PER-721). Фото,
  // которое сняли между чтениями, выпадает: копия получит остальные.
  async function sourcePhotos(
    request: LotFormRequest,
    card: NonNullable<LotView["card"]>,
  ): Promise<
    | { kind: "ok"; photos: { version: string; image: Uint8Array }[] }
    | { kind: "refused"; result: ExecuteResult }
  > {
    const listed = card.photos ?? [];
    const reads =
      listed.length > 0
        ? listed.map((photo) =>
            lots.getLotPhoto(
              request.identity,
              { lotId: request.lotId, photoId: photo.photoId },
              rpcMeta(request),
            ),
          )
        : card.image === undefined
          ? []
          : [
              lots.getLotImage(
                request.identity,
                request.lotId,
                rpcMeta(request),
              ),
            ];
    const photos: { version: string; image: Uint8Array }[] = [];
    for (const read_ of await Promise.all(reads)) {
      if (read_.kind === "ok") {
        photos.push({ version: read_.version, image: read_.content });
      } else if (read_.kind !== "not-found") {
        return { kind: "refused", result: failed(read_) };
      }
    }
    return { kind: "ok", photos };
  }

  // Копии лота (PER-716): недостающие лоты с той же карточкой, ценой и
  // шагом, названия «<название> | N из M» у всех, исходный тоже, и сет из
  // них. Идентификаторы копий и сета выведены из исходного лота, поэтому
  // повторный ответ — после сбоя посреди — дозаводит то, чего ещё нет, а то,
  // что уже такое, команды не получает.
  async function copy(
    request: Extract<LotFormRequest, { intent: "copy-lot" }>,
  ): Promise<ExecuteResult> {
    const total = parseLotCopies(request.value);
    const question: LotQuestion = { kind: "copies", lotId: request.lotId };
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    if (total === undefined) {
      return {
        kind: "lot-ask",
        question,
        lot: current.lot,
        error: "copies-count",
      };
    }
    const card = current.raw.card;
    if (card === undefined) {
      return {
        kind: "lot-refused",
        reason: "lot-not-found",
        lotId: request.lotId,
      };
    }
    const read_ = await readConsole(request, current.lot.auctionId);
    if (read_.kind === "refused") return read_.result;
    const { console } = read_;
    const { auctionId } = current.lot;
    if (!acceptsLots(console.status)) {
      return { kind: "lot-refused", reason: "lots-frozen", auctionId };
    }
    const setId = lotCopySetId(request.lotId);
    const holder = console.lotSets.find((each) =>
      each.lotIds.includes(request.lotId),
    );
    // Сет копий этого лота — прошлый ответ: его дозаводит повтор.
    if (holder !== undefined && holder.lotSetId !== setId) {
      return {
        kind: "lot-refused",
        reason: "lot-in-set",
        lotId: request.lotId,
        setName: holder.name,
      };
    }
    if (
      !console.lotSets.some((each) => each.lotSetId === setId) &&
      console.lotSets.length >= lotSetLimit
    ) {
      return { kind: "lot-refused", reason: "set-limit", auctionId };
    }
    const base = baseTitle(card.title) || card.title;
    const terms = termsEdit(current.lot, request.opId);
    const snapshots = new Map(
      console.lots.map((each) => [each.lot.lotId, each.lot]),
    );
    const sourceVersions = photoVersions(card);
    const positions = Array.from(
      { length: total - 1 },
      (_, index) => index + 2,
    );
    const lotIds = [
      request.lotId,
      ...positions.map((position) => lotCopyId(request.lotId, position)),
    ];
    // Фото исходного лота — вся галерея в том же порядке (PER-721). Они
    // читаются один раз и только если у какой-то копии их ещё нет.
    const missingOf = (lotId: string): string[] => {
      const has = photoVersions(snapshots.get(lotId)?.card);
      return sourceVersions.filter((version) => !has.includes(version));
    };
    const images = new Map<string, Uint8Array>();
    if (lotIds.slice(1).some((lotId) => missingOf(lotId).length > 0)) {
      const fetched = await sourcePhotos(request, card);
      if (fetched.kind === "refused") return fetched.result;
      for (const each of fetched.photos) images.set(each.version, each.image);
    }
    // Одна копия — команды по порядку: карточка, реестр, текст, фото по
    // одному, условия. Отказ — исход всего ответа.
    const ensureCopy = async (
      position: number,
    ): Promise<ExecuteResult | undefined> => {
      const lotId = lotCopyId(request.lotId, position);
      const lot = snapshots.get(lotId);
      const title = numberedTitle(base, position, total);
      let textSame =
        lot?.card?.title === title && lot.card.description === card.description;
      if (lot?.card === undefined) {
        const created = await lots.createLotCard(
          request.identity,
          { lotId, title, description: card.description },
          rpcMeta(request),
        );
        // Карточка уже есть — прошлый ответ: правка ниже приводит её к нужной.
        if (created.kind === "ok") textSame = true;
        else if (created.kind !== "card-conflict") {
          return copyRefused(created, request.lotId);
        }
      }
      // Лот в реестре — до правки карточки: правка фото идёт уже лоту.
      if (lot === undefined) {
        const added = await lots.addLot(
          request.identity,
          { auctionId, lotId, opId: opIdFor(request.opId, `add:${lotId}`) },
          rpcMeta(request),
        );
        if (added.kind !== "ok") return copyRefused(added, request.lotId);
      }
      if (!textSame) {
        const edited = await lots.editLotCard(
          request.identity,
          { lotId, title, description: card.description },
          rpcMeta(request),
        );
        if (edited.kind !== "ok") return copyRefused(edited, request.lotId);
      }
      for (const version of missingOf(lotId)) {
        const image = images.get(version);
        if (image === undefined) continue;
        const added = await lots.addLotPhoto(
          request.identity,
          { lotId, photoId: lotPhotoIdOf(lotId, image), image },
          rpcMeta(request),
        );
        if (added.kind !== "ok") return copyRefused(added, request.lotId);
      }
      if (
        terms !== undefined &&
        terms.field === "price" &&
        (lot === undefined ||
          !sameTerms(viewOf(lot).terms, terms.startingPrice, terms.step))
      ) {
        const scheduled = await lots.scheduleLot(
          request.identity,
          {
            auctionId,
            lotId,
            opId: opIdFor(request.opId, `terms:${lotId}`),
            startingPrice: terms.startingPrice,
            stepPolicy: terms.step.policy,
          },
          rpcMeta(request),
        );
        if (scheduled.kind !== "ok") {
          return copyRefused(scheduled, request.lotId);
        }
      }
      return undefined;
    };
    // Копии идут по несколько сразу: двадцать копий по одной не уложились бы
    // в бюджет действия. Не уложились и так — сбой оставляет вопрос открытым,
    // и повторный ответ дозаводит недостающее.
    for (let from = 0; from < positions.length; from += copyConcurrency) {
      const refused = (
        await Promise.all(
          positions.slice(from, from + copyConcurrency).map(ensureCopy),
        )
      ).find((each) => each !== undefined);
      if (refused !== undefined) return refused;
    }
    // Прошлый ответ просил больше лотов: лишние копии уходят из реестра, иначе
    // участники увидели бы их в ленте вне сета.
    for (let position = total + 1; position <= maxLotCopies; position += 1) {
      const lotId = lotCopyId(request.lotId, position);
      if (!snapshots.has(lotId)) continue;
      const removed = await lots.removeLot(
        request.identity,
        { auctionId, lotId, opId: opIdFor(request.opId, `remove:${lotId}`) },
        rpcMeta(request),
      );
      if (removed.kind !== "ok" && removed.kind !== "lot-not-in-auction") {
        return copyRefused(removed, request.lotId);
      }
    }
    const firstTitle = numberedTitle(base, 1, total);
    if (card.title !== firstTitle) {
      const renamed = await lots.editLotCard(
        request.identity,
        {
          lotId: request.lotId,
          title: firstTitle,
          description: card.description,
        },
        rpcMeta(request),
      );
      if (renamed.kind !== "ok") return copyRefused(renamed, request.lotId);
    }
    const existing = console.lotSets.find((each) => each.lotSetId === setId);
    const setSame =
      existing !== undefined &&
      existing.name === base &&
      existing.lotIds.length === lotIds.length &&
      existing.lotIds.every((lotId, index) => lotId === lotIds[index]);
    if (!setSame && sets !== undefined) {
      const saved = await sets.saveLotSet(
        request.identity,
        {
          auctionId,
          lotSetId: setId,
          name: base,
          lotIds,
          opId: opIdFor(request.opId, "set"),
        },
        rpcMeta(request),
      );
      // Копию переложили в другой сет, пока сета копий не было: тот же отказ,
      // что у лота в сете, с именем того сета.
      if (saved.kind === "lot-in-another-set") {
        const holder = console.lotSets.find(
          (each) => each.lotSetId === saved.lotSetId,
        );
        return {
          kind: "lot-refused",
          reason: "lot-in-set",
          lotId: request.lotId,
          ...(holder === undefined ? {} : { setName: holder.name }),
        };
      }
      if (saved.kind !== "ok") return copyRefused(saved, request.lotId);
    }
    return {
      kind: "lot-copies",
      lot: { ...current.lot, title: firstTitle },
      total,
      name: base,
    };
  }

  // «Да, удалить лот» (PER-716): лот уходит из реестра, а Auction убирает его
  // и из сета (ADR-073, п. 3). Лот, которого в реестре уже нет, — то же
  // удаление, прошедшее раньше.
  async function removeLot(
    request: Extract<LotFormRequest, { intent: "remove-lot" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const { auctionId, title } = current.lot;
    const removed = await lots.removeLot(
      request.identity,
      { auctionId, lotId: request.lotId, opId: request.opId },
      rpcMeta(request),
    );
    const named = title === undefined ? {} : { title };
    switch (removed.kind) {
      case "ok":
        return { kind: "lot-removed", auctionId, ...named };
      case "lot-not-in-auction":
        return { kind: "lot-removed", auctionId, ...named, already: true };
      case "lots-frozen":
        return {
          kind: "lot-refused",
          reason: "removal-frozen",
          lotId: request.lotId,
        };
      case "not-administrator":
      case "meetup-not-found":
        return {
          kind: "lot-refused",
          reason: "not-administrator",
          lotId: request.lotId,
        };
      case "meetup-cancelled":
        return {
          kind: "lot-refused",
          reason: "meetup-cancelled",
          lotId: request.lotId,
        };
      case "auction-not-found":
        return { kind: "lot-refused", reason: "auction-not-found" };
      default:
        return failed(removed);
    }
  }

  return async function lotForm(
    request: LotFormRequest,
  ): Promise<ExecuteResult> {
    switch (request.intent) {
      case "create-lot":
        return create(request);
      case "view-lot-form":
        return viewForm(request);
      case "view-lot-preview": {
        const current = await read(request);
        return current.kind === "refused"
          ? current.result
          : { kind: "lot-preview", lot: current.raw };
      }
      // Правка «Все лоты сета» (PER-716) идёт через `overSet`: без признака
      // сета он правит один лот, как раньше.
      case "set-lot-text": {
        const value = request.value.trim();
        return overSet(
          request,
          request.field,
          (current, slot) => setText(request, current, slot),
          () =>
            request.field === "title"
              ? { field: "title", base: baseTitle(value) }
              : { field: "description", description: value },
        );
      }
      case "check-lot-price":
        return checkPrice(request);
      case "set-lot-terms":
        return overSet(
          request,
          "price",
          (current) => setTerms(request, current),
          (saved) => termsEdit(saved, request.opId),
        );
      case "keep-lot-step":
        return overSet(
          request,
          "price",
          (current) => keepStep(request, current),
          (saved) => termsEdit(saved, request.opId),
        );
      case "add-lot-photo":
        return overSet(
          request,
          "image",
          (current) => addPhoto(request, current),
          () => ({
            field: "image",
            image: request.image,
            version: imageVersion(request.image),
          }),
        );
      case "remove-lot-photo":
        return removePhoto(request);
      case "retry-lot-set":
        return retrySet(request);
      case "copy-lot":
        return copy(request);
      case "remove-lot":
        return removeLot(request);
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
