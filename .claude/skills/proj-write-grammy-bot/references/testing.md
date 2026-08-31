# Тесты границы Telegram

Три уровня, три разных инструмента. Test runner компонента выбирается его конфигурацией, поэтому ниже только arrange/act/assert без обёрток конкретного раннера.

## 1. Юзкейс: Telegram нет вообще

Самый ценный тест компонента и одновременно проверка ADR-030: сценарий проходится через диспетчер, и ни одна телеграмовская структура в него не входит.

```ts
const result = await dispatcher.execute({
  identity: organizer,
  intent: "meetup.create",
  parameters: { title: "Сходка" },
  commandKey: "kR7dNq2XmB",
});

assert.equal(result.kind, "created");
```

Если в такой тест приходится втащить `Context`, `Bot` или `Update`, граница не проведена — чинится код, а не тест.

## 2. Parser: вход `unknown`

Parser не знает про grammY и получает строку, а не `Context`. Отсюда его легко накрыть таблицей входов.

```ts
const cases: ReadonlyArray<{ raw: unknown; kind: string }> = [
  { raw: "v1:manage:new:kR7dNq2XmB", kind: "command" },
  { raw: "v9:manage:new", kind: "outdated" },
  { raw: "", kind: "malformed" },
  { raw: null, kind: "malformed" },
  { raw: "v1", kind: "malformed" },
];

for (const { raw, kind } of cases) {
  assert.equal(parseCallbackData(raw).kind, kind);
}
```

`null` и пустая строка в таблице не для красоты: клиент присылает произвольную строку для любого видимого ему сообщения.

## 3. Handler и middleware: synthetic update

`bot.handleUpdate` — публичный вход, которым grammY кормит апдейт в цепочку middleware. Два условия делают тест офлайновым:

- `botInfo` в конструкторе снимает стартовый вызов `getMe`;
- transformer в `bot.api.config.use` перехватывает исходящие вызовы Bot API до `fetch`, записывает их и не зовёт `prev`.

```ts
import { Bot, type Context, type Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";

const botInfo: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "test",
  username: "test_bot",
  can_join_groups: false,
  // компилятор перечислит остальные обязательные поля вашей версии Bot API
};

function makeBot(dispatcher: Dispatcher) {
  const bot = new Bot<Context>("111:test-token", { botInfo });
  const calls: Array<{ method: string; payload: unknown }> = [];

  const recorder: Transformer = (_prev, method, payload) => {
    calls.push({ method, payload });
    // результат зависит от метода, фикстура его не знает:
    // единственное ослабление типа во всём тесте
    return Promise.resolve({ ok: true, result: true as never });
  };

  bot.api.config.use(recorder);
  registerCallbackAdapter(bot, dispatcher);
  return { bot, calls };
}
```

`botInfo` перечисляется целиком намеренно: обновление Bot API добавляет поля, и тогда фикстура ломает сборку, а не молча расходится с рантаймом.

Апдейт собирается фабрикой, а не копипастой JSON из логов: полный апдейт в репозитории — это персональные данные, которые туда не кладут. Фабрика типизируется `Update` без приведения; если приведение потребовалось, фикстура неполна для сценария.

```ts
function callbackQueryUpdate(data: string): Update {
  return {
    update_id: 1,
    callback_query: {
      id: "cbq-1",
      from: { id: 42, is_bot: false, first_name: "tester" },
      chat_instance: "ci-1",
      data,
      message: {
        message_id: 7,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
      },
    },
  };
}

const { bot, calls } = makeBot(dispatcher);
await bot.init();
await bot.handleUpdate(callbackQueryUpdate("v9:manage:new"));

assert.equal(calls[0]?.method, "answerCallbackQuery");
assert.equal(calls[1]?.method, "editMessageText");
assert.deepEqual(intents, []); // к соседям не ходили
```

`bot.init()` вызывается до первого апдейта: он заполняет `bot.botInfo` из переданного объекта, не обращаясь к Telegram.

## Что доказывает каждый уровень

| Уровень | Что ломается, если теста нет |
|---|---|
| юзкейс через диспетчер | `Context` протекает в домен, и это замечают на четвёртом экране |
| parser | процесс падает на строке, которую прислал клиент |
| handler с synthetic update | `answerCallbackQuery` уезжает после похода к соседям, и кнопка «висит» |

Список обязательных угловых случаев — в разделе «Угловые случаи, обязательные в тестах» [брифа компонента](../../../../docs/services/telegram-bot.md).
