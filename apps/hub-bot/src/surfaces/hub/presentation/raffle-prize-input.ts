import { z } from "zod";
import { parsePrize } from "../application/auction-console.js";
import { fingerprint } from "../application/fingerprint.js";
import { newPrizeLead } from "./screens/auction-raffle-prize-change.js";

// Экран подтверждения смены приза (PER-737) — сообщение самого бота, и новый
// приз «Да» читает из его строки «Станет: …», а не из памяти процесса: так
// подтверждение переживает рестарт, как подтверждение рассылки, а приз до 200
// знаков в 64 байта кнопки не помещается. Кнопка несёт отпечаток текста:
// строка, которая с ним не сходится, призом не станет.
const ConfirmationSchema = z.object({
  from: z.object({ id: z.number().int() }),
  text: z.string(),
});

export function parseConfirmedPrize(
  raw: unknown,
  botId: number,
  print: string,
): string | undefined {
  const parsed = ConfirmationSchema.safeParse(raw);
  if (!parsed.success || parsed.data.from.id !== botId) return undefined;
  const line = parsed.data.text
    .split("\n")
    .findLast((each) => each.startsWith(newPrizeLead));
  if (line === undefined) return undefined;
  const checked = parsePrize(line.slice(newPrizeLead.length));
  return checked.kind === "ok" && fingerprint(checked.prize) === print
    ? checked.prize
    : undefined;
}
