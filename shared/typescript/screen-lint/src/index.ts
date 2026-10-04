// Вход пакета. Потребители — тестовый код ботов и общего пакета аукциона —
// импортируют этот файл относительным путём: сборки у пакета нет, а прод-код
// его не видит (shared/typescript/screen-lint/AGENTS.md).
export {
  type BodyButton,
  type BodyRules,
  type BodyViolation,
  inspectBody,
} from "./body.js";
export type {
  Catalog,
  MessageClass,
  NavRule,
  RuleName,
  ScreenEntry,
  UnknownEntryKeys,
  WaivableRule,
  Waiver,
} from "./catalog.js";
export {
  inspectCall,
  type LintConfig,
  reportViolations,
  type ScreenViolation,
  takeViolations,
} from "./inspect.js";
