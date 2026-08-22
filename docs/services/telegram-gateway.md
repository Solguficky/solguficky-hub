# Telegram Gateway

> **Слой:** Current/Legacy → MVP replacement. **Направление:** новая реализация на TypeScript + grammY принята владельцем; ADR и migration design ещё нужны.

## Ответственность MVP

Gateway является Telegram edge системы:

- принимает разрешённые Telegram updates;
- реализует интерфейс бота и сценарное состояние;
- преобразует Telegram-ввод в application requests;
- маршрутизирует вызовы Identity, Meetups и Notifications boundaries;
- отображает человеку успешный или ошибочный результат;
- потребляет уведомления из шины и доставляет их в Telegram;
- соблюдает privacy, least privilege и ограничения Telegram API.

Gateway не владеет инвариантами Meetups, системными ролями и решениями авторизации.

### Обязательства перед Identity

Из [ADR-026](../decisions/ADR-026-identity-mvp-model-and-access.md) следуют требования, которые ADR Gateway обязан учесть:

- Gateway — доверенная граница authentication: он проверяет secret token вебхука и устанавливает Telegram user id. Дальше authentication material никуда не передаётся;
- на каждом update, требующем продуктового действия, Gateway синхронно вызывает Identity. Кэш фактов доступа и ролей не используется: устаревшее разрешение равносильно пропущенной проверке;
- при недоступности Identity операция завершается fail-closed. Деградации до режима «показываем только чтение» нет;
- `/start` может нести deep link payload двух видов: переход к сходке и одноразовое приглашение. Разбор payload принадлежит Gateway, решение о допуске — Identity;
- административные команды управления составом и ролями Gateway только маршрутизирует. Проверять роль в Gateway нельзя: это решение Identity, иначе доменное правило переезжает в edge.

### Обязательства перед Notifications

[ADR-028](../decisions/ADR-028-notifications-subscriptions-replica-and-delivery-boundary.md) заканчивает ответственность Notifications на публикации уведомления в шину. Всё, что дальше, принадлежит каналу, и в MVP единственный канал — этот шлюз. Из этого следует вторая сторона Gateway, независимая от вебхука:

- **шлюз является потребителем шины.** Он подписывается на уведомления **собственным** durable consumer и получает сообщение с внутренним идентификатором получателя, типом и структурированными данными. Своей команды «отправь это туда» Notifications не присылает. Consumer именно свой: общий на все каналы превратил бы их в конкурентов за одно сообщение;
- **резолвинг получателя принадлежит шлюзу.** Внутренний идентификатор разрешается в Telegram id вызовом Identity. `chat_id` Notifications не знает и знать не должен;
- **текст формирует шлюз.** Из кода типа и данных собираются формулировка, клавиатура, deep link и кнопка отключения категории. Notifications готового текста не присылает именно потому, что всё перечисленное специфично для канала;
- **ненавязчивость реализуется здесь.** Беззвучный режим и системные уведомления настраиваются в самом Telegram и продукту недоступны; единственный механический рычаг — отправить сообщение без звука, и он есть только у шлюза;
- **retry, журнал попыток и выбор между риском дубля и риском потери принадлежат шлюзу.** Он единственный видит ответ Telegram, поэтому окно неопределённости «отправили, но не записали результат» закрывается здесь. Выбор делается один раз для канала, а не для каждого типа уведомления;
- **обратных событий о доставке нет.** Notifications их не ждёт и не потребляет; диагностика «дошло ли» двухшаговая по построению;
- **человек, заблокировавший бота, остаётся получателем.** Notifications продолжит порождать поводы, и обработка этого отказа Telegram — задача шлюза;
- **уведомление может протухнуть.** Если появится срок годности сообщения, решение «доставлять или нет» принимает потребитель, то есть шлюз.

Notifications при этом остаётся для шлюза и обычным синхронным соседом: команды подписки и настроек категорий Gateway маршрутизирует в его gRPC API, предъявляя внутренний идентификатор человека.

## Current: Rust + Teloxide

Текущая реализация ориентирована на аукцион и не является фундаментом MVP:

- использует `MockAuctionService` в production composition root;
- хранит dialogue state и callback idempotency в памяти;
- содержит одновременно JSON- и Protobuf-пути обработки NATS-событий;
- связывает `BotAction` с Teloxide-типами.

Полезные идеи, которые стоит сохранить как опыт:

- handler возвращает действие, а отдельный executor вызывает Telegram API;
- UI builders и сценарная логика могут быть чистыми функциями;
- transport и presentation удобно тестировать раздельно.

## Почему TypeScript + grammY

TypeScript выбран для быстро меняющегося Telegram IO edge и согласуется с будущим Mini App:

- grammY предоставляет актуальную Telegram-экосистему;
- статические типы полезны для callback payload и UI-state;
- можно разделять ограниченный presentation layer с браузерным клиентом;
- единый package/tooling ecosystem уменьшает стоимость итераций.

Rust увеличивает стоимость освоения, async glue, компиляционного цикла и изменений, не раскрывая здесь свои главные преимущества. Go остаётся пригодным языком, но для этого edge-сервиса не даёт достаточного преимущества над TypeScript. Python также пригоден; TypeScript предпочитается из-за общего tooling с Mini App и более строгой проверки UI contracts.

Это решение не запрещает Go, Python или Rust в других задачах.

## Допустимый общий код с Mini App

Можно разделять:

- DTO и схемы валидации UI payload;
- presentation models;
- Telegram-facing identifiers;
- локализуемые тексты и форматирование;
- типы UI-состояния без backend-инвариантов.

Нельзя делать общий TypeScript package источником правды для:

- инвариантов Meetups;
- решений об авторизации;
- переходов доменных состояний;
- прав доступа;
- серверной проверки Telegram `initData`.

Общий язык не устраняет browser transport boundary. Mini App не должен напрямую обращаться к внутреннему gRPC endpoint.

## Что должен решить ADR

- long polling или webhook для первого deployment;
- границу grammY handlers и application use cases;
- persistence диалогового состояния;
- callback retry и idempotency;
- concurrency model;
- Telegram API errors и rate limits;
- устройство второго входа: потребитель шины рядом с обработкой updates, его durable-подписка и место в процессе;
- журнал попыток доставки, retry-политику и хранилище под них;
- рендеринг уведомлений из кода типа и данных: где живут формулировки и как они версионируются вместе со словарём;
- допустимый общий package с Mini App;
- browser/backend transport;
- логирование без утечки персональных данных;
- переключение со старого Rust gateway.

При интеграции с Aspire 13 следует проверять актуальный `AddJavaScriptApp`, а не основывать новый код на устаревшем `AddNpmApp`.

## Gate замены

1. Утвердить первые пользовательские сценарии.
2. Принять ADR Gateway.
3. Реализовать один вертикальный срез с Identity и Meetups.
4. Подтвердить локальный запуск и observability.
5. Явно решить судьбу старых auction callbacks и subscriptions.
6. Удалить Rust-реализацию и её topology только после отсутствия нужных потребителей.

## Свидетельства и ссылки

- Current composition и in-memory dialogue state: `legacy/telegram-gateway/src/lib.rs`
- JSON event path: `legacy/telegram-gateway/src/app/event_listener.rs`
- Protobuf event path: `legacy/telegram-gateway/src/infra/nats_client.rs`
- In-memory callback idempotency: `legacy/telegram-gateway/src/app/idempotency.rs`
- [grammY Getting Started](https://grammy.dev/guide/getting-started)
- [grammY Conversations](https://grammy.dev/plugins/conversations)
- [grammY Runner](https://grammy.dev/plugins/runner)
- [Telegram Bot API](https://core.telegram.org/bots/api)
