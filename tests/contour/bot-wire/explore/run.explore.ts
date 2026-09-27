import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  freshTelegramUserId,
  it,
  type LogRecord,
  openBotWire,
  openDirectClients,
  type Person,
  readContourEnvironment,
  startConversation,
} from "../../../../apps/telegram-bot/testkit/index.js";
import { checkStep, type Finding, type Step } from "./oracles.js";
import { forSequence, type Random } from "./random.js";

// Исследующий прогон RFC-012, роль 3: случайные последовательности действий
// человека поверх `bot.handleUpdate` с настоящими Identity и Meetups, оракулы —
// каркас записи логов. Это не гейт: файл не `*.test.ts`, его не подхватывает
// `vitest.contour.config.ts`, а рецепт `just contour-bot-explore` не входит ни
// в `verify`, ни в `test-all`, ни в CI. Найденное — кандидаты для владельца:
// прогон не падает на них, а только на том, что не прошёл заданное число
// последовательностей.
//
//   EXPLORE_SEED=<n>        seed генерации; без него берётся случайный и печатается
//   EXPLORE_RUNS=<n>        число последовательностей (30)
//   EXPLORE_STEPS=<n>       шагов в последовательности (15)
//   EXPLORE_REPLAY=<файл>#<i>  повтор записанного скрипта последовательности i

type Sequence = {
  index: number;
  admin: boolean;
  script: Step[];
  /** Шаг, на котором повтор разошёлся с записью: кнопки с этой подписью уже нет. */
  divergedAt?: number;
};

type Candidate = {
  key: string;
  oracle: string;
  strict: boolean;
  detail: string;
  occurrences: number;
  first: {
    sequence: number;
    step: number;
    admin: boolean;
    script: Step[];
    fields?: LogRecord["fields"];
  };
};

type Coverage = {
  useCases: Set<string>;
  outcomes: Set<string>;
  screens: Map<string, number>;
  labels: Set<string>;
  steps: number;
};

// Пути — от корня репозитория, а не от cwd: npm запускает vitest из
// `apps/telegram-bot`, а человек пишет путь отчёта так, как его напечатал рецепт.
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const reportDir = resolve(repoRoot, ".work/explore/");

const seed = readNumber("EXPLORE_SEED") ?? randomInt(0, 2 ** 31);
const runs = readNumber("EXPLORE_RUNS") ?? 30;
const stepsPerRun = readNumber("EXPLORE_STEPS") ?? 15;
const replay = readReplay(process.env["EXPLORE_REPLAY"]);

const environment = readContourEnvironment();
const direct = openDirectClients(environment);
const wire = openBotWire(environment);

beforeAll(async () => {
  await direct.waitUntilReachable();
});

afterAll(() => {
  wire.close();
  direct.close();
});

describe("исследование провода бота", () => {
  it("проходит заданное число последовательностей и сводит кандидатов", async () => {
    const candidates = new Map<string, Candidate>();
    const coverage: Coverage = {
      useCases: new Set(),
      outcomes: new Set(),
      screens: new Map(),
      labels: new Set(),
      steps: 0,
    };
    const seenRequestIds = new Set<string>();
    const sequences: Sequence[] = [];
    const planned = replay === undefined ? runs : 1;

    for (let index = 0; index < planned; index += 1) {
      const random = forSequence(seed, index);
      const recorded = replay?.sequence;
      const admin = recorded?.admin ?? random.next() < 0.5;
      const telegramUserId = freshTelegramUserId();
      if (admin) {
        await direct.grantAdmin(telegramUserId);
      }
      const person = startConversation(wire.bot, wire.calls, telegramUserId);
      const sequence: Sequence = {
        index: recorded?.index ?? index,
        admin,
        script: [],
      };
      const labelCounts = new Map<string, number>();
      const length = recorded?.script.length ?? stepsPerRun;

      for (let stepIndex = 0; stepIndex < length; stepIndex += 1) {
        const step =
          recorded?.script[stepIndex] ??
          nextStep(random, person, labelCounts, stepIndex);
        if (step.kind === "presses" && !person.pressable().includes(step.label)) {
          sequence.divergedAt = stepIndex;
          break;
        }
        sequence.script.push(step);
        const before = wire.records.length;
        const findings: Finding[] = [];
        try {
          await (step.kind === "says"
            ? person.says(step.text)
            : person.presses(step.label));
        } catch (cause) {
          findings.push({
            oracle: "handle-update-settles",
            strict: true,
            detail: `handleUpdate отклонил промис: ${String(cause)}`,
          });
        }
        const records = wire.records.slice(before);
        findings.push(
          ...checkStep(step, records, String(telegramUserId), seenRequestIds),
        );
        observe(coverage, person, records);
        for (const finding of findings) {
          remember(candidates, finding, sequence, stepIndex);
        }
        if (step.kind === "presses") {
          labelCounts.set(step.label, (labelCounts.get(step.label) ?? 0) + 1);
        }
      }
      sequences.push(sequence);
    }

    const report = summarize(candidates, coverage, sequences);
    mkdirSync(reportDir, { recursive: true });
    const file = join(
      reportDir,
      `${replay === undefined ? "seed" : "replay"}-${seed}.json`,
    );
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    // Мимо console: vitest перехватывает его и у прошедшего теста не печатает,
    // а сводка — и есть результат прогона.
    const shown = relative(repoRoot, file).replaceAll("\\", "/");
    process.stdout.write(`${render(report, shown)}\n`);

    expect(sequences).toHaveLength(planned);
  });
});

// Алфавит действий человека. Кнопки выбираются с весом, обратным числу
// прошлых нажатий: иначе обход крутится у главного экрана и не доходит до форм.
const commands = [
  "/start",
  "/meetups",
  "/archive",
  "/notifications",
  "/help",
  "/nosuchcommand",
  "/start garbage",
  "/start m_AAAAAAAAAAAAAAAAAAAAAA",
  "/start m_",
];

function texts(): string[] {
  const year = new Date().getUTCFullYear();
  return [
    "",
    " ",
    "Настолки в исследовании",
    `12.06.${year + 1} 19:00`,
    "01.01.2000 10:00",
    `31.02.${year + 1} 25:61`,
    "завтра",
    "42",
    "Циферблат",
    "<b>разметка</b> и *звёздочки*",
    "🎲🎲🎲",
    "'; drop table meetups; --",
    "ж".repeat(5_000),
  ];
}

function nextStep(
  random: Random,
  person: Person,
  labelCounts: Map<string, number>,
  stepIndex: number,
): Step {
  if (stepIndex === 0) {
    return { kind: "says", text: "/start" };
  }
  const labels = person.pressable();
  const roll = random.next();
  if (labels.length > 0 && roll < 0.6) {
    return {
      kind: "presses",
      label: weightedLabel(random, labels, labelCounts),
    };
  }
  if (roll < 0.8) {
    return { kind: "says", text: random.pick(texts()) };
  }
  return { kind: "says", text: random.pick(commands) };
}

function weightedLabel(
  random: Random,
  labels: readonly string[],
  labelCounts: Map<string, number>,
): string {
  const weights = labels.map(
    (label) => 1 / (1 + (labelCounts.get(label) ?? 0)),
  );
  let target = random.next() * weights.reduce((sum, weight) => sum + weight, 0);
  for (const [position, label] of labels.entries()) {
    target -= weights[position] ?? 0;
    if (target < 0) return label;
  }
  return random.pick(labels);
}

function observe(
  coverage: Coverage,
  person: Person,
  records: readonly LogRecord[],
): void {
  coverage.steps += 1;
  for (const record of records) {
    const fields = record.fields;
    if (fields.operation === undefined) continue;
    if (fields.use_case !== undefined) coverage.useCases.add(fields.use_case);
    coverage.outcomes.add(
      [fields.operation, fields.result, fields.error_category ?? "-"].join("/"),
    );
  }
  let screen: string;
  try {
    screen = normalizeScreen(person.sees());
  } catch {
    return;
  }
  if (!coverage.screens.has(screen)) {
    coverage.screens.set(screen, coverage.steps);
  }
  for (const label of person.pressable()) coverage.labels.add(label);
}

// Экран без изменчивых частей: даты, номера и токены ссылок делают каждый
// экран «новым», и кривая открытий не вышла бы на плато никогда.
function normalizeScreen(text: string): string {
  return text
    .replace(/[A-Za-z0-9_-]{16,}/g, "*")
    .replace(/\d+/g, "#")
    .slice(0, 80);
}

function remember(
  candidates: Map<string, Candidate>,
  finding: Finding,
  sequence: Sequence,
  step: number,
): void {
  const fields = finding.fields;
  const key = [
    finding.oracle,
    fields?.operation ?? "-",
    fields?.use_case ?? "-",
    fields?.error_category ?? "-",
  ].join(" | ");
  const known = candidates.get(key);
  if (known !== undefined) {
    known.occurrences += 1;
    return;
  }
  candidates.set(key, {
    key,
    oracle: finding.oracle,
    strict: finding.strict,
    detail: finding.detail,
    occurrences: 1,
    first: {
      sequence: sequence.index,
      step,
      admin: sequence.admin,
      script: [...sequence.script],
      ...(fields === undefined ? {} : { fields }),
    },
  });
}

function summarize(
  candidates: Map<string, Candidate>,
  coverage: Coverage,
  sequences: Sequence[],
) {
  const lateStart = Math.floor(coverage.steps * 0.8);
  const lateScreens = [...coverage.screens.values()].filter(
    (firstSeen) => firstSeen > lateStart,
  ).length;
  const sorted = [...candidates.values()].sort(
    (a, b) =>
      Number(b.strict) - Number(a.strict) || b.occurrences - a.occurrences,
  );
  return {
    seed,
    runs: sequences.length,
    stepsPerRun,
    replay:
      replay === undefined ? null : `${replay.file}#${replay.sequence.index}`,
    coverage: {
      steps: coverage.steps,
      useCases: [...coverage.useCases].sort(),
      outcomes: [...coverage.outcomes].sort(),
      distinctScreens: coverage.screens.size,
      newScreensInLastFifth: lateScreens,
      distinctLabels: coverage.labels.size,
    },
    candidates: sorted,
    diverged: sequences
      .filter((sequence) => sequence.divergedAt !== undefined)
      .map((sequence) => ({
        index: sequence.index,
        step: sequence.divergedAt,
      })),
    sequences,
  };
}

function render(report: ReturnType<typeof summarize>, file: string): string {
  const lines = [
    report.replay === null
      ? `seed ${report.seed}: ${report.runs} последовательностей по ${report.stepsPerRun} шагов`
      : `повтор ${report.replay}: шагов ${report.coverage.steps}`,
    // Скрипт опирается на состояние базы: кнопка со сходкой, созданной другой
    // последовательностью прошлого прогона, на свежей топологии не появится.
    // Разошедшийся повтор кандидата не опровергает, а молчание о нём — да.
    ...report.diverged.map(
      (entry) =>
        `РАСХОЖДЕНИЕ: последовательность ${entry.index} остановлена на шаге ${entry.step} — нужной кнопки нет`,
    ),
    `use_case: ${report.coverage.useCases.join(", ") || "ни одного"}`,
    `исходы: ${report.coverage.outcomes.join(", ")}`,
    `экранов ${report.coverage.distinctScreens}, из них новых в последней пятой части шагов ${report.coverage.newScreensInLastFifth}; подписей кнопок ${report.coverage.distinctLabels}`,
    `кандидатов ${report.candidates.length}:`,
    ...report.candidates.map(
      (candidate) =>
        `  [${candidate.strict ? "нарушение" : "наблюдение"}] ${candidate.key} ×${candidate.occurrences}: ${candidate.detail} (повтор: EXPLORE_REPLAY=${file}#${candidate.first.sequence})`,
    ),
    `отчёт: ${file}`,
  ];
  return lines.join("\n");
}

function readNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name}=${raw}: нужно неотрицательное целое`);
  }
  return value;
}

function readReplay(
  raw: string | undefined,
): { file: string; sequence: Sequence } | undefined {
  if (raw === undefined || raw === "") return undefined;
  const hash = raw.lastIndexOf("#");
  if (hash < 0) {
    throw new Error(
      `EXPLORE_REPLAY=${raw}: нужен вид <файл>#<номер последовательности>`,
    );
  }
  const file = resolve(repoRoot, raw.slice(0, hash));
  const index = Number(raw.slice(hash + 1));
  const report = JSON.parse(readFileSync(file, "utf8")) as {
    sequences: Sequence[];
  };
  const sequence = report.sequences.find(
    (candidate) => candidate.index === index,
  );
  if (sequence === undefined) {
    throw new Error(`в ${file} нет последовательности ${index}`);
  }
  return { file, sequence };
}
