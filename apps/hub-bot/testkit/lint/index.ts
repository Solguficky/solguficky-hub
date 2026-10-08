// Вход линтера экрана. Потребители — test kit обеих поверхностей и тесты
// аукционного дерева; прод-код его не видит (testkit/lint/AGENTS.md).
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
