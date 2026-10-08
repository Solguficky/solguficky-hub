import type {
  Reporter,
  TestModule,
  TestRunEndReason,
  TestSpecification,
  Vitest,
} from "vitest/node";

// Пропуск не равен прохождению (testing-strategy.md): готового флага у vitest
// нет, поэтому прогон с пропущенным тестом роняет этот reporter. Состояние
// `skipped` покрывает `.skip`, `.todo`, `skipIf`, `ctx.skip()` и тесты,
// отсечённые забытым `.only`. Правило живёт в конфиге, а не в рецепте: CI
// зовёт `npm test` напрямую и обошёл бы проверку в justfile.
//
// vitest выставляет код 1 только на провале и сразу после этого зовёт
// onTestRunEnd, а дальше код не сбрасывает, поэтому выставленный здесь код
// доживает до выхода процесса.
//
// Границы правила:
// - прогон, суженный запускающим (`-t`, `файл:строка`, id теста), не
//   проверяется: отсечённые тесты vitest помечает тем же `skip`, что и
//   `.skip` в коде, и иначе любой отбор по имени падал бы. Рецепты и CI
//   прогон не сужают;
// - упавший прогон не проверяется: код уже 1, а тесты под упавшим хуком
//   vitest тоже помечает пропущенными, и диагноз «пропуск» скрыл бы причину;
// - флаг `--reporter` в командной строке заменяет reporters конфига и
//   снимает правило вместе со штатным выводом.
//
// Копии лежат в apps/hub-bot и apps/community-site-api:
// пакет линтера экрана — тестовый код без зависимостей, а reporter нужен
// конфигу каждого набора.
export class FailOnSkip implements Reporter {
  private vitest: Vitest | undefined;
  private narrowed = false;

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
  }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    this.narrowed =
      this.vitest?.config.testNamePattern !== undefined ||
      specifications.some(
        (spec) =>
          spec.testNamePattern !== undefined ||
          (spec.testLines?.length ?? 0) > 0 ||
          (spec.testIds?.length ?? 0) > 0,
      );
  }

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    _unhandledErrors: unknown,
    reason: TestRunEndReason,
  ): void {
    if (reason !== "passed" || this.narrowed) return;
    const skipped = testModules.flatMap((module) => [
      ...module.children.allTests("skipped"),
    ]);
    if (skipped.length === 0) return;
    const names = skipped.map(
      (test) => `  - ${test.module.moduleId} > ${test.fullName}`,
    );
    process.stderr.write(
      `\nпропущено тестов: ${skipped.length} — пропуск не равен прохождению, прогон считается упавшим\n${names.join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}
