import type { LotView } from "@solguficky/auction-bot-ui";
import type {
  AuctionFailure,
  LotAdministration,
  LotCardResult,
} from "../auction/port.js";
import { rpcMeta } from "../rpc-metadata.js";
import type {
  ExecuteResult,
  LotAmount,
  LotFormRequest,
  LotFormView,
  LotQuestion,
  LotTermsView,
} from "./types.js";

// Форма лота администратора (PER-319; ADR-047, дополнение 2026-10-05). Каждый
// принятый ответ сразу уходит в Auction: название и описание — в карточку
// каталога, цена и шаг — условиями торгов. Своего состояния у формы нет.
// Право здесь не решается: его проверяют Auction и Meetups на каждой команде,
// а край только не показывает вход тому, кто не администратор.

/** Валюта формы: платформа одновалютна, и другую Auction отклонит. */
export const lotCurrency = "RUB";

/** Верхняя граница суммы в рублях: семь цифр помещаются в кнопку вопроса. */
export const maxLotRubles = 9_999_999;

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

function termsOf(lot: LotView): LotTermsView {
  switch (lot.status.kind) {
    case "draft":
      return { kind: "unset" };
    case "scheduled":
      return {
        kind: "set",
        startingPrice: lot.status.startingPrice,
        ...(lot.fixedStep === undefined ? {} : { step: lot.fixedStep }),
      };
    case "trading":
    case "held":
    case "sold":
    case "unsold":
    case "withdrawn":
      return { kind: "closed" };
    default: {
      const _exhaustive: never = lot.status;
      return _exhaustive;
    }
  }
}

function viewOf(lot: LotView): LotFormView {
  return {
    lotId: lot.lotId,
    auctionId: lot.auctionId,
    ...(lot.card === undefined ? {} : { title: lot.card.title }),
    description: lot.card?.description ?? "",
    terms: termsOf(lot),
  };
}

function failed(failure: AuctionFailure): ExecuteResult {
  return failure.kind === "invalid"
    ? { kind: "dependency-rejected", reason: "invalid", cause: failure.cause }
    : { kind: "dependency-rejected", reason: failure.kind };
}

export function createLotForm(lots: LotAdministration) {
  type Read =
    | { kind: "ok"; raw: LotView; lot: LotFormView }
    | { kind: "refused"; result: ExecuteResult };

  async function read(
    request: LotFormRequest & { lotId: string },
  ): Promise<Read> {
    const found = await lots.getLot(
      request.identity,
      request.lotId,
      rpcMeta(request),
    );
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
      default:
        return failed(added);
    }
  }

  async function setText(
    request: Extract<LotFormRequest, { intent: "set-lot-text" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const question: LotQuestion = {
      kind: "text",
      field: request.field,
      lotId: request.lotId,
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
    const title = request.field === "title" ? value : stored.title;
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
      : {
          kind: "lot-ask",
          question: {
            kind: "step",
            lotId: request.lotId,
            priceRubles: price.rubles,
          },
          lot: current.lot,
        };
  }

  async function setTerms(
    request: Extract<LotFormRequest, { intent: "set-lot-terms" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const closed: ExecuteResult = {
      kind: "lot-refused",
      reason: "terms-closed",
      lotId: request.lotId,
    };
    if (current.lot.terms.kind === "closed") return closed;
    const question: LotQuestion = {
      kind: "step",
      lotId: request.lotId,
      priceRubles: request.priceRubles,
    };
    const step = parseRubles(request.value);
    if (step.kind === "rejected") {
      return {
        kind: "lot-ask",
        question,
        lot: current.lot,
        error: step.reason,
      };
    }
    const startingPrice = rubles(request.priceRubles);
    const fixedStep = rubles(step.rubles);
    const scheduled = await lots.scheduleLot(
      request.identity,
      {
        // Аукцион лота называет сам лот: кнопке вопроса он не нужен.
        auctionId: current.lot.auctionId,
        lotId: request.lotId,
        opId: request.opId,
        startingPrice,
        step: fixedStep,
      },
      rpcMeta(request),
    );
    switch (scheduled.kind) {
      case "ok":
        return {
          kind: "lot-form",
          lot: {
            ...current.lot,
            terms: { kind: "set", startingPrice, step: fixedStep },
          },
          saved: "terms",
        };
      case "lots-frozen":
      case "scheduling-closed":
        return closed;
      case "step-policy-invalid":
        return {
          kind: "lot-ask",
          question,
          lot: current.lot,
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

  return async function lotForm(
    request: LotFormRequest,
  ): Promise<ExecuteResult> {
    switch (request.intent) {
      case "create-lot":
        return create(request);
      case "view-lot-form": {
        const current = await read(request);
        return current.kind === "refused"
          ? current.result
          : { kind: "lot-form", lot: current.lot };
      }
      case "set-lot-text":
        return setText(request);
      case "check-lot-price":
        return checkPrice(request);
      case "set-lot-terms":
        return setTerms(request);
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
