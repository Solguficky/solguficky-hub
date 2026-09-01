# Примеры к правилам

По одному примеру на правило `SKILL.md`. Форма важнее имён: домен в примерах вымышленный.

## Разбор внешних данных

Схема — единственный источник и проверки, и типа. Строковые форматы Zod между мажорными версиями переезжали, поэтому здесь только стабильное ядро; конкретную версию и место схем фиксирует конфигурация компонента.

```ts
import { z } from "zod";

const InviteSchema = z.object({
  code: z.string().min(1),
  issuedAt: z.string().pipe(z.coerce.date()),
});

type Invite = z.infer<typeof InviteSchema>;

export function readInvite(raw: unknown): Invite | { kind: "malformed" } {
  const parsed = InviteSchema.safeParse(raw);
  return parsed.success ? parsed.data : { kind: "malformed" };
}
```

`safeParse` — потому что мусор на входе от человека ожидаем. `parse` уместен там, где невалидные данные означают дефект соседнего сервиса.

## Композиция схем

```ts
const DraftSchema = InviteSchema.pick({ code: true }).extend({
  title: z.string().min(1),
});
```

## Discriminated union и исчерпывающий разбор

```ts
type ParsedCommand =
  | { kind: "command"; domain: "meetup"; action: string }
  | { kind: "outdated"; version: number }
  | { kind: "malformed" };

function describe(parsed: ParsedCommand): string {
  switch (parsed.kind) {
    case "command":
      return `${parsed.domain}:${parsed.action}`;
    case "outdated":
      return "экран устарел";
    case "malformed":
      return "кнопка не распознана";
    default: {
      const _exhaustive: never = parsed;
      throw new Error(`unhandled variant: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
```

Новый вариант союза ломает сборку в `default`, а не в проде.

## Недопустимое состояние не собирается

```ts
type NonEmpty<T> = [T, ...T[]];

// первый сегмент существует по типу, проверка длины не нужна
function version(segments: NonEmpty<string>): string {
  return segments[0];
}

const PositiveMinutesSchema = z.number().int().positive().brand<"PositiveMinutes">();
type PositiveMinutes = z.infer<typeof PositiveMinutesSchema>;

// длительность попадает сюда только после успешного разбора схемой
type Slot = { start: Date; durationMinutes: PositiveMinutes };
```

Альтернатива — `string[]` плюс `segments[0]!` плюс комментарий «пустым не бывает». Тип дешевле.

## Литеральный union из массива

```ts
const DOMAINS = ["nav", "meetup", "manage", "notify"] as const;
type Domain = (typeof DOMAINS)[number];

function isDomain(value: string): value is Domain {
  return (DOMAINS as readonly string[]).includes(value);
}
```

Расширение `readonly string[]` вместо `as Domain` внутри `includes`: guard не утверждает то, что ещё не проверил.

## Тип выводится из существующего

```ts
type Draft = { id: string; title: string; createdAt: Date };
type CreateDraft = (input: { title: string; commandKey: string }) => Promise<Draft>;

type CreateDraftInput = Parameters<CreateDraft>[0];
type CreatedDraft = Awaited<ReturnType<CreateDraft>>;
type DraftSummary = Pick<Draft, "id" | "title">;
```

Выводить тип из функции, которая сама им объявлена, нельзя: `Draft` и `CreateDraft` замкнутся друг на друга. Источником остаётся один из двух, производные растут от него.

## Branded type

```ts
type PersonId = string & { readonly __brand: "PersonId" };

// единственная точка рождения — после проверки
export function toPersonId(raw: string): PersonId | undefined {
  return raw.length === 36 ? (raw as PersonId) : undefined;
}
```

Бренд стоит заводить, когда `PersonId` и `MeetupId` реально ездят рядом в одной сигнатуре. Один `as` внутри конструктора — цена бренда, и он единственный.

## Порядок сужения

```ts
declare const value: ParsedCommand | Error;

// instanceof отделяет чужой тип, у которого дискриминанта нет
if (value instanceof Error) return failure(value);

// внутри союза работает дискриминант, а не `"version" in value`
switch (value.kind) { /* … */ }
```

`in` остаётся для чужих союзов без дискриминанта — например для Telegram-апдейта, где вид события задан наличием поля. `as` в этой цепочке не появляется: каждый шаг что-то проверил.

## `satisfies` вместо `as`

```ts
const LIMITS = {
  callbackDataBytes: 64,
  answerTimeoutMs: 3_000,
} satisfies Record<string, number>;

// LIMITS.callbackDataBytes остаётся 64, а не расширяется до number
```

## Ожидаемый отказ и неожиданная ошибка

```ts
type PublishResult =
  | { kind: "published"; meetupId: string }
  | { kind: "rejected"; reason: "not-ready" | "forbidden" };

async function publish(id: string): Promise<PublishResult> {
  try {
    return { kind: "published", meetupId: await meetups.publish(id) };
  } catch (cause) {
    throw new Error(`publish ${id} failed`, { cause });
  }
}
```

Отказ, предусмотренный сценарием, — значение. Всё остальное летит наверх с сохранённой причиной, и записывает его та граница, где отказ стал наблюдаемым.

## Объектные аргументы

```ts
// на месте вызова видно, что есть что
createDraft({ organizerId, commandKey, title });

// createDraft(organizerId, commandKey, title) — два соседних string подряд
```
