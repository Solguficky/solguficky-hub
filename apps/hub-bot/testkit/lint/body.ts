// Правила тела экрана — клавиатуры без подписей, которую отдаёт общий пакет
// аукциона до оболочки бота. Подписи, заголовок и ряд навигации ставит
// оболочка, поэтому здесь проверяется только то, что держит слой тела
// (дизайн-код, «Аукцион: тело, шлюз, оболочка»): предел `callback_data`,
// ширина ряда и число рядов.

export type BodyButton = {
  /** Действие кнопки: в отказе оно называет кнопку вместо подписи. */
  action: string;
  callbackData: string;
};

export type BodyViolation = {
  rule: "callback-data" | "rows";
  detail: string;
};

export type BodyRules = {
  /** Ряд из двух кнопок, который тело допускает: листание. */
  pair: (row: readonly BodyButton[]) => boolean;
  /** Потолок рядов тела; оболочка добавит к нему свой ряд навигации. */
  maxRows: number;
};

const callbackDataLimit = 64;

export function inspectBody(
  keyboard: readonly (readonly BodyButton[])[],
  rules: BodyRules,
): BodyViolation[] {
  const found: BodyViolation[] = [];
  if (keyboard.length > rules.maxRows) {
    found.push({
      rule: "rows",
      detail: `рядов ${keyboard.length}, потолок ${rules.maxRows}`,
    });
  }
  for (const row of keyboard) {
    if (row.length > 2 || (row.length === 2 && !rules.pair(row))) {
      found.push({
        rule: "rows",
        detail: `ряд ${row.map((button) => button.action).join(" | ")} вне правил тела`,
      });
    }
    for (const button of row) {
      if (Buffer.byteLength(button.callbackData, "utf8") > callbackDataLimit) {
        found.push({
          rule: "callback-data",
          detail: `данные ${button.action} длиннее ${callbackDataLimit} байт`,
        });
      }
    }
  }
  return found;
}
