import {
  failureCategories,
  type LogRecord,
} from "../../../../apps/telegram-bot/testkit/index.js";

// Оракулы — каркас записи из docs/standards/observability/logging.md, а не
// ожидания о тексте экранов: исследование ищет нарушения правил, которые
// действуют на любой ход разговора, и поэтому обходится без модели в цикле.
//
// Строгое нарушение — прямое противоречие стандарту; наблюдение — место, где
// стандарт допускает два прочтения, и решает владелец. `service` не
// проверяется: его добавляет продакшн-логгер, а захватывающий логгер харнесса
// пишет только поля границы.

export type Step =
  | { kind: "says"; text: string }
  | { kind: "presses"; label: string };

export type Finding = {
  oracle: string;
  strict: boolean;
  detail: string;
  fields?: LogRecord["fields"];
};

const categories: ReadonlySet<string> = new Set(failureCategories);

// Короткий текст («1», «ok») совпадает с частью любого поля случайно; ниже
// порога утечку текста не проверяем, чтобы не плодить ложные кандидаты.
const leakThreshold = 6;

/** Записи границы — те, что несут `operation`; прочие записи процесса оракулы не видят. */
export function boundaryRecords(records: readonly LogRecord[]): LogRecord[] {
  return records.filter((record) => record.fields.operation !== undefined);
}

export function checkStep(
  step: Step,
  records: readonly LogRecord[],
  telegramUserId: string,
  seenRequestIds: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
  const boundary = boundaryRecords(records);
  if (boundary.length !== 1) {
    findings.push({
      oracle: "one-frame-per-update",
      strict: true,
      detail: `на update записей границы ${boundary.length}, а не одна («Заполняй каркас на каждой границе»)`,
    });
  }
  const expectedOperation = step.kind === "says" ? "message" : "callback_query";
  for (const record of boundary) {
    findings.push(
      ...checkFrame(record, expectedOperation, seenRequestIds),
      ...checkPrivacy(record, step, telegramUserId),
    );
  }
  return findings;
}

function checkFrame(
  record: LogRecord,
  expectedOperation: string,
  seenRequestIds: Set<string>,
): Finding[] {
  const fields = record.fields;
  const findings: Finding[] = [];
  const strict = (oracle: string, detail: string): void => {
    findings.push({ oracle, strict: true, detail, fields });
  };
  const observe = (oracle: string, detail: string): void => {
    findings.push({ oracle, strict: false, detail, fields });
  };

  if (fields.operation !== expectedOperation) {
    strict(
      "operation-matches-update",
      `operation=${fields.operation}, а update — ${expectedOperation}`,
    );
  }
  if (fields.result !== "ok" && fields.result !== "error") {
    strict("result-vocabulary", `result=${String(fields.result)}`);
  }
  if (
    fields.duration_us === undefined ||
    !Number.isInteger(fields.duration_us) ||
    fields.duration_us < 0
  ) {
    strict("duration-integer", `duration_us=${String(fields.duration_us)}`);
  }
  if (fields.request_id === undefined) {
    strict("request-id-present", "край не записал request_id");
  } else if (seenRequestIds.has(fields.request_id)) {
    strict("request-id-unique", "request_id повторился на другом update");
  } else {
    seenRequestIds.add(fields.request_id);
  }
  for (const [name, value] of Object.entries(fields)) {
    if (value === "" || value === null) {
      strict(
        "no-empty-fields",
        `поле ${name} записано пустым, а не опущено («опускается, а не пишется пустым»)`,
      );
    }
  }
  if (fields.result === "error") {
    if (
      fields.error_category === undefined ||
      !categories.has(fields.error_category)
    ) {
      strict(
        "error-category-vocabulary",
        `error_category=${String(fields.error_category)}`,
      );
    }
    if (fields.error === undefined) {
      strict("error-text-present", "при result=error нет поля error");
    }
    if (fields.error_category === "unexpected") {
      // Сам по себе неожиданный отказ — дефект по определению словаря.
      strict("unexpected-failure", `unexpected: ${fields.error ?? ""}`);
      if (fields.stack === undefined) {
        strict("unexpected-has-stack", "неожиданный отказ без stack");
      }
    }
  } else if (
    fields.error_category !== undefined ||
    fields.error !== undefined ||
    fields.stack !== undefined
  ) {
    strict("ok-without-error-fields", "при result=ok записаны поля отказа");
  }
  if (fields.use_case === undefined) {
    // «всегда, кроме операции без сценария»: update начал человек, но
    // сценария в нём может не быть (игнорируемый update). Решает владелец.
    observe(
      "use-case-present",
      `нет use_case у записи «${record.message}» (result=${String(fields.result)})`,
    );
  }
  return findings;
}

function checkPrivacy(
  record: LogRecord,
  step: Step,
  telegramUserId: string,
): Finding[] {
  const findings: Finding[] = [];
  const typed = step.kind === "says" ? step.text.trim() : "";
  for (const [name, value] of Object.entries(record.fields)) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value);
    if (text.includes(telegramUserId)) {
      findings.push({
        oracle: "no-telegram-id",
        strict: true,
        detail: `поле ${name} несёт Telegram user id`,
        fields: record.fields,
      });
    }
    if (typed.length >= leakThreshold && text.includes(typed)) {
      findings.push({
        oracle: "no-user-text",
        strict: true,
        detail: `поле ${name} несёт текст сообщения человека`,
        fields: record.fields,
      });
    }
  }
  if (record.message.includes(telegramUserId)) {
    findings.push({
      oracle: "no-telegram-id",
      strict: true,
      detail: "текст записи несёт Telegram user id",
      fields: record.fields,
    });
  }
  return findings;
}
